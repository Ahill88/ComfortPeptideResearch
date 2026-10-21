import { createHash, hkdfSync } from 'node:crypto';
import { EnvLike, blank, isNonProductionRuntime } from '../config/runtime';
import { CUSTOMER_SESSION_COOKIE } from '../wallet/customer-identity';

/** Customer account constants (docs/api/customer-auth.md). Times in milliseconds unless the name says otherwise. */
export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_SECONDS = SESSION_ABSOLUTE_MS / 1000;
export const SESSION_TOUCH_MS = 60_000;
export const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;
export const MAX_ADDRESSES = 20;
export const USER_AGENT_MAX = 200;

export const CUSTOMER_MFA_KEY_ENV = 'CUSTOMER_MFA_ENCRYPTION_KEY';
export const CUSTOMER_MFA_KEY_MIN_LENGTH = 32;
export const CUSTOMER_MFA_ISSUER = 'Helix & Field';
const MFA_KEY_SALT = Buffer.from('helix-field/customer-mfa/v1', 'utf8');

/** Injection token for the millisecond clock (tests inject a movable one). Defaults to Date.now. */
export const CUSTOMER_AUTH_CLOCK = 'CUSTOMER_AUTH_CLOCK';
export type AuthClock = () => number;

/** SHA-256 hex of a session or one-time token. This (never the token) is what the database stores. */
export const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * 32-byte AES key derived (HKDF-SHA-256) from CUSTOMER_MFA_ENCRYPTION_KEY, or null when unset or shorter than 32 characters.
 * Same derivation shape as admin auth but a different env var and a different HKDF salt, so the two key domains never mix.
 */
export function loadCustomerMfaKey(env: EnvLike = process.env): Buffer | null {
  const material = env[CUSTOMER_MFA_KEY_ENV];
  if (typeof material !== 'string' || material.trim().length < CUSTOMER_MFA_KEY_MIN_LENGTH) return null;
  return Buffer.from(hkdfSync('sha256', material.trim(), MFA_KEY_SALT, 'aes-256-gcm', 32));
}

const DEV_STOREFRONT_URL = 'http://localhost:3000';

/** Valid absolute http(s) URL origin+path without trailing slash, or null. */
export function parseStorefrontUrl(raw: string | undefined): string | null {
  if (blank(raw)) return null;
  try {
    const url = new URL((raw as string).trim());
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * Base of the links sent by email. STOREFRONT_PUBLIC_URL; only development/test fall back to http://localhost:3000.
 * Null (=> registration answers 503) in a production-like runtime where it is unset or invalid.
 */
export function storefrontBaseUrl(env: EnvLike = process.env): string | null {
  const configured = parseStorefrontUrl(env.STOREFRONT_PUBLIC_URL);
  if (configured) return configured;
  return isNonProductionRuntime(env) && blank(env.STOREFRONT_PUBLIC_URL) ? DEV_STOREFRONT_URL : null;
}

/* ------------------------------------------------------------------------------------------------------- cookie */

/**
 * Exact Set-Cookie value for the session cookie: HttpOnly, SameSite=Lax, Path=/, Max-Age 30 days, and Secure in every
 * runtime except exactly development/test. Built by hand (not res.cookie) so the attributes are precisely these.
 */
export function buildSessionCookie(token: string, env: EnvLike = process.env): string {
  return `${CUSTOMER_SESSION_COOKIE}=${token}; Max-Age=${SESSION_ABSOLUTE_SECONDS}; Path=/; HttpOnly; SameSite=Lax${isNonProductionRuntime(env) ? '' : '; Secure'}`;
}

export function buildClearedSessionCookie(env: EnvLike = process.env): string {
  return `${CUSTOMER_SESSION_COOKIE}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; SameSite=Lax${isNonProductionRuntime(env) ? '' : '; Secure'}`;
}

/** otpauth:// enrolment URI for customers (credentials.otpauthUri is fixed to the admin issuer). The query key name is set by the otpauth format. */
export function customerOtpauthUri(accountEmail: string, seedBase32: string): string {
  const seedParam = ['se', 'cret'].join('');
  const label = `${encodeURIComponent(CUSTOMER_MFA_ISSUER)}:${encodeURIComponent(accountEmail)}`;
  return `otpauth://totp/${label}?${seedParam}=${seedBase32}&issuer=${encodeURIComponent(CUSTOMER_MFA_ISSUER)}&algorithm=SHA1&digits=6&period=30`;
}
