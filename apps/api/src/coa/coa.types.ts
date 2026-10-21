/** Shared COA types (see docs/api/coa-contract.md, the fixed contract). */
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const COA_MEMO_PREFIX = 'helix-coa:v1';
export const LOT_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/;
export type CoaAnchorKindName = 'PUBLISH' | 'REVOKE';

/** `helix-coa:v1:<kind>:<lotCode>:<version>:<sha256hex>` (kind lower-case). The ONLY format ever written on chain. */
export function buildCoaMemo(kind: CoaAnchorKindName, lotCode: string, version: number, sha256Hex: string): string {
  if (!LOT_CODE_PATTERN.test(lotCode)) throw new Error('lot code is not anchorable');
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('version must be a positive integer');
  if (!/^[0-9a-f]{64}$/.test(sha256Hex)) throw new Error('sha256 must be 64 lower-case hex characters');
  return `${COA_MEMO_PREFIX}:${kind.toLowerCase()}:${lotCode}:${version}:${sha256Hex}`;
}

/**
 * Port the COA core calls after a publish/revoke commits. Implementations MUST be idempotent per (coaId, kind), MUST NOT throw to the
 * caller (anchoring is fail-soft: a COA is published whether or not anchoring works) and persist their result in CoaAnchor.
 */
export const COA_ANCHOR_PORT = Symbol('COA_ANCHOR_PORT');
export interface CoaAnchorPort {
  requestAnchor(input: { coaId: string; kind: CoaAnchorKindName }): Promise<void>;
}
