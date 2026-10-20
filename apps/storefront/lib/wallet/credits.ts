/**
 * Pure USDC / Research Credits helpers. No floats, no I/O, no React.
 * USDC has 6 decimals; amounts are bigint "atomic" base units.
 *
 * 1 Research Credit = 1 whole USDC of AVAILABLE purchasing value (floor).
 * Credits are a display unit derived from an on-chain balance, never an issued balance.
 */

export const USDC_DECIMALS = 6;
export const USDC_ATOMIC_PER_USDC = 1_000_000n;
export const ATOMIC_PER_CENT = 10_000n;
export const MAX_U64 = 18_446_744_073_709_551_615n;
export const LAMPORTS_PER_SOL = 1_000_000_000n;

const INTEGER_PATTERN = /^-?\d+$/;

/** Strictly convert a decimal-integer string (or bigint) to bigint. Returns null for anything else. */
export function toAtomic(value: string | bigint | null | undefined): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return INTEGER_PATTERN.test(trimmed) ? BigInt(trimmed) : null;
}

/** Exact 6-decimal USDC string, e.g. 12340000n -> "12.340000". Throws RangeError for non-integer strings. */
export function formatUsdc(atomic: string | bigint): string {
  const value = toAtomic(atomic);
  if (value === null) throw new RangeError('USDC amount must be an integer number of base units');
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / USDC_ATOMIC_PER_USDC;
  const fraction = (abs % USDC_ATOMIC_PER_USDC).toString().padStart(USDC_DECIMALS, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

/** Same as formatUsdc but never throws; returns null on malformed input. */
export function tryFormatUsdc(atomic: string | bigint | null | undefined): string | null {
  const value = toAtomic(atomic);
  return value === null ? null : formatUsdc(value);
}

/** Research Credits = floor(whole USDC available). Negative balances clamp to 0. */
export function researchCredits(atomic: string | bigint): bigint {
  const value = toAtomic(atomic);
  if (value === null) throw new RangeError('USDC amount must be an integer number of base units');
  return value > 0n ? value / USDC_ATOMIC_PER_USDC : 0n;
}

/** Group digits of a non-negative integer bigint for display: 12345n -> "12,345". */
export function formatWholeNumber(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString();
  return `${negative ? '-' : ''}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

const USDC_INPUT_PATTERN = /^(\d+)(?:\.(\d{1,6}))?$/;

/**
 * Strict decimal USDC input -> atomic bigint. Accepts "5", "5.5", "0.000001".
 * Rejects signs, exponents, separators, empty fraction ("5."), more than 6 places,
 * and values above the u64 range. Returns null when invalid.
 */
export function parseUsdcInput(input: string): bigint | null {
  const match = USDC_INPUT_PATTERN.exec(input.trim());
  if (!match) return null;
  const atomic = BigInt(match[1]) * USDC_ATOMIC_PER_USDC + BigInt((match[2] ?? '').padEnd(USDC_DECIMALS, '0'));
  return atomic > MAX_U64 ? null : atomic;
}

const USD_INPUT_PATTERN = /^\$?(\d+)(?:\.(\d{1,2}))?$/;

/** Strict decimal USD input -> integer cents (max 2 places). Returns null when invalid or unsafe. */
export function parseUsdToCents(input: string): number | null {
  const match = USD_INPUT_PATTERN.exec(input.trim());
  if (!match) return null;
  const cents = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

/** Integer cents -> exact USDC atomic units (1 cent = 10,000 base units). */
export function centsToAtomic(cents: number): bigint {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError('Cents must be a non-negative safe integer');
  return BigInt(cents) * ATOMIC_PER_CENT;
}

/** Integer cents -> "123.45" without floats. */
export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError('Cents must be a non-negative safe integer');
  const value = BigInt(cents);
  return `${formatWholeNumber(value / 100n)}.${(value % 100n).toString().padStart(2, '0')}`;
}

/** Lamports -> SOL string with up to 9 places, trailing zeros trimmed (min 1 place for non-zero fractions only). */
export function formatSol(lamports: string | bigint): string {
  const value = toAtomic(lamports);
  if (value === null) throw new RangeError('Lamports must be an integer');
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / LAMPORTS_PER_SOL;
  const fraction = (abs % LAMPORTS_PER_SOL).toString().padStart(9, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}${fraction ? `.${fraction}` : ''}`;
}
