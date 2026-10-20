import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { EnvLike, isNonProductionRuntime } from '../config/runtime';

/**
 * Proof of wallet control for POST /v1/wallet.
 *
 * Linking only a PUBLIC address would let anyone claim somebody else's address first. Instead the customer
 * must sign a short-lived, account-bound message with the wallet's own key; the API verifies that signature
 * against the public address. The platform never sees a private key, only a detached ed25519 signature.
 *
 * The challenge is a STATELESS token: base64url(JSON{email,address,exp,nonce}) + '.' + base64url(HMAC-SHA256).
 * Nothing is stored server-side. The message the customer signs is rebuilt from the verified token payload,
 * so a signature can only ever be valid for the exact account, address, nonce and expiry the server issued.
 */

export const LINK_CHALLENGE_ENV = 'WALLET_LINK_CHALLENGE_KEY';
export const LINK_CHALLENGE_MIN_KEY_LENGTH = 32;
export const LINK_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const LINK_MESSAGE_HEADER = 'Helix & Field wallet link';

/** Why a proof was rejected. INTERNAL (audit/tests) only: it must never be returned to the caller. */
export type LinkProofFailure = 'malformed' | 'bad-mac' | 'expired' | 'account-mismatch' | 'address-mismatch' | 'bad-signature';

export interface LinkChallengePayload {
  email: string;
  address: string;
  exp: number;
  nonce: string;
}

export interface IssuedLinkChallenge {
  message: string;
  expiresAt: string;
  challenge: string;
}

let processKey: Buffer | undefined;

/**
 * Key used to authenticate challenge tokens. development/test: the env var if set, else a random per-process key
 * (challenges do not survive a restart, which is fine for a 5 minute token). Any other runtime: the env var is
 * REQUIRED and must be at least 32 characters, otherwise this throws (fail closed at startup).
 */
export function resolveLinkChallengeKey(env: EnvLike = process.env): Buffer {
  const configured = env[LINK_CHALLENGE_ENV];
  if (configured !== undefined && configured.trim() !== '') {
    if (configured.length < LINK_CHALLENGE_MIN_KEY_LENGTH) {
      throw new Error(`${LINK_CHALLENGE_ENV} must be at least ${LINK_CHALLENGE_MIN_KEY_LENGTH} characters`);
    }
    return Buffer.from(configured, 'utf8');
  }
  if (!isNonProductionRuntime(env)) {
    throw new Error(`${LINK_CHALLENGE_ENV} is required (at least ${LINK_CHALLENGE_MIN_KEY_LENGTH} characters) outside development/test`);
  }
  processKey ??= randomBytes(32);
  return processKey;
}

const b64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

function mac(key: Buffer, body: string): Buffer {
  return createHmac('sha256', key).update(body, 'utf8').digest();
}

/** The exact text the customer's wallet signs. */
export function buildLinkMessage(payload: LinkChallengePayload): string {
  return [
    LINK_MESSAGE_HEADER,
    `Account: ${payload.email}`,
    `Address: ${payload.address}`,
    `Nonce: ${payload.nonce}`,
    `Expires: ${new Date(payload.exp).toISOString()}`,
  ].join('\n');
}

export function issueLinkChallenge(key: Buffer, input: { email: string; address: string }, now: number = Date.now()): IssuedLinkChallenge {
  const payload: LinkChallengePayload = {
    email: input.email,
    address: input.address,
    exp: now + LINK_CHALLENGE_TTL_MS,
    nonce: randomBytes(16).toString('base64url'),
  };
  const body = b64url(JSON.stringify(payload));
  return {
    message: buildLinkMessage(payload),
    expiresAt: new Date(payload.exp).toISOString(),
    challenge: `${body}.${b64url(mac(key, body))}`,
  };
}

function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function parsePayload(body: string): LinkChallengePayload | null {
  try {
    const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<LinkChallengePayload> | null;
    if (
      value === null || typeof value !== 'object' ||
      typeof value.email !== 'string' || typeof value.address !== 'string' ||
      typeof value.nonce !== 'string' || typeof value.exp !== 'number' || !Number.isFinite(value.exp)
    ) return null;
    return { email: value.email, address: value.address, exp: value.exp, nonce: value.nonce };
  } catch {
    return null;
  }
}

// DER SubjectPublicKeyInfo prefix for a raw 32-byte ed25519 public key.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Verifies a detached ed25519 signature of `message` against a raw 32-byte public key. Never throws. */
export function verifyEd25519(publicKey: Uint8Array, message: string, signature: Buffer): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const keyObject = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(message, 'utf8'), keyObject, signature);
  } catch {
    return false;
  }
}

const BASE64 = /^[A-Za-z0-9+/]{86}==$/;

/**
 * Checks the whole proof: token MAC (constant time), expiry, account and address binding, then the wallet signature
 * over the message rebuilt from the verified payload. `address` is the already-validated request address and
 * `publicKey` its 32 raw bytes.
 */
export function verifyLinkProof(
  key: Buffer,
  input: { email: string; address: string; publicKey: Uint8Array; challenge: unknown; signature: unknown },
  now: number = Date.now(),
): { ok: true } | { ok: false; reason: LinkProofFailure } {
  const { challenge, signature } = input;
  if (typeof challenge !== 'string' || typeof signature !== 'string' || challenge.length > 2048 || !BASE64.test(signature)) {
    return { ok: false, reason: 'malformed' };
  }
  const parts = challenge.split('.');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return { ok: false, reason: 'malformed' };
  const [body, presentedMac] = parts;
  if (!constantTimeEqual(Buffer.from(presentedMac, 'base64url'), mac(key, body))) return { ok: false, reason: 'bad-mac' };
  const payload = parsePayload(body);
  if (!payload) return { ok: false, reason: 'malformed' };
  if (!(payload.exp > now) || payload.exp - now > LINK_CHALLENGE_TTL_MS) return { ok: false, reason: 'expired' };
  if (payload.email !== input.email) return { ok: false, reason: 'account-mismatch' };
  if (payload.address !== input.address) return { ok: false, reason: 'address-mismatch' };
  const valid = verifyEd25519(input.publicKey, buildLinkMessage(payload), Buffer.from(signature, 'base64'));
  return valid ? { ok: true } : { ok: false, reason: 'bad-signature' };
}
