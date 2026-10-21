import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { CustomerAddress } from '@prisma/client';
import { decryptSeed, encryptSeed, generateTotpSeed, verifyTotp } from '../admin/auth/credentials';
import { PrismaService } from '../prisma.service';
import { CUSTOMER_AUTH_CLOCK, MAX_ADDRESSES, customerOtpauthUri, loadCustomerMfaKey, type AuthClock } from './auth.config';
import { defaultPasswordCrypto, isLocked, lockCustomer, logSecurityEvent, recordCredentialFailure, toCustomerView, type CustomerView, type PasswordCrypto } from './auth.shared';
import { authError, parseAddress, parseCode, parseMfaDisable, parseProfile, type AddressInput } from './auth.validation';

export const MFA_NOT_CONFIGURED = 'MFA is not configured.';

export interface AddressView {
  id: string;
  label: string | null;
  recipient: string;
  line1: string;
  line2: string | null;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  isDefault: boolean;
}

export const toAddressView = (row: CustomerAddress): AddressView => ({
  id: row.id, label: row.label, recipient: row.recipient, line1: row.line1, line2: row.line2, city: row.city, region: row.region, postalCode: row.postalCode, country: row.country, isDefault: row.isDefault,
});

/** Profile, addresses and MFA for the signed-in customer (identity comes from the session; nothing here trusts a body-supplied id). */
@Injectable()
export class AccountService {
  private readonly logger = new Logger('CustomerAccount');
  readonly clock: AuthClock;
  /** Test seam, see AuthService.crypto. */
  crypto: PasswordCrypto = defaultPasswordCrypto();

  constructor(private readonly prisma: PrismaService, @Optional() @Inject(CUSTOMER_AUTH_CLOCK) clock?: AuthClock) {
    this.clock = clock ?? Date.now;
  }

  private async customer(customerId: string) {
    const row = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!row) throw authError(401, 'Authentication required.');
    return row;
  }

  // ---------------------------------------------------------------------------------------------------- profile

  async profile(customerId: string): Promise<CustomerView> {
    return toCustomerView(await this.customer(customerId));
  }

  async updateProfile(customerId: string, input: unknown): Promise<CustomerView> {
    const { name } = parseProfile(input);
    await this.customer(customerId);
    return toCustomerView(await this.prisma.customer.update({ where: { id: customerId }, data: { name } }));
  }

  // -------------------------------------------------------------------------------------------------- addresses

  async listAddresses(customerId: string): Promise<{ items: AddressView[] }> {
    const rows = await this.prisma.customerAddress.findMany({ where: { customerId }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }] });
    return { items: rows.map(toAddressView) };
  }

  async createAddress(customerId: string, input: unknown): Promise<AddressView> {
    const data = parseAddress(input, false) as AddressInput;
    return this.prisma.$transaction(async (tx) => {
      await lockCustomer(tx, customerId);
      const count = await tx.customerAddress.count({ where: { customerId } });
      if (count >= MAX_ADDRESSES) throw authError(409, `You can save at most ${MAX_ADDRESSES} addresses.`);
      const isDefault = count === 0 ? true : data.isDefault === true;
      if (isDefault) await tx.customerAddress.updateMany({ where: { customerId, isDefault: true }, data: { isDefault: false } });
      const row = await tx.customerAddress.create({
        data: { customerId, label: data.label, recipient: data.recipient, line1: data.line1, line2: data.line2, city: data.city, region: data.region, postalCode: data.postalCode, country: data.country, isDefault },
      });
      return toAddressView(row);
    });
  }

  async updateAddress(customerId: string, addressId: string, input: unknown): Promise<AddressView> {
    const data = parseAddress(input, true);
    return this.prisma.$transaction(async (tx) => {
      await lockCustomer(tx, customerId);
      const existing = await tx.customerAddress.findFirst({ where: { id: addressId, customerId } });
      if (!existing) throw authError(404, 'Address not found.');
      const { isDefault, ...fields } = data;
      // The default is moved by naming another address; un-defaulting the only default would leave none, so it is ignored.
      const makeDefault = isDefault === true && !existing.isDefault;
      if (makeDefault) await tx.customerAddress.updateMany({ where: { customerId, isDefault: true }, data: { isDefault: false } });
      const row = await tx.customerAddress.update({ where: { id: existing.id }, data: { ...fields, ...(makeDefault ? { isDefault: true } : {}) } });
      return toAddressView(row);
    });
  }

  async deleteAddress(customerId: string, addressId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockCustomer(tx, customerId);
      const existing = await tx.customerAddress.findFirst({ where: { id: addressId, customerId } });
      if (!existing) throw authError(404, 'Address not found.');
      await tx.customerAddress.delete({ where: { id: existing.id } });
      if (existing.isDefault) {
        const next = await tx.customerAddress.findFirst({ where: { customerId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
        if (next) await tx.customerAddress.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    });
  }

  // -------------------------------------------------------------------------------------------------------- MFA

  async enrollMfa(customerId: string): Promise<{ otpauthUri: string; seedBase32: string }> {
    const key = loadCustomerMfaKey(process.env);
    if (!key) throw authError(503, MFA_NOT_CONFIGURED);
    const customer = await this.customer(customerId);
    if (customer.mfaEnabledAt) throw authError(409, 'MFA is already enabled.');
    const seedBase32 = generateTotpSeed();
    // Stored encrypted but inactive (mfaEnabledAt stays null) until a code from it is confirmed. A new enrolment replaces an unconfirmed one.
    const stored = await this.prisma.customer.updateMany({ where: { id: customerId, mfaEnabledAt: null }, data: { mfaSeedEnc: encryptSeed(seedBase32, key), lastTotpStep: null } });
    if (stored.count !== 1) throw authError(409, 'MFA is already enabled.');
    logSecurityEvent(this.logger, 'mfa.enrol_started', customerId);
    return { otpauthUri: customerOtpauthUri(customer.email, seedBase32), seedBase32 };
  }

  async confirmMfaEnrollment(customerId: string, input: unknown): Promise<void> {
    const code = parseCode((input as { code?: unknown } | null | undefined)?.code);
    const key = loadCustomerMfaKey(process.env);
    if (!key) throw authError(503, MFA_NOT_CONFIGURED);
    const customer = await this.customer(customerId);
    if (customer.mfaEnabledAt) throw authError(409, 'MFA is already enabled.');
    if (!customer.mfaSeedEnc) throw authError(409, 'Start MFA enrolment first.');
    let seed: string;
    try {
      seed = decryptSeed(customer.mfaSeedEnc, key);
    } catch {
      throw authError(409, 'Start MFA enrolment first.');
    }
    const now = this.clock();
    const step = verifyTotp(seed, code, now, customer.lastTotpStep);
    if (step === null) throw authError(400, 'Invalid code.');
    const enabled = await this.prisma.customer.updateMany({
      where: { id: customerId, mfaEnabledAt: null, mfaSeedEnc: customer.mfaSeedEnc, OR: [{ lastTotpStep: null }, { lastTotpStep: { lt: step } }] },
      data: { mfaEnabledAt: new Date(now), lastTotpStep: step },
    });
    if (enabled.count !== 1) throw authError(400, 'Invalid code.');
    logSecurityEvent(this.logger, 'mfa.enabled', customerId);
  }

  /** Needs the password AND a fresh code. Failures share the sign-in lockout counter so a stolen session cannot guess either. */
  async disableMfa(customerId: string, input: unknown): Promise<void> {
    const { password, code } = parseMfaDisable(input);
    const key = loadCustomerMfaKey(process.env);
    if (!key) throw authError(503, MFA_NOT_CONFIGURED);
    const customer = await this.customer(customerId);
    const now = this.clock();
    const refused = () => authError(403, 'Invalid password or code.');

    const passwordOk = await this.crypto.verifyPassword(password, customer.passwordHash ?? '');
    if (isLocked(customer, now)) throw refused();
    if (!customer.mfaEnabledAt || !customer.mfaSeedEnc) throw authError(409, 'MFA is not enabled.');

    let step: number | null = null;
    try {
      step = verifyTotp(decryptSeed(customer.mfaSeedEnc, key), code, now, customer.lastTotpStep);
    } catch {
      this.logger.error(`MFA seed for customer ${customerId} cannot be decrypted`);
    }
    if (!passwordOk || step === null) {
      await recordCredentialFailure(this.prisma, this.logger, customerId, now);
      logSecurityEvent(this.logger, 'mfa.disable_failed', customerId);
      throw refused();
    }
    const consumed = await this.prisma.customer.updateMany({
      where: { id: customerId, mfaEnabledAt: { not: null }, OR: [{ lastTotpStep: null }, { lastTotpStep: { lt: step } }] },
      data: { mfaSeedEnc: null, mfaEnabledAt: null, lastTotpStep: null, failedLogins: 0 },
    });
    if (consumed.count !== 1) throw refused();
    logSecurityEvent(this.logger, 'mfa.disabled', customerId);
  }
}
