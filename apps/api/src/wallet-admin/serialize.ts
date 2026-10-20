/**
 * Serialization helpers for the read-only wallet admin API.
 * BigInt values (USDC base units, slots, lamports) are always emitted as decimal
 * strings so they survive JSON and never lose precision as JS numbers.
 */

export type Serialized<T> = T extends bigint
  ? string
  : T extends Date
    ? string
    : T extends Array<infer U>
      ? Array<Serialized<U>>
      : T extends object
        ? { [K in keyof T]: Serialized<T[K]> }
        : T;

export function serialize<T>(value: T): Serialized<T> {
  return walk(value) as Serialized<T>;
}

function walk(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(walk);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) out[key] = walk(inner);
    return out;
  }
  return value;
}

const USDC_DECIMALS = 6;
const BASE = 1_000_000n;

/** Exact decimal USDC string from base units, e.g. 12500000n -> "12.500000". Never uses floats. */
export function formatUsdcExact(atomic: bigint): string {
  const negative = atomic < 0n;
  const abs = negative ? -atomic : atomic;
  const whole = abs / BASE;
  const fraction = (abs % BASE).toString().padStart(USDC_DECIMALS, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

/** Research Credits are a derived display unit: floor(USDC). Never an issued balance. */
export function floorResearchCredits(atomic: bigint): string {
  if (atomic <= 0n) return '0';
  return (atomic / BASE).toString();
}
