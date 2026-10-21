import { Logger } from '@nestjs/common';
import type { Customer, Prisma } from '@prisma/client';
import { hashPassword, verifyPassword } from '../admin/auth/credentials';
import type { PrismaService } from '../prisma.service';
import { LOCKOUT_MS, LOCKOUT_THRESHOLD } from './auth.config';

export interface CustomerView { id: string; email: string; name: string | null; emailVerified: boolean; mfaEnabled: boolean }

export const toCustomerView = (row: Pick<Customer, 'id' | 'email' | 'name' | 'emailVerifiedAt' | 'mfaEnabledAt'>): CustomerView => ({
  id: row.id,
  email: row.email,
  name: row.name ?? null,
  emailVerified: row.emailVerifiedAt !== null,
  mfaEnabled: row.mfaEnabledAt !== null,
});

/** Password primitives behind one mutable seam so tests can count scrypt work. Production uses the admin helpers unchanged. */
export interface PasswordCrypto {
  hashPassword: (password: string) => Promise<string>;
  verifyPassword: (password: string, stored: string) => Promise<boolean>;
}
export const defaultPasswordCrypto = (): PasswordCrypto => ({ hashPassword: (password) => hashPassword(password), verifyPassword });

/**
 * Security events go to the Nest Logger only (docs/api/customer-auth.md): event name and customer id, never an email address,
 * a password, a token or a code. No table exists for them and none is invented here.
 */
export function logSecurityEvent(logger: Logger, event: string, customerId: string | null, extra?: Record<string, string | number>): void {
  const detail = extra ? ` ${Object.entries(extra).map(([key, value]) => `${key}=${value}`).join(' ')}` : '';
  logger.log(`security_event=${event} customer=${customerId ?? 'none'}${detail}`);
}

/** Counts one failed credential check toward lockout (5 failures => locked 15 minutes). Never throws. */
export async function recordCredentialFailure(prisma: PrismaService, logger: Logger, customerId: string, now: number): Promise<boolean> {
  try {
    const updated = await prisma.customer.update({ where: { id: customerId }, data: { failedLogins: { increment: 1 } }, select: { failedLogins: true } });
    if (updated.failedLogins >= LOCKOUT_THRESHOLD) {
      await prisma.customer.update({ where: { id: customerId }, data: { lockedUntil: new Date(now + LOCKOUT_MS) } });
      logSecurityEvent(logger, 'account.locked', customerId);
      return true;
    }
  } catch (error) {
    logger.error(`could not record failed credential check: ${(error as Error).name}`);
  }
  return false;
}

export const isLocked = (row: Pick<Customer, 'lockedUntil'> | null | undefined, now: number): boolean => Boolean(row?.lockedUntil && row.lockedUntil.getTime() > now);

/** A no-op write that row-locks one customer until the transaction ends, serialising concurrent writers (token issuing, address writes). */
export const lockCustomer = (tx: Prisma.TransactionClient, customerId: string) =>
  tx.customer.updateMany({ where: { id: customerId }, data: { failedLogins: { increment: 0 } } });
