import { BadRequestException, ConflictException, HttpException, Inject, Injectable, Logger, NotFoundException, Optional, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { AdminAuditService } from '../admin-audit.service';
import { hashSessionToken } from '../admin-session.guard';
import { ADMIN_SESSION_ABSOLUTE_MS, ADMIN_SESSION_IDLE_MS, type AdminPrincipal, type AdminRoleName } from '../admin.types';
import { PrismaService } from '../../prisma.service';
import {
  EMAIL_PATTERN, MFA_KEY_ENV, PASSWORD_MAX_LENGTH, createAdminCredentials, decryptSeed, generateSessionToken, generateTotpSeed, hashPassword, loadMfaKey,
  normalizeEmail, passwordPolicyError, verifyPassword, verifyTotp,
} from './credentials';

/** Injection token for the millisecond clock (tests inject a movable one). Defaults to Date.now. */
export const ADMIN_AUTH_CLOCK = 'ADMIN_AUTH_CLOCK';
export type AdminClock = () => number;

export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;
export const USER_AGENT_MAX = 200;
export const AUDIT_DEFAULT_LIMIT = 50;
export const AUDIT_MAX_LIMIT = 200;

export const GENERIC_SIGN_IN_FAILURE = 'Invalid sign-in.';
export const NOT_CONFIGURED_MESSAGE = 'Admin sign-in is not configured.';

export interface RequestContext { ip: string | null; userAgent: string | null }
export interface LoginResult { token: string; expiresAt: string; admin: AdminPrincipal }

const toPrincipal = (row: { id: string; email: string; name: string; role: AdminRoleName }): AdminPrincipal => ({ id: row.id, email: row.email, name: row.name, role: row.role });

/** The one failure for every way a sign-in can go wrong. Body is exactly {message}. */
const signInFailure = () => new HttpException({ message: GENERIC_SIGN_IN_FAILURE }, 401);
const notConfigured = () => new HttpException({ message: NOT_CONFIGURED_MESSAGE }, 503);

interface Dummy { passwordHash: string; seed: string }
let dummyPromise: Promise<Dummy> | undefined;
/** Random per-process stand-ins so an unknown email still pays a full scrypt verification and a TOTP check. No fixed credentials exist. */
function dummyCredentials(): Promise<Dummy> {
  dummyPromise ??= hashPassword(randomBytes(24).toString('base64url')).then((passwordHash) => ({ passwordHash, seed: generateTotpSeed() }));
  return dummyPromise;
}

function parseLogin(input: unknown): { email: string; password: string; totp: string } | null {
  if (typeof input !== 'object' || input === null) return null;
  const { email, password, totp } = input as Record<string, unknown>;
  if (typeof email !== 'string' || typeof password !== 'string' || typeof totp !== 'string') return null;
  const normalized = normalizeEmail(email);
  if (normalized.length > 254 || !EMAIL_PATTERN.test(normalized) || password.length === 0 || password.length > PASSWORD_MAX_LENGTH) return null;
  return { email: normalized, password, totp };
}

@Injectable()
export class AdminAuthService implements OnModuleInit {
  private readonly logger = new Logger('AdminAuth');
  private readonly clock: AdminClock;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    @Optional() @Inject(ADMIN_AUTH_CLOCK) clock?: AdminClock,
  ) {
    this.clock = clock ?? Date.now;
  }

  /** Pay the one-off scrypt cost for the dummy credentials at boot, not on the first unknown-email login. */
  async onModuleInit(): Promise<void> {
    await dummyCredentials();
  }

  // ---------------------------------------------------------------------------------------------------- sign-in

  async login(input: unknown, context: RequestContext): Promise<LoginResult> {
    const key = loadMfaKey(process.env);
    if (!key) throw notConfigured();

    const parsed = parseLogin(input);
    const now = this.clock();
    const admin = parsed ? await this.prisma.adminUser.findUnique({ where: { email: parsed.email } }) : null;
    const dummy = await dummyCredentials();

    // Always one full scrypt verification, whether or not the account exists.
    const passwordOk = await verifyPassword(parsed?.password ?? '', admin?.passwordHash ?? dummy.passwordHash);
    let seed = dummy.seed;
    let seedUnreadable = false;
    if (admin) {
      try {
        seed = decryptSeed(admin.mfaSeedEnc, key);
      } catch {
        seedUnreadable = true;
        this.logger.error(`MFA seed for admin ${admin.id} cannot be decrypted (wrong ${MFA_KEY_ENV} or corrupted record).`);
      }
    }
    const code = parsed?.totp ?? '';
    const step = verifyTotp(seed, code, now, admin?.lastTotpStep ?? null);
    const locked = admin?.lockedUntil != null && admin.lockedUntil.getTime() > now;

    let reason: string | null = null;
    let counts = true;
    if (!admin || !parsed) { reason = 'unknown_account'; counts = false; }
    else if (!admin.active) { reason = 'inactive'; counts = false; }
    else if (locked) { reason = 'locked'; counts = false; }
    else if (!passwordOk) reason = 'bad_password';
    else if (seedUnreadable) reason = 'mfa_unreadable';
    else if (step === null) reason = verifyTotp(seed, code, now, null) !== null ? 'replayed_totp' : 'bad_totp';

    if (!reason && admin && step !== null) {
      // Atomic single-use of the time step: of two concurrent logins with the same code, exactly one wins.
      const consumed = await this.prisma.adminUser.updateMany({
        where: { id: admin.id, OR: [{ lastTotpStep: null }, { lastTotpStep: { lt: step } }] },
        data: { lastTotpStep: step },
      });
      if (consumed.count !== 1) reason = 'replayed_totp';
    }

    if (reason || !admin) {
      await this.recordLoginFailure(admin, reason ?? 'unknown_account', counts, now, context);
      throw signInFailure();
    }

    const token = generateSessionToken();
    const issuedAt = new Date(now);
    const expiresAt = new Date(now + ADMIN_SESSION_ABSOLUTE_MS);
    const session = await this.prisma.adminSession.create({
      data: { adminId: admin.id, tokenHash: hashSessionToken(token), createdAt: issuedAt, lastSeenAt: issuedAt, expiresAt, ip: context.ip, userAgent: context.userAgent?.slice(0, USER_AGENT_MAX) ?? null },
    });
    await this.prisma.adminUser.update({ where: { id: admin.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: issuedAt } });
    await this.audit.record({ adminId: admin.id, action: 'admin.login', targetType: 'admin', targetId: admin.id, detail: { sessionId: session.id }, ip: context.ip });
    return { token, expiresAt: expiresAt.toISOString(), admin: toPrincipal(admin) };
  }

  /** Counts toward lockout only for real, active, currently-unlocked accounts. Never throws: the caller answers 401 regardless. */
  private async recordLoginFailure(admin: { id: string } | null, reason: string, counts: boolean, now: number, context: RequestContext): Promise<void> {
    try {
      let lockedNow = false;
      if (admin && counts) {
        const updated = await this.prisma.adminUser.update({ where: { id: admin.id }, data: { failedLogins: { increment: 1 } }, select: { failedLogins: true } });
        if (updated.failedLogins >= LOCKOUT_THRESHOLD) {
          await this.prisma.adminUser.update({ where: { id: admin.id }, data: { lockedUntil: new Date(now + LOCKOUT_MS) } });
          lockedNow = true;
        }
      }
      await this.audit.record({
        adminId: admin?.id ?? null,
        action: 'admin.login.failed',
        targetType: 'admin',
        targetId: admin?.id ?? null,
        detail: { reason, ...(lockedNow ? { lockedForMinutes: LOCKOUT_MS / 60_000 } : {}) },
        ip: context.ip,
      });
    } catch (error) {
      this.logger.error(`Could not record failed sign-in (${reason}): ${(error as Error).message}`);
    }
  }

  // ---------------------------------------------------------------------------------------------------- session

  async me(admin: AdminPrincipal, sessionId: string) {
    const session = await this.prisma.adminSession.findUnique({ where: { id: sessionId } });
    if (!session || session.adminId !== admin.id) throw new HttpException({ message: 'Admin sign-in required.' }, 401);
    return { admin, session: { expiresAt: session.expiresAt.toISOString(), idleTimeoutSeconds: ADMIN_SESSION_IDLE_MS / 1000 } };
  }

  async logout(admin: AdminPrincipal, sessionId: string, context: RequestContext): Promise<void> {
    await this.prisma.adminSession.updateMany({ where: { id: sessionId, adminId: admin.id, revokedAt: null }, data: { revokedAt: new Date(this.clock()) } });
    await this.audit.record({ adminId: admin.id, action: 'admin.logout', targetType: 'admin', targetId: admin.id, detail: { sessionId }, ip: context.ip });
  }

  async changePassword(admin: AdminPrincipal, sessionId: string, input: { currentPassword?: unknown; newPassword?: unknown }, context: RequestContext): Promise<void> {
    const { currentPassword, newPassword } = input;
    if (typeof currentPassword !== 'string' || currentPassword.length === 0 || currentPassword.length > PASSWORD_MAX_LENGTH) throw new BadRequestException('Current password is required.');
    const policy = passwordPolicyError(newPassword);
    if (policy) throw new BadRequestException(policy);
    if (newPassword === currentPassword) throw new BadRequestException('The new password must differ from the current password.');

    const now = this.clock();
    const row = await this.prisma.adminUser.findUnique({ where: { id: admin.id } });
    const dummy = await dummyCredentials();
    const ok = await verifyPassword(currentPassword, row?.passwordHash ?? dummy.passwordHash);
    const locked = row?.lockedUntil != null && row.lockedUntil.getTime() > now;
    if (!row || !row.active || locked || !ok) {
      // A stolen session must not be able to guess the current password without limit: failures share the sign-in lockout counter.
      if (row && row.active && !locked) {
        const updated = await this.prisma.adminUser.update({ where: { id: row.id }, data: { failedLogins: { increment: 1 } }, select: { failedLogins: true } });
        if (updated.failedLogins >= LOCKOUT_THRESHOLD) await this.prisma.adminUser.update({ where: { id: row.id }, data: { lockedUntil: new Date(now + LOCKOUT_MS) } });
      }
      await this.audit.record({ adminId: admin.id, action: 'admin.password.change.failed', targetType: 'admin', targetId: admin.id, detail: { reason: locked ? 'locked' : 'bad_current_password' }, ip: context.ip });
      throw new HttpException({ message: 'Current password is incorrect.' }, 403);
    }

    const passwordHash = await hashPassword(newPassword as string);
    await this.prisma.adminUser.update({ where: { id: admin.id }, data: { passwordHash, failedLogins: 0, lockedUntil: null } });
    const revoked = await this.prisma.adminSession.updateMany({ where: { adminId: admin.id, revokedAt: null, id: { not: sessionId } }, data: { revokedAt: new Date(now) } });
    await this.audit.record({ adminId: admin.id, action: 'admin.password.change', targetType: 'admin', targetId: admin.id, detail: { otherSessionsRevoked: revoked.count }, ip: context.ip });
  }

  // ---------------------------------------------------------------------------------------------- user management

  async listUsers() {
    const rows = await this.prisma.adminUser.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return {
      items: rows.map((row) => ({ id: row.id, email: row.email, name: row.name, role: row.role, active: row.active, lastLoginAt: row.lastLoginAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString() })),
    };
  }

  /**
   * Creates an admin with a server-generated password and MFA seed, both returned ONCE. There is no forced-change flag in the
   * schema: the owner must tell the new admin to change the password at first sign-in (POST /v1/admin/auth/change-password).
   */
  async createUser(actor: AdminPrincipal, input: { email?: unknown; name?: unknown; role?: unknown }, context: RequestContext) {
    const key = loadMfaKey(process.env);
    if (!key) throw notConfigured();
    if (typeof input.email !== 'string' || !EMAIL_PATTERN.test(normalizeEmail(input.email)) || normalizeEmail(input.email).length > 254) throw new BadRequestException('A valid email is required.');
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    // eslint-disable-next-line no-control-regex
    if (name.length < 1 || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) throw new BadRequestException('Name must be 1 to 100 characters.');
    if (input.role !== 'OWNER' && input.role !== 'STAFF') throw new BadRequestException('Role must be OWNER or STAFF.');
    const email = normalizeEmail(input.email);

    const credentials = await createAdminCredentials(email, key);
    let created;
    try {
      created = await this.prisma.adminUser.create({ data: { email, name, role: input.role, passwordHash: credentials.passwordHash, mfaSeedEnc: credentials.mfaSeedEnc } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('An admin with this email already exists.');
      throw error;
    }
    await this.audit.record({ adminId: actor.id, action: 'admin.user.create', targetType: 'admin', targetId: created.id, detail: { role: created.role }, ip: context.ip });
    return { admin: toPrincipal(created), temporaryPassword: credentials.password, mfa: { otpauthUri: credentials.otpauthUri, seedBase32: credentials.seedBase32 } };
  }

  async deactivateUser(actor: AdminPrincipal, targetId: string, context: RequestContext): Promise<void> {
    if (targetId === actor.id) throw new BadRequestException('You cannot deactivate your own account.');
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.prisma.$transaction(
          async (tx) => {
            const target = await tx.adminUser.findUnique({ where: { id: targetId } });
            if (!target) throw new NotFoundException('Admin not found.');
            if (target.role === 'OWNER' && target.active) {
              const others = await tx.adminUser.count({ where: { role: 'OWNER', active: true, id: { not: targetId } } });
              if (others === 0) throw new ConflictException('The last active OWNER cannot be deactivated.');
            }
            await tx.adminUser.update({ where: { id: targetId }, data: { active: false } });
            await tx.adminSession.updateMany({ where: { adminId: targetId, revokedAt: null }, data: { revokedAt: new Date(this.clock()) } });
          },
          // Serializable: two owners deactivating each other concurrently cannot both pass the last-OWNER check.
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        break;
      } catch (error) {
        const conflict = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
        if (conflict && attempt < 4) continue;
        throw error;
      }
    }
    await this.audit.record({ adminId: actor.id, action: 'admin.user.deactivate', targetType: 'admin', targetId, ip: context.ip });
  }

  // ---------------------------------------------------------------------------------------------------- audit log

  async listAudit(query: { limit?: unknown; cursor?: unknown; targetType?: unknown; targetId?: unknown }) {
    let limit = AUDIT_DEFAULT_LIMIT;
    if (query.limit !== undefined && query.limit !== '') {
      limit = typeof query.limit === 'string' && /^\d{1,4}$/.test(query.limit) ? Number(query.limit) : NaN;
      if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_MAX_LIMIT) throw new BadRequestException(`limit must be an integer from 1 to ${AUDIT_MAX_LIMIT}.`);
    }
    const text = (value: unknown, name: string): string | undefined => {
      if (value === undefined || value === '') return undefined;
      if (typeof value !== 'string' || value.length > 128) throw new BadRequestException(`${name} is invalid.`);
      return value;
    };
    const cursor = text(query.cursor, 'cursor');
    const targetType = text(query.targetType, 'targetType');
    const targetId = text(query.targetId, 'targetId');

    const rows = await this.prisma.adminAuditEvent.findMany({
      where: { ...(targetType ? { targetType } : {}), ...(targetId ? { targetId } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { admin: { select: { email: true } } },
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => ({
        id: row.id,
        adminEmail: row.admin?.email ?? null,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        detail: row.detail ?? null,
        ip: row.ip,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  }
}
