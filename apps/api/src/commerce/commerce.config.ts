import { EnvLike, blank } from '../config/runtime';

/** PostgreSQL INT4 maximum: every money column on Order is an Int. */
export const INT32_MAX = 2_147_483_647;

/** Injection token for CommerceConfig. */
export const COMMERCE_CONFIG = Symbol('COMMERCE_CONFIG');

export interface CommerceConfig {
  /** Flat shipping charge in cents (SHIPPING_FLAT_CENTS, default 0). */
  shippingFlatCents: number;
  /** Subtotals strictly above this many cents ship free (SHIPPING_FREE_OVER_CENTS). null = shipping is never free. */
  shippingFreeOverCents: number | null;
  /** Flat tax rate in basis points of the subtotal (TAX_RATE_BPS, default 0). A placeholder, NOT a tax engine. */
  taxRateBps: number;
  /** How long an unpaid order holds its stock (ORDER_HOLD_MINUTES, default 60). */
  holdMinutes: number;
  /** Unpaid-order sweep period in ms (ORDER_SWEEP_INTERVAL_MS, default 60000). 0 disables the sweep on this instance. */
  sweepIntervalMs: number;
}

export const MAX_TAX_RATE_BPS = 10_000;
export const MAX_HOLD_MINUTES = 7 * 24 * 60;
export const MAX_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

function readWholeNumber(env: EnvLike, name: string, min: number, max: number): number | null {
  const raw = env[name];
  if (blank(raw)) return null;
  const text = (raw as string).trim();
  // Digits only, at most 10 of them: no sign, no decimals, no exponent, no separators, no hex.
  if (!/^\d{1,10}$/.test(text)) throw new Error(`${name} must be a whole number between ${min} and ${max} (got "${text.slice(0, 40)}")`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number between ${min} and ${max} (got "${text}")`);
  }
  return value;
}

/**
 * Strict parser for the commerce environment. Any malformed or out-of-range value THROWS (the application refuses to
 * boot, like the ONRAMP_* settings) instead of silently falling back: a typo must never quietly change what a customer is
 * charged or how long stock is held.
 */
export function loadCommerceConfig(env: EnvLike = process.env): CommerceConfig {
  return {
    shippingFlatCents: readWholeNumber(env, 'SHIPPING_FLAT_CENTS', 0, INT32_MAX) ?? 0,
    shippingFreeOverCents: readWholeNumber(env, 'SHIPPING_FREE_OVER_CENTS', 0, INT32_MAX),
    taxRateBps: readWholeNumber(env, 'TAX_RATE_BPS', 0, MAX_TAX_RATE_BPS) ?? 0,
    holdMinutes: readWholeNumber(env, 'ORDER_HOLD_MINUTES', 1, MAX_HOLD_MINUTES) ?? 60,
    sweepIntervalMs: readWholeNumber(env, 'ORDER_SWEEP_INTERVAL_MS', 0, MAX_SWEEP_INTERVAL_MS) ?? 60_000,
  };
}
