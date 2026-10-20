/**
 * Strict (de)serialization for prepared entries. Uint8Array <-> base64, bigint <-> decimal string,
 * Date <-> epoch ms. Decoders return null for anything that is not exactly the shape we wrote, so a
 * corrupted or tampered Redis value can never turn into a (forged) entry.
 */
import type { PreparedMessage } from '../checkout/ports';
import type { PreparedTransactionRecord } from '../transfers/prepared-transaction.store';

const SCHEMA_VERSION = 1;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const DECIMAL = /^(?:0|[1-9]\d*)$/;

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/** Exact inverse of bytesToBase64, or null when the text is not canonical base64 / is empty. */
export function base64ToBytes(text: unknown): Uint8Array | null {
  if (typeof text !== 'string' || text.length === 0 || !BASE64.test(text)) return null;
  const buf = Buffer.from(text, 'base64');
  if (buf.length === 0 || buf.toString('base64') !== text) return null;
  return new Uint8Array(buf); // copies out of Buffer's pool
}

export function bigintToDecimal(value: bigint): string {
  if (typeof value !== 'bigint' || value < 0n) throw new TypeError('prepared entry bigint fields must be non-negative bigints');
  return value.toString(10);
}

export function decimalToBigint(text: unknown): bigint | null {
  return typeof text === 'string' && DECIMAL.test(text) ? BigInt(text) : null;
}

function parseObject(raw: unknown, kind: string): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  return obj.v === SCHEMA_VERSION && obj.kind === kind ? obj : null;
}

const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const safeInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function requireBytes(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new TypeError('messageBytes must be a non-empty Uint8Array');
}

/* ------------------------------- transfers ------------------------------- */

export function encodeTransactionRecord(record: PreparedTransactionRecord): string {
  requireBytes(record.messageBytes);
  const expiresAtMs = record.expiresAt.getTime();
  if (!Number.isSafeInteger(expiresAtMs)) throw new TypeError('expiresAt must be a valid Date');
  return JSON.stringify({
    v: SCHEMA_VERSION,
    kind: 'tx',
    transactionId: record.transactionId,
    customerId: record.customerId,
    messageBytes: bytesToBase64(record.messageBytes),
    expiresAtMs,
  });
}

export function decodeTransactionRecord(raw: unknown): PreparedTransactionRecord | null {
  const o = parseObject(raw, 'tx');
  if (!o) return null;
  const messageBytes = base64ToBytes(o.messageBytes);
  if (!nonEmptyString(o.transactionId) || !nonEmptyString(o.customerId) || !messageBytes || !safeInt(o.expiresAtMs)) return null;
  return { transactionId: o.transactionId, customerId: o.customerId, messageBytes, expiresAt: new Date(o.expiresAtMs) };
}

/* -------------------------------- checkout -------------------------------- */

export function encodePreparedMessage(entry: PreparedMessage): string {
  requireBytes(entry.messageBytes);
  if (!Number.isSafeInteger(entry.createdAtMs)) throw new TypeError('createdAtMs must be an integer');
  return JSON.stringify({
    v: SCHEMA_VERSION,
    kind: 'msg',
    reference: entry.reference,
    orderId: entry.orderId,
    customerId: entry.customerId,
    payer: entry.payer,
    merchant: entry.merchant,
    mint: entry.mint,
    amountAtomic: bigintToDecimal(entry.amountAtomic),
    referenceKey: entry.referenceKey,
    feeLamports: bigintToDecimal(entry.feeLamports),
    messageBytes: bytesToBase64(entry.messageBytes),
    createdAtMs: entry.createdAtMs,
  });
}

export function decodePreparedMessage(raw: unknown): PreparedMessage | null {
  const o = parseObject(raw, 'msg');
  if (!o) return null;
  const messageBytes = base64ToBytes(o.messageBytes);
  const amountAtomic = decimalToBigint(o.amountAtomic);
  const feeLamports = decimalToBigint(o.feeLamports);
  if (
    !messageBytes || amountAtomic === null || feeLamports === null || !safeInt(o.createdAtMs) ||
    !nonEmptyString(o.reference) || !nonEmptyString(o.orderId) || !nonEmptyString(o.customerId) ||
    !nonEmptyString(o.payer) || !nonEmptyString(o.merchant) || !nonEmptyString(o.mint) || !nonEmptyString(o.referenceKey)
  ) {
    return null;
  }
  return {
    reference: o.reference,
    orderId: o.orderId,
    customerId: o.customerId,
    payer: o.payer,
    merchant: o.merchant,
    mint: o.mint,
    amountAtomic,
    referenceKey: o.referenceKey,
    feeLamports,
    messageBytes,
    createdAtMs: o.createdAtMs,
  };
}
