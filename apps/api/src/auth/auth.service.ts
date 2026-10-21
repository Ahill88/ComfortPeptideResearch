import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { decryptSeed, verifyTotp } from '../admin/auth/credentials';
import { EMAIL_PORT, type EmailPort } from '../email/email.types';
import { PrismaService } from '../prisma.service';
import {
  CUSTOMER_AUTH_CLOCK, CUSTOMER_MFA_KEY_ENV, RESET_TOKEN_TTL_MS, VERIFY_TOKEN_TTL_MS, loadCustomerMfaKey, sha256Hex, storefrontBaseUrl, type AuthClock,
} from './auth.config';
import { authError, INVALID_LINK, parseLogin, parseRegister, parseResetConfirm, parseResetRequest, parseToken } from './auth.validation';
import {
  defaultPasswordCrypto, isLocked, lockCustomer, logSecurityEvent, recordCredentialFailure, toCustomerView, type CustomerView, type PasswordCrypto,
} from './auth.shared';
import { CustomerSessionService, type SessionRequestContext } from './customer-session.service';

export const GENERIC_SIGN_IN_FAILURE = 'Invalid sign-in.';
export const REGISTER_ACCEPTED = { message: 'Check your email to verify your account.' } as const;
export const RESET_ACCEPTED = { message: 'If an account exists for that email, a reset link is on its way.' } as const;
export const EMAIL_NOT_CONFIGURED = 'Account email is not configured.';

const signInFailure = () => authError(401, GENERIC_SIGN_IN_FAILURE);

/**
 * A registration's chosen password cannot live on the Customer row until the mailbox is proven (an order may already have
 * created that row, and nobody who has not confirmed the address may attach credentials to it). The schema has no payload column
 * on CustomerToken, so the pending credential is parked in a CustomerToken row that can never validate as a token (it is created
 * already "used", its hash column holds `pending:<verification token row id>:<password hash>:<name>`). Confirming the
 * verification token moves it onto the Customer row and deletes every such row.
 */
const PENDING_PREFIX = 'pending:';
const pendingMarker = (tokenId: string, passwordHash: string, name: string | null): string =>
  `${PENDING_PREFIX}${tokenId}:${passwordHash}:${name ? Buffer.from(name, 'utf8').toString('base64url') : ''}`;
function readPendingMarker(value: string): { passwordHash: string; name: string | null } | null {
  const parts = value.split(':');
  if (parts.length !== 4 || parts[0] !== 'pending') return null;
  return { passwordHash: parts[2], name: parts[3] ? Buffer.from(parts[3], 'base64url').toString('utf8') : null };
}

export interface LoginContext extends SessionRequestContext { previousToken: string | null }
export interface LoginResult { customer: CustomerView; token: string }

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger('CustomerAuth');
  private dummy: Promise<string> | undefined;
  readonly clock: AuthClock;
  /** Test seam: replaced by a counting wrapper in unit tests to prove scrypt work is done for unknown emails. */
  crypto: PasswordCrypto = defaultPasswordCrypto();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: CustomerSessionService,
    @Optional() @Inject(EMAIL_PORT) private readonly email?: EmailPort,
    @Optional() @Inject(CUSTOMER_AUTH_CLOCK) clock?: AuthClock,
  ) {
    this.clock = clock ?? Date.now;
  }

  /** Pays the one-off scrypt cost of the stand-in credential at boot rather than on the first unknown-email login. */
  async onModuleInit(): Promise<void> {
    await this.dummyHash();
  }

  /** A random per-process password hash: unknown emails still pay one full scrypt verification. No fixed credential exists. */
  private dummyHash(): Promise<string> {
    this.dummy ??= this.crypto.hashPassword(randomBytes(24).toString('base64url'));
    return this.dummy;
  }

  // ------------------------------------------------------------------------------------------------------ email

  private async sendEmail(template: 'email_verification' | 'password_reset', to: string, data: Record<string, unknown>, dedupeKey: string): Promise<void> {
    if (!this.email) {
      this.logger.warn(`email port is not bound: ${template} was not sent`);
      return;
    }
    try {
      await this.email.enqueue({ to, template, data, dedupeKey });
    } catch (error) {
      // The caller's response must not depend on delivery (that would reveal whether the address is known).
      this.logger.error(`could not enqueue ${template}: ${(error as Error).name}`);
    }
  }

  /** Invalidates every older unused token of this purpose and issues a new one. Returns the raw token (only its SHA-256 is stored). */
  private async issueToken(tx: Prisma.TransactionClient, customerId: string, purpose: 'EMAIL_VERIFY' | 'PASSWORD_RESET', ttlMs: number, now: number) {
    // Row lock first: two concurrent requests for one customer must not both leave an unused token behind.
    await lockCustomer(tx, customerId);
    await tx.customerToken.updateMany({ where: { customerId, purpose, usedAt: null }, data: { usedAt: new Date(now) } });
    const token = randomBytes(32).toString('base64url');
    const row = await tx.customerToken.create({ data: { customerId, purpose, tokenHash: sha256Hex(token), expiresAt: new Date(now + ttlMs), createdAt: new Date(now) } });
    return { token, row };
  }

  // -------------------------------------------------------------------------------------------------- register

  /** 202 with one fixed body for a new email, an existing email and an email that already has credentials. */
  async register(input: unknown): Promise<typeof REGISTER_ACCEPTED> {
    const { email, password, name } = parseRegister(input);
    const base = storefrontBaseUrl(process.env);
    if (!base) throw authError(503, EMAIL_NOT_CONFIGURED);

    // Always one scrypt hash, so the response time does not depend on whether the address is known.
    const passwordHash = await this.crypto.hashPassword(password);
    const now = this.clock();

    let customer = await this.prisma.customer.findUnique({ where: { email } });
    if (!customer) {
      try {
        customer = await this.prisma.customer.create({ data: { email, createdAt: new Date(now) } });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
        customer = await this.prisma.customer.findUnique({ where: { email } });
      }
    }
    if (!customer || customer.passwordHash) {
      logSecurityEvent(this.logger, 'register.ignored_existing_credentials', customer?.id ?? null);
      return REGISTER_ACCEPTED;
    }

    const { token, row } = await this.prisma.$transaction(async (tx) => {
      // Only the newest registration's credential can ever be applied.
      await lockCustomer(tx, customer!.id);
      await tx.customerToken.deleteMany({ where: { customerId: customer!.id, tokenHash: { startsWith: PENDING_PREFIX } } });
      const issued = await this.issueToken(tx, customer!.id, 'EMAIL_VERIFY', VERIFY_TOKEN_TTL_MS, now);
      await tx.customerToken.create({
        data: { customerId: customer!.id, purpose: 'EMAIL_VERIFY', tokenHash: pendingMarker(issued.row.id, passwordHash, name), expiresAt: new Date(now + VERIFY_TOKEN_TTL_MS), usedAt: new Date(now), createdAt: new Date(now) },
      });
      return issued;
    });
    await this.sendEmail('email_verification', customer.email, { link: `${base}/verify-email?token=${token}`, ...(name ? { name } : {}) }, `email_verification:${row.id}`);
    logSecurityEvent(this.logger, 'register.requested', customer.id);
    return REGISTER_ACCEPTED;
  }

  async confirmEmail(input: unknown): Promise<void> {
    const token = parseToken(input);
    const now = this.clock();
    const customerId = await this.prisma.$transaction(async (tx) => {
      const row = await tx.customerToken.findUnique({ where: { tokenHash: sha256Hex(token) } });
      if (!row || row.purpose !== 'EMAIL_VERIFY') throw authError(400, INVALID_LINK);
      // Single use and expiry in one conditional write: of two concurrent confirmations exactly one wins.
      const consumed = await tx.customerToken.updateMany({ where: { id: row.id, usedAt: null, expiresAt: { gt: new Date(now) } }, data: { usedAt: new Date(now) } });
      if (consumed.count !== 1) throw authError(400, INVALID_LINK);

      const customer = await tx.customer.findUnique({ where: { id: row.customerId } });
      if (!customer) throw authError(400, INVALID_LINK);
      const marker = await tx.customerToken.findFirst({ where: { customerId: customer.id, tokenHash: { startsWith: `${PENDING_PREFIX}${row.id}:` } } });
      const pending = marker ? readPendingMarker(marker.tokenHash) : null;
      if (pending && !customer.passwordHash) {
        // Credentials are attached only now, and only if nobody attached any in the meantime.
        await tx.customer.updateMany({
          where: { id: customer.id, passwordHash: null },
          data: { passwordHash: pending.passwordHash, emailVerifiedAt: customer.emailVerifiedAt ?? new Date(now), ...(pending.name && !customer.name ? { name: pending.name } : {}) },
        });
      } else if (!customer.emailVerifiedAt) {
        await tx.customer.update({ where: { id: customer.id }, data: { emailVerifiedAt: new Date(now) } });
      }
      await tx.customerToken.deleteMany({ where: { customerId: customer.id, tokenHash: { startsWith: PENDING_PREFIX } } });
      return customer.id;
    });
    logSecurityEvent(this.logger, 'email.verified', customerId);
  }

  // ----------------------------------------------------------------------------------------------------- login

  async login(input: unknown, context: LoginContext): Promise<LoginResult> {
    const parsed = parseLogin(input);
    const now = this.clock();
    const customer = parsed ? await this.prisma.customer.findUnique({ where: { email: parsed.email } }) : null;
    const dummy = await this.dummyHash();

    // Always exactly one full scrypt verification, whether or not the account exists or has credentials.
    const passwordOk = await this.crypto.verifyPassword(parsed?.password ?? '', customer?.passwordHash ?? dummy);

    if (!parsed || !customer || !customer.passwordHash) {
      logSecurityEvent(this.logger, 'login.failed', customer?.id ?? null, { reason: 'unknown_account' });
      throw signInFailure();
    }
    if (isLocked(customer, now)) {
      logSecurityEvent(this.logger, 'login.failed', customer.id, { reason: 'locked' });
      throw signInFailure();
    }
    if (!passwordOk) {
      await recordCredentialFailure(this.prisma, this.logger, customer.id, now);
      logSecurityEvent(this.logger, 'login.failed', customer.id, { reason: 'bad_password' });
      throw signInFailure();
    }

    // The password is correct from here on: these answers can be more specific without helping a guesser.
    if (!customer.emailVerifiedAt) {
      logSecurityEvent(this.logger, 'login.refused', customer.id, { reason: 'email_not_verified' });
      throw authError(403, 'Verify your email first.', 'EMAIL_NOT_VERIFIED');
    }
    if (customer.mfaEnabledAt !== null) {
      if (!parsed.totp) throw authError(401, 'Enter your authentication code.', 'MFA_REQUIRED');
      const reason = await this.checkTotp(customer, parsed.totp, now);
      if (reason) {
        if (reason !== 'mfa_unreadable') await recordCredentialFailure(this.prisma, this.logger, customer.id, now);
        logSecurityEvent(this.logger, 'login.failed', customer.id, { reason });
        throw signInFailure();
      }
    }

    if (context.previousToken) await this.sessions.revokeByToken(context.previousToken);
    const session = await this.sessions.create(customer.id, context);
    const updated = await this.prisma.customer.update({ where: { id: customer.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date(now) } });
    logSecurityEvent(this.logger, 'login.succeeded', customer.id);
    return { customer: toCustomerView(updated), token: session.token };
  }

  /** null when the code is valid and its time step was atomically consumed; otherwise the failure reason. */
  private async checkTotp(customer: { id: string; mfaSeedEnc: string | null; lastTotpStep: number | null }, code: string, now: number): Promise<string | null> {
    const key = loadCustomerMfaKey(process.env);
    if (!key || !customer.mfaSeedEnc) {
      this.logger.error(`MFA is enabled for customer ${customer.id} but ${key ? 'no seed is stored' : `${CUSTOMER_MFA_KEY_ENV} is not configured`}`);
      return 'mfa_unreadable';
    }
    let seed: string;
    try {
      seed = decryptSeed(customer.mfaSeedEnc, key);
    } catch {
      this.logger.error(`MFA seed for customer ${customer.id} cannot be decrypted (wrong ${CUSTOMER_MFA_KEY_ENV} or corrupted record)`);
      return 'mfa_unreadable';
    }
    const step = verifyTotp(seed, code, now, customer.lastTotpStep);
    if (step === null) return verifyTotp(seed, code, now, null) !== null ? 'replayed_totp' : 'bad_totp';
    // Atomic single use of the time step: of two concurrent logins with the same code exactly one wins.
    const consumed = await this.prisma.customer.updateMany({ where: { id: customer.id, OR: [{ lastTotpStep: null }, { lastTotpStep: { lt: step } }] }, data: { lastTotpStep: step } });
    return consumed.count === 1 ? null : 'replayed_totp';
  }

  // ----------------------------------------------------------------------------------------------------- session

  async sessionCustomer(customerId: string): Promise<CustomerView> {
    const row = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!row) throw authError(401, 'Authentication required.');
    return toCustomerView(row);
  }

  async logout(token: string | null): Promise<void> {
    if (token) await this.sessions.revokeByToken(token);
  }

  // -------------------------------------------------------------------------------------------- password reset

  /** 202 with one fixed body for known, unknown and credential-less emails. */
  async requestPasswordReset(input: unknown): Promise<typeof RESET_ACCEPTED> {
    const { email } = parseResetRequest(input);
    const base = storefrontBaseUrl(process.env);
    if (!base) throw authError(503, EMAIL_NOT_CONFIGURED);
    const now = this.clock();

    const customer = await this.prisma.customer.findUnique({ where: { email } });
    // No credentials (an order-created row, or no row) behaves exactly like an unknown email: nothing is sent.
    if (!customer || !customer.passwordHash) {
      logSecurityEvent(this.logger, 'password_reset.ignored', customer?.id ?? null);
      return RESET_ACCEPTED;
    }
    const { token, row } = await this.prisma.$transaction((tx) => this.issueToken(tx, customer.id, 'PASSWORD_RESET', RESET_TOKEN_TTL_MS, now));
    await this.sendEmail('password_reset', customer.email, { link: `${base}/reset-password?token=${token}` }, `password_reset:${row.id}`);
    logSecurityEvent(this.logger, 'password_reset.requested', customer.id);
    return RESET_ACCEPTED;
  }

  async confirmPasswordReset(input: unknown): Promise<void> {
    const { token, newPassword } = parseResetConfirm(input);
    const now = this.clock();
    const tokenHash = sha256Hex(token);
    const probe = await this.prisma.customerToken.findUnique({ where: { tokenHash } });
    if (!probe || probe.purpose !== 'PASSWORD_RESET' || probe.usedAt || probe.expiresAt.getTime() <= now) throw authError(400, INVALID_LINK);

    const passwordHash = await this.crypto.hashPassword(newPassword);
    const customerId = await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.customerToken.updateMany({ where: { id: probe.id, usedAt: null, expiresAt: { gt: new Date(now) } }, data: { usedAt: new Date(now) } });
      if (consumed.count !== 1) throw authError(400, INVALID_LINK);
      const customer = await tx.customer.findUnique({ where: { id: probe.customerId } });
      if (!customer || !customer.passwordHash) throw authError(400, INVALID_LINK);
      // The mailbox owner just proved control of the address: that also settles verification, and clears any lockout.
      await tx.customer.update({
        where: { id: customer.id },
        data: { passwordHash, failedLogins: 0, lockedUntil: null, emailVerifiedAt: customer.emailVerifiedAt ?? new Date(now) },
      });
      await tx.customerToken.updateMany({ where: { customerId: customer.id, purpose: 'PASSWORD_RESET', usedAt: null }, data: { usedAt: new Date(now) } });
      await tx.customerSession.updateMany({ where: { customerId: customer.id, revokedAt: null }, data: { revokedAt: new Date(now) } });
      return customer.id;
    });
    logSecurityEvent(this.logger, 'password_reset.completed', customerId);
  }
}
