import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verification of the `Moonpay-Signature-V2` webhook header, built only from MoonPay's documented algorithm
 * (dev.moonpay.com/api-reference/widget/webhooks/signature, fetched 2026-10-21):
 *
 *   header  : `t=<unix timestamp in seconds>,s=<hex hmac>`
 *   message : `<t>` + `.` + the exact raw JSON request body (POST)
 *   hmac    : HMAC-SHA256 keyed with the account's WEBHOOK API key (not the widget URL-signing key), hex encoded
 *
 * The legacy `Moonpay-Signature` header is deliberately not consulted.
 */
export const MOONPAY_SIGNATURE_HEADER = 'moonpay-signature-v2';
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

export type SignatureVerdict =
  /** Header absent, duplicated, or not exactly `t=<digits>,s=<64 hex>`. */
  | { ok: false; reason: 'missing' | 'malformed' }
  /** Well formed but the MAC does not match this key and body. */
  | { ok: false; reason: 'mismatch' }
  /** The MAC is authentic but the timestamp is outside the tolerance window (age in seconds, negative = future). */
  | { ok: false; reason: 'stale'; ageSeconds: number }
  | { ok: true; timestamp: number };

interface ParsedHeader {
  timestamp: string;
  mac: Buffer;
}

const TIMESTAMP = /^\d{1,12}$/;
const HEX_MAC = /^[0-9a-fA-F]{64}$/;

/** Strict parser: exactly one `t` and one `s`, nothing else. Anything unexpected fails closed. */
export function parseSignatureHeader(header: string | string[] | undefined): ParsedHeader | 'missing' | 'malformed' {
  if (header === undefined) return 'missing';
  if (typeof header !== 'string') return 'malformed';
  if (header.length === 0) return 'missing';
  if (header.length > 256) return 'malformed';
  let timestamp: string | undefined;
  let mac: string | undefined;
  for (const element of header.split(',')) {
    const separator = element.indexOf('=');
    if (separator <= 0) return 'malformed';
    const prefix = element.slice(0, separator);
    const value = element.slice(separator + 1);
    if (prefix === 't' && timestamp === undefined) timestamp = value;
    else if (prefix === 's' && mac === undefined) mac = value;
    else return 'malformed';
  }
  if (timestamp === undefined || mac === undefined) return 'malformed';
  if (!TIMESTAMP.test(timestamp) || !HEX_MAC.test(mac)) return 'malformed';
  return { timestamp, mac: Buffer.from(mac, 'hex') };
}

export interface VerifyInput {
  header: string | string[] | undefined;
  /** The exact bytes MoonPay sent. Never a re-serialised object. */
  rawBody: Buffer;
  key: string;
  /** Current time in unix seconds. */
  nowSeconds: number;
  toleranceSeconds: number;
}

/**
 * The MAC is checked BEFORE the timestamp so that "stale" is only ever reported for authentic requests (the caller
 * logs it distinctly; an unauthenticated sender must not be able to write that log line).
 */
export function verifyMoonPaySignature(input: VerifyInput): SignatureVerdict {
  const parsed = parseSignatureHeader(input.header);
  if (parsed === 'missing' || parsed === 'malformed') return { ok: false, reason: parsed };

  const message = Buffer.concat([Buffer.from(`${parsed.timestamp}.`, 'utf8'), input.rawBody]);
  const expected = createHmac('sha256', input.key).update(message).digest();
  // Both buffers are 32 bytes here (the header parser guarantees the length), which timingSafeEqual requires.
  if (parsed.mac.length !== expected.length || !timingSafeEqual(parsed.mac, expected)) return { ok: false, reason: 'mismatch' };

  const timestamp = Number(parsed.timestamp);
  const ageSeconds = input.nowSeconds - timestamp;
  if (Math.abs(ageSeconds) > input.toleranceSeconds) return { ok: false, reason: 'stale', ageSeconds };
  return { ok: true, timestamp };
}
