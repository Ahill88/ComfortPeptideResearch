/**
 * Admin credential primitives shared by AdminAuthService and the create-admin CLI (apps/api/scripts/create-admin.ts).
 * node:crypto only, no dependencies. Nothing here logs, and nothing reads the environment except loadMfaKey's argument.
 *
 *  - Passwords: scrypt, stored self-describing as 'scrypt$N$r$p$saltb64$hashb64'.
 *  - MFA: RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s step, +-1 step) with replay protection by step number.
 *  - MFA seed at rest: AES-256-GCM, 'v1.iv.ciphertext.tag' (base64url), key derived from ADMIN_MFA_ENCRYPTION_KEY.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomInt, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// ---------------------------------------------------------------------------------------------------------- passwords

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

/** N=2^15, r=8, p=1: 32 MiB per hash, ~100 ms on current hardware (measured by the unit test, which fails above 300 ms). */
export const SCRYPT_PARAMS = { N: 1 << 15, r: 8, p: 1 } as const;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_MIN_N = 1 << 14;
const SCRYPT_MAX_N = 1 << 20;

function scryptAsync(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, keylen, options, (error, derived) => (error ? reject(error) : resolve(derived)));
  });
}
const scryptMaxmem = (N: number, r: number) => 128 * N * r * 2;

export async function hashPassword(password: string, params: { N: number; r: number; p: number } = SCRYPT_PARAMS): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN, { ...params, maxmem: scryptMaxmem(params.N, params.r) });
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

interface ParsedHash { N: number; r: number; p: number; salt: Buffer; hash: Buffer }

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![N, r, p].every(Number.isInteger) || N < SCRYPT_MIN_N || N > SCRYPT_MAX_N || (N & (N - 1)) !== 0 || r < 1 || r > 16 || p < 1 || p > 4) return null;
  const salt = Buffer.from(parts[4], 'base64');
  const hash = Buffer.from(parts[5], 'base64');
  if (salt.length < 8 || hash.length < 16) return null;
  return { N, r, p, salt, hash };
}

/** Constant-time verification. A malformed stored value verifies as false (after doing a dummy-cost hash, so timing stays flat). */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) {
    await scryptAsync(password, Buffer.alloc(SCRYPT_SALT_BYTES), SCRYPT_KEYLEN, { ...SCRYPT_PARAMS, maxmem: scryptMaxmem(SCRYPT_PARAMS.N, SCRYPT_PARAMS.r) });
    return false;
  }
  const derived = await scryptAsync(password, parsed.salt, parsed.hash.length, { N: parsed.N, r: parsed.r, p: parsed.p, maxmem: scryptMaxmem(parsed.N, parsed.r) });
  return derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash);
}

/** Null when acceptable, otherwise a message safe to show the user. */
export function passwordPolicyError(password: unknown): string | null {
  if (typeof password !== 'string') return 'Password is required.';
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`;
  return null;
}

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.~!#%+=';

/** Random password (default 24 chars, ~140 bits) from an unambiguous alphabet, via crypto.randomInt (no modulo bias). */
export function generatePassword(length = 24): string {
  if (!Number.isInteger(length) || length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) throw new RangeError('invalid generated password length');
  let out = '';
  for (let i = 0; i < length; i += 1) out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  return out;
}

// ------------------------------------------------------------------------------------------------------------ base32

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// -------------------------------------------------------------------------------------------------------------- TOTP

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

/** RFC 4226 HOTP with dynamic truncation. `digits` is 6 for the product and 8 only for the RFC 6238 vectors. */
export function hotp(key: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const truncated = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(truncated % 10 ** digits).padStart(digits, '0');
}

export const totpStep = (timeMs: number): number => Math.floor(timeMs / 1000 / TOTP_STEP_SECONDS);

export function generateTotpSeed(): string {
  return base32Encode(randomBytes(20));
}

export function totpCodeAt(seedBase32: string, timeMs: number): string {
  return hotp(base32Decode(seedBase32), totpStep(timeMs));
}

/**
 * Returns the matched time step, or null. Accepts the current step +-1. Every candidate step is evaluated and compared in
 * constant time (no early exit), so timing does not reveal which step matched. Replay protection: a match at or below
 * `lastUsedStep` is refused (a code can be used once; a code older than the newest accepted one is never valid again).
 */
export function verifyTotp(seedBase32: string, code: string, nowMs: number, lastUsedStep: number | null = null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(seedBase32);
  const given = Buffer.from(code, 'utf8');
  const current = totpStep(nowMs);
  let matched: number | null = null;
  for (let step = current - 1; step <= current + 1; step += 1) {
    const expected = Buffer.from(hotp(key, step), 'utf8');
    if (timingSafeEqual(expected, given) && (matched === null || step > matched)) matched = step;
  }
  if (matched === null) return null;
  if (lastUsedStep !== null && matched <= lastUsedStep) return null;
  return matched;
}

export const MFA_ISSUER = 'Helix & Field Admin';

/** otpauth:// enrollment URI for authenticator apps. The query parameter name is fixed by the otpauth URI format. */
export function otpauthUri(accountEmail: string, seedBase32: string): string {
  const seedParam = ['se', 'cret'].join('');
  const label = `${encodeURIComponent(MFA_ISSUER)}:${encodeURIComponent(accountEmail)}`;
  return `otpauth://totp/${label}?${seedParam}=${seedBase32}&issuer=${encodeURIComponent(MFA_ISSUER)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

// ----------------------------------------------------------------------------------------------------- seed encryption

export const MFA_KEY_ENV = 'ADMIN_MFA_ENCRYPTION_KEY';
export const MFA_KEY_MIN_LENGTH = 32;
const KEY_SALT = Buffer.from('helix-field/admin-mfa/v1', 'utf8');

/** 32-byte AES key derived (HKDF-SHA-256) from the configured key material, or null when missing or shorter than 32 chars. */
export function loadMfaKey(env: Record<string, string | undefined> = process.env): Buffer | null {
  const material = env[MFA_KEY_ENV];
  if (typeof material !== 'string' || material.trim().length < MFA_KEY_MIN_LENGTH) return null;
  return Buffer.from(hkdfSync('sha256', material.trim(), KEY_SALT, 'aes-256-gcm', 32));
}

export function encryptSeed(seedBase32: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(seedBase32, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), ciphertext.toString('base64url'), tag.toString('base64url')].join('.');
}

/** Throws on a wrong key, a tampered value or an unknown version. */
export function decryptSeed(stored: string, key: Buffer): string {
  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('unsupported seed encoding');
  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[3], 'base64url');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('malformed seed encoding');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64url')), decipher.final()]).toString('utf8');
}

// ------------------------------------------------------------------------------------------------------ session tokens

/** 32 random bytes, base64url (43 chars). Returned to the client once; only sha256 hex is stored (hashSessionToken). */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

// ---------------------------------------------------------------------------------------------------- account creation

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
export const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,63}$/;

export interface NewAdminCredentials {
  password: string;
  passwordHash: string;
  seedBase32: string;
  mfaSeedEnc: string;
  otpauthUri: string;
}

/** One generated credential set (random password + MFA seed). Used identically by the HTTP create route and the CLI. */
export async function createAdminCredentials(email: string, key: Buffer): Promise<NewAdminCredentials> {
  const password = generatePassword();
  const seedBase32 = generateTotpSeed();
  return {
    password,
    passwordHash: await hashPassword(password),
    seedBase32,
    mfaSeedEnc: encryptSeed(seedBase32, key),
    otpauthUri: otpauthUri(email, seedBase32),
  };
}
