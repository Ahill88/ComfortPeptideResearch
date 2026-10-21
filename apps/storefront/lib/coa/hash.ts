/**
 * SHA-256 in the visitor's browser (Web Crypto). Files are never uploaded: bytes are read locally and only the hex digest is used.
 * Works in browsers, Node >= 19 and the node test runner (globalThis.crypto).
 */

export class HashUnavailableError extends Error {
  constructor() {
    super('This browser cannot compute SHA-256 here (Web Crypto needs a secure page: https or localhost). Use the command-line steps below instead.');
    this.name = 'HashUnavailableError';
  }
}
export class FileTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`This file is larger than ${Math.round(limitBytes / 1024 / 1024)} MB, which is more than a lab report PDF should be. Use the command-line steps instead.`);
    this.name = 'FileTooLargeError';
  }
}

/** Published COAs are accepted by the API up to 10 MB; anything much larger cannot be one of ours. */
export const MAX_HASH_BYTES = 25 * 1024 * 1024;

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new HashUnavailableError();
  const view = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (view.byteLength > MAX_HASH_BYTES) throw new FileTooLargeError(MAX_HASH_BYTES);
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return bytesToHex(new Uint8Array(await subtle.digest('SHA-256', copy.buffer)));
}

/** Hash a local File/Blob. Rejects before reading when the size alone is too large. */
export async function sha256OfBlob(blob: Blob): Promise<string> {
  if (blob.size > MAX_HASH_BYTES) throw new FileTooLargeError(MAX_HASH_BYTES);
  return sha256Hex(await blob.arrayBuffer());
}

export type HashComparison = 'match' | 'mismatch';
/** Case-insensitive comparison of two hex digests. Anything that is not a clean 64-hex pair is a mismatch, never a match. */
export function compareHashes(computed: string, expected: string): HashComparison {
  const a = computed.trim().toLowerCase();
  const b = expected.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(a) && a === b ? 'match' : 'mismatch';
}
