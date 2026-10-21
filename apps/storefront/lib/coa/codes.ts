/**
 * Lot-code and hash input rules for the public COA pages (docs/api/coa-contract.md).
 * Pure functions only: this file is imported by the browser bundle, the server components and the node tests.
 */

/** Same pattern as the contract. No ':' so the anchor memo is unambiguous. */
export const LOT_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/;
export const LOT_CODE_MIN = 2;
export const LOT_CODE_MAX = 63;
/** Shown as a format hint only. It is an example of the shape, not a lot we claim exists. */
export const LOT_CODE_EXAMPLE = 'HF-BPC157-2610A';

export type LotCodeCheck = { ok: true; code: string } | { ok: false; reason: string };

/** Trims surrounding whitespace only. Case is preserved: the code is shown and anchored exactly as issued. */
export function checkLotCode(raw: string): LotCodeCheck {
  const code = raw.trim();
  if (code.length === 0) return { ok: false, reason: 'Enter the lot code printed on your label or packing slip.' };
  if (code.length < LOT_CODE_MIN) return { ok: false, reason: `A lot code has at least ${LOT_CODE_MIN} characters.` };
  if (code.length > LOT_CODE_MAX) return { ok: false, reason: `A lot code has at most ${LOT_CODE_MAX} characters.` };
  if (!/^[A-Za-z0-9]/.test(code)) return { ok: false, reason: 'A lot code starts with a letter or a number.' };
  if (!LOT_CODE_PATTERN.test(code)) return { ok: false, reason: 'Use only letters, numbers, dots, hyphens and underscores (no spaces, colons or slashes).' };
  return { ok: true, code };
}

export function isLotCode(value: unknown): value is string {
  return typeof value === 'string' && LOT_CODE_PATTERN.test(value);
}

/** Path of the public record for a code. Always percent-encoded, even though valid codes need no escaping. */
export function lotPath(code: string): string {
  return `/verify/${encodeURIComponent(code)}`;
}

const SHA256_HEX = /^[0-9a-f]{64}$/i;
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}
export function normalizeSha256(value: string): string {
  return value.trim().toLowerCase();
}

/** The route param may arrive percent-decoded or not depending on the Next version; accept either, validate strictly after. */
export function lotCodeFromParam(param: string): string | null {
  let decoded = param;
  try { decoded = decodeURIComponent(param); } catch { return null; }
  const check = checkLotCode(decoded);
  return check.ok && check.code === decoded ? check.code : null;
}
