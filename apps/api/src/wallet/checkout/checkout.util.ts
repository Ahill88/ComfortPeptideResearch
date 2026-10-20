import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Minimal base58 encoder (Bitcoin alphabet); avoids a direct dependency on bs58. */
export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  let out = '';
  while (value > 0n) {
    out = ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  return '1'.repeat(zeros) + out;
}

/** Solana-Pay-style reference account key: the 32-byte sha256 of the payment reference. */
export function referenceKeyFor(reference: string): PublicKey {
  return new PublicKey(createHash('sha256').update(reference, 'utf8').digest());
}

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

export function isValidPublicKey(value: string | undefined | null): value is string {
  if (!value) return false;
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

/** Formats integer cents as a USD display string without floating point. */
export function formatCents(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const frac = String(cents % 100).padStart(2, '0');
  return `${whole}.${frac}`;
}

/** Formats lamports as a SOL display string (9 decimals) without floating point. */
export function formatLamportsAsSol(lamports: bigint): string {
  const whole = lamports / 1_000_000_000n;
  const frac = (lamports % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Simple in-process mutual exclusion keyed by string. Cross-process safety relies on DB uniqueness. */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    this.tails.set(key, next);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === next) this.tails.delete(key);
    }
  }
}
