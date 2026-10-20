export const MONEY_SCALE = 100;
export type CurrencyCode = 'USD' | 'USDC';
export type Money = Readonly<{ amount: bigint; currency: CurrencyCode }>;
export function usd(cents: number): Money { if (!Number.isSafeInteger(cents)) throw new Error('Amounts must use integer minor units'); return { amount: BigInt(cents), currency: 'USD' }; }
