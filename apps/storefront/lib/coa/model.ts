/**
 * Types and STRICT runtime validators for the public COA API (docs/api/coa-contract.md, PUBLIC API).
 * Nothing from the network is trusted: every parse function rebuilds a fresh object holding only the contract's fields
 * (unknown/extra fields are dropped, never rendered) and returns null for any shape or value outside the contract.
 * Admin-only fields therefore cannot reach the DOM even if an API bug leaked them.
 */
import { LOT_CODE_PATTERN, isSha256Hex } from './codes';

export type CoaStatus = 'published' | 'superseded' | 'revoked';
export type AnchorNetwork = 'solana-devnet' | 'solana-mainnet';
export type AnchorKind = 'publish' | 'revoke';

export type PublicAnchor = { network: AnchorNetwork; txSignature: string; slot: number | null; blockTime: string | null; memo: string; explorerUrl: string };
export type PublicCoa = {
  version: number; status: CoaStatus; lab: { name: string; reportId: string }; testedAt: string; method: string; purityPercent: number; notes: string | null;
  file: { name: string; sizeBytes: number; sha256: string; url: string };
  publishedAt: string | null; revokedAt: string | null; revokeReason: string | null;
  anchors: { publish: PublicAnchor | null; revoke: PublicAnchor | null };
};
export type PublicLotRecord = { lotCode: string; product: { slug: string; name: string } | null; status: 'current' | 'revoked'; current: PublicCoa | null; versions: PublicCoa[] };
export type ByHashResult = { found: boolean; matches: { lotCode: string; version: number; status: CoaStatus }[] };
export type AnchorInfo = { network: AnchorNetwork | null; publisher: string | null; memoProgramId: string; memoFormat: string; anchoringEnabled: boolean };
export type ProductLotState = { state: 'none' } | { state: 'published'; code: string };

/* ------------------------------ primitives ------------------------------ */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Control characters (except tab/newline in multi-line text) and bidirectional overrides/isolates, which can disguise text. */
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** Plain text only. Over-long values are rejected (not truncated: truncating a lab name would misstate the record). */
export function cleanText(value: unknown, max: number, { required = true }: { required?: boolean } = {}): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(UNSAFE_TEXT, '').trim();
  if (text.length > max) return null;
  if (required && text.length === 0) return null;
  return text;
}

const int = (v: unknown, min: number, max: number): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null);

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
export function isCalendarDay(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DAY.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
export function isIsoInstant(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value));
}
const optionalInstant = (v: unknown): string | null | undefined => (v === null ? null : isIsoInstant(v) ? v : undefined);

export const COA_STATUSES: readonly CoaStatus[] = ['published', 'superseded', 'revoked'];
export const NETWORKS: readonly AnchorNetwork[] = ['solana-devnet', 'solana-mainnet'];

const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const MEMO = /^helix-coa:v1:(publish|revoke):([A-Za-z0-9][A-Za-z0-9._-]{1,62}):(\d{1,7}):([0-9a-f]{64})$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
// Solana public keys are 32 bytes in base58: 32-44 characters.
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isBase58Address(value: unknown): value is string {
  return typeof value === 'string' && BASE58_ADDRESS.test(value);
}

/** https only, no embedded credentials. The URL string itself is passed through to the page unchanged. */
export function isSafeExplorerUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 600 || /[\s\u0000-\u001F]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.hostname.includes('.');
  } catch { return false; }
}

/* ------------------------------- records ------------------------------- */

export function parseAnchor(value: unknown): PublicAnchor | null {
  if (!isObject(value)) return null;
  const { network, txSignature, slot, blockTime, memo, explorerUrl } = value;
  if (!NETWORKS.includes(network as AnchorNetwork)) return null;
  if (typeof txSignature !== 'string' || !BASE58_SIGNATURE.test(txSignature)) return null;
  const slotValue = slot === null ? null : int(slot, 0, Number.MAX_SAFE_INTEGER);
  if (slot !== null && slotValue === null) return null;
  const time = optionalInstant(blockTime);
  if (time === undefined) return null;
  if (typeof memo !== 'string' || !MEMO.test(memo)) return null;
  if (!isSafeExplorerUrl(explorerUrl)) return null;
  return { network: network as AnchorNetwork, txSignature, slot: slotValue, blockTime: time, memo, explorerUrl };
}

function parseOptionalAnchor(value: unknown): PublicAnchor | null | undefined {
  if (value === null || value === undefined) return null;
  return parseAnchor(value) ?? undefined;
}

export function parseCoa(value: unknown, lotCode: string): PublicCoa | null {
  if (!isObject(value)) return null;
  const version = int(value.version, 1, 1_000_000);
  if (version === null || !COA_STATUSES.includes(value.status as CoaStatus)) return null;
  if (!isObject(value.lab) || !isObject(value.file) || !isObject(value.anchors)) return null;
  const labName = cleanText(value.lab.name, 120);
  const reportId = cleanText(value.lab.reportId, 120);
  const method = cleanText(value.method, 120);
  if (labName === null || reportId === null || method === null) return null;
  if (!isCalendarDay(value.testedAt)) return null;
  const purity = value.purityPercent;
  if (typeof purity !== 'number' || !Number.isFinite(purity) || purity < 0 || purity > 100) return null;
  const notes = value.notes === null || value.notes === undefined ? null : cleanText(value.notes, 1000, { required: false });
  if (value.notes !== null && value.notes !== undefined && notes === null) return null;
  const fileName = cleanText(value.file.name, 200);
  const sizeBytes = int(value.file.sizeBytes, 0, 100 * 1024 * 1024);
  const sha256 = value.file.sha256;
  if (fileName === null || sizeBytes === null || !isSha256Hex(sha256)) return null;
  // The PDF URL must be exactly the contract path for THIS lot and version, so the page can never link somewhere else.
  const url = value.file.url;
  if (url !== `/v1/public/lots/${lotCode}/coa/${version}.pdf`) return null;
  const publishedAt = optionalInstant(value.publishedAt);
  const revokedAt = optionalInstant(value.revokedAt);
  if (publishedAt === undefined || revokedAt === undefined) return null;
  const revokeReason = value.revokeReason === null || value.revokeReason === undefined ? null : cleanText(value.revokeReason, 500, { required: false });
  if (value.revokeReason !== null && value.revokeReason !== undefined && revokeReason === null) return null;
  const publish = parseOptionalAnchor(value.anchors.publish);
  const revoke = parseOptionalAnchor(value.anchors.revoke);
  if (publish === undefined || revoke === undefined) return null;
  return {
    version, status: value.status as CoaStatus, lab: { name: labName, reportId }, testedAt: value.testedAt, method, purityPercent: purity, notes: notes === '' ? null : notes,
    file: { name: fileName, sizeBytes, sha256: sha256.toLowerCase(), url },
    publishedAt, revokedAt, revokeReason: revokeReason === '' ? null : revokeReason,
    anchors: { publish, revoke },
  };
}

export function parsePublicLotRecord(value: unknown): PublicLotRecord | null {
  if (!isObject(value)) return null;
  const { lotCode } = value;
  if (typeof lotCode !== 'string' || !LOT_CODE_PATTERN.test(lotCode)) return null;
  if (value.status !== 'current' && value.status !== 'revoked') return null;
  let product: PublicLotRecord['product'] = null;
  if (value.product !== null) {
    if (!isObject(value.product)) return null;
    const name = cleanText(value.product.name, 200);
    if (name === null || typeof value.product.slug !== 'string' || !SLUG.test(value.product.slug)) return null;
    product = { slug: value.product.slug, name };
  }
  if (!Array.isArray(value.versions) || value.versions.length === 0 || value.versions.length > 200) return null;
  const versions: PublicCoa[] = [];
  for (const raw of value.versions) {
    const coa = parseCoa(raw, lotCode);
    if (!coa) return null;
    versions.push(coa);
  }
  if (new Set(versions.map((v) => v.version)).size !== versions.length) return null;
  if (versions.filter((v) => v.status === 'published').length > 1) return null;
  let current: PublicCoa | null = null;
  if (value.current !== null) {
    current = parseCoa(value.current, lotCode);
    if (!current) return null;
  }
  // The lot status must agree with the data it summarises: a "current" lot has a published COA, a "revoked" lot has none.
  if (value.status === 'current') {
    if (!current || current.status !== 'published') return null;
    if (versions.some((v) => v.status === 'published' && v.version !== current!.version)) return null;
  } else {
    if (current !== null || versions.some((v) => v.status === 'published')) return null;
  }
  return { lotCode, product, status: value.status, current, versions };
}

export function parseByHashResult(value: unknown): ByHashResult | null {
  if (!isObject(value) || typeof value.found !== 'boolean' || !Array.isArray(value.matches) || value.matches.length > 200) return null;
  const matches: ByHashResult['matches'] = [];
  for (const raw of value.matches) {
    if (!isObject(raw) || typeof raw.lotCode !== 'string' || !LOT_CODE_PATTERN.test(raw.lotCode)) return null;
    const version = int(raw.version, 1, 1_000_000);
    if (version === null || !COA_STATUSES.includes(raw.status as CoaStatus)) return null;
    matches.push({ lotCode: raw.lotCode, version, status: raw.status as CoaStatus });
  }
  if (value.found !== matches.length > 0) return null;
  return { found: value.found, matches };
}

export function parseAnchorInfo(value: unknown): AnchorInfo | null {
  if (!isObject(value)) return null;
  const network = value.network;
  if (network !== null && !NETWORKS.includes(network as AnchorNetwork)) return null;
  const publisher = value.publisher;
  if (publisher !== null && !isBase58Address(publisher)) return null;
  if (!isBase58Address(value.memoProgramId)) return null;
  const memoFormat = cleanText(value.memoFormat, 200);
  if (memoFormat === null || typeof value.anchoringEnabled !== 'boolean') return null;
  return { network: network as AnchorNetwork | null, publisher: publisher as string | null, memoProgramId: value.memoProgramId, memoFormat, anchoringEnabled: value.anchoringEnabled };
}

/**
 * Reads ONLY lots[0].code and lots[0].coaPublished from the existing product endpoint.
 * 'published' only when coaPublished is exactly true AND the code is a valid COA lot code we can link to.
 * Anything malformed returns null (caller shows "unavailable", never an implied COA).
 */
export function parseProductLot(value: unknown): ProductLotState | null {
  if (!isObject(value) || !Array.isArray(value.lots)) return null;
  if (value.lots.length === 0) return { state: 'none' };
  const lot = value.lots[0];
  if (!isObject(lot) || typeof lot.coaPublished !== 'boolean') return null;
  if (!lot.coaPublished) return { state: 'none' };
  if (typeof lot.code !== 'string' || !LOT_CODE_PATTERN.test(lot.code)) return null;
  return { state: 'published', code: lot.code };
}
