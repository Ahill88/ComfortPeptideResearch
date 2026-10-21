/**
 * Pure presentation logic: what each record state is called on the page, and which tone it gets.
 * Rule enforced here and by tests: a revoked, superseded or absent record is NEVER given a positive tone.
 */
import type { AnchorKind, AnchorNetwork, ByHashResult, CoaStatus, PublicAnchor, PublicCoa, PublicLotRecord } from './model';

export type Tone = 'positive' | 'neutral' | 'caution' | 'negative';

export type LotBanner = {
  kind: 'current' | 'revoked';
  tone: Tone;
  /** True ONLY for a current, published, not-revoked COA. */
  positive: boolean;
  title: string;
  detail: string;
  /** Revocation reason as recorded (revoked banners only; null otherwise). Shown as its own labelled line. */
  reason: string | null;
  /** The version the page features in detail (the current one, or for a revoked lot the newest revoked one). */
  featured: PublicCoa;
};

export const BANNER_CURRENT_TITLE = 'Current COA';
export const BANNER_REVOKED_TITLE = "This lot's COA has been revoked";

export function featuredVersion(record: PublicLotRecord): PublicCoa {
  if (record.status === 'current' && record.current) return record.current;
  const revoked = record.versions.filter((v) => v.status === 'revoked');
  const pool = revoked.length ? revoked : record.versions;
  return [...pool].sort((a, b) => b.version - a.version)[0];
}

export function lotBanner(record: PublicLotRecord): LotBanner {
  const featured = featuredVersion(record);
  if (record.status === 'current' && record.current && record.current.status === 'published') {
    return {
      kind: 'current', tone: 'positive', positive: true, featured,
      title: BANNER_CURRENT_TITLE, reason: null,
      detail: `Version ${featured.version} is the certificate of analysis we currently publish for lot ${record.lotCode}. It has not been revoked.`,
    };
  }
  const reason = featured.revokeReason ?? 'No reason was recorded.';
  const when = featured.revokedAt ? ` on ${formatDay(featured.revokedAt)}` : '';
  return {
    kind: 'revoked', tone: 'negative', positive: false, featured,
    title: BANNER_REVOKED_TITLE, reason,
    detail: `Version ${featured.version} was revoked${when}. Lot ${record.lotCode} has no current COA. Do not rely on a revoked document.`,
  };
}

export function versionStatus(status: CoaStatus): { label: string; tone: Tone; description: string } {
  switch (status) {
    case 'published': return { label: 'Current', tone: 'positive', description: 'The version currently published for this lot.' };
    case 'superseded': return { label: 'Superseded', tone: 'caution', description: 'Replaced by a newer version of the COA for this lot.' };
    case 'revoked': return { label: 'Revoked', tone: 'negative', description: 'Withdrawn. Kept visible for the record; do not rely on it.' };
  }
}

export function networkBadge(network: AnchorNetwork): { label: string; isTest: boolean; tone: Tone; note: string } {
  if (network === 'solana-devnet') {
    return { label: 'Solana devnet (test network)', isTest: true, tone: 'caution', note: 'Devnet is a test network. A devnet record is for development and testing and must not be mistaken for a production record.' };
  }
  return { label: 'Solana mainnet', isTest: false, tone: 'neutral', note: 'Recorded on the Solana main network.' };
}

export function expectedMemo(kind: AnchorKind, lotCode: string, version: number, sha256: string): string {
  return `helix-coa:v1:${kind}:${lotCode}:${version}:${sha256.toLowerCase()}`;
}
/** Does the memo the API reports equal the memo this record's own fields imply? Shown to the visitor, never assumed. */
export function memoAgreesWithRecord(anchor: PublicAnchor, kind: AnchorKind, lotCode: string, coa: PublicCoa): boolean {
  return anchor.memo === expectedMemo(kind, lotCode, coa.version, coa.file.sha256);
}

export type ByHashSummary = { tone: Tone; headline: string; detail: string };
const STATUS_WORD: Record<CoaStatus, string> = { published: 'the current COA', superseded: 'a superseded (older) COA', revoked: 'a REVOKED COA' };

export function byHashSummary(result: ByHashResult): ByHashSummary {
  if (!result.found) {
    return {
      tone: 'neutral', headline: 'No match: this file is not a COA we published',
      detail: 'Its SHA-256 matches nothing in our public records. It may be a different document, an edited or re-saved copy of a PDF (any change alters the hash), or a file from another source.',
    };
  }
  const rank: Record<CoaStatus, number> = { revoked: 0, superseded: 1, published: 2 };
  // Report the most cautionary status first: a file that is also a revoked version must not be presented as simply "current".
  const worst = [...result.matches].sort((a, b) => rank[a.status] - rank[b.status])[0];
  const where = result.matches.length > 1 ? `${result.matches.length} records` : `lot ${worst.lotCode}, version ${worst.version}`;
  if (worst.status === 'revoked') return { tone: 'negative', headline: 'Match: this is a REVOKED COA', detail: `This file is byte-for-byte the PDF recorded for ${where}, and that record has been revoked. Do not rely on it.` };
  if (worst.status === 'superseded') return { tone: 'caution', headline: 'Match: this is a superseded (older) COA', detail: `This file is byte-for-byte the PDF recorded for ${where}. A newer version has since replaced it.` };
  return { tone: 'positive', headline: 'Match: this is the current COA', detail: `This file is byte-for-byte the PDF recorded for ${where}, unchanged since it was recorded.` };
}
export function byHashStatusWord(status: CoaStatus): string { return STATUS_WORD[status]; }

/* ------------------------------- formatting ------------------------------- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'YYYY-MM-DD' or an ISO instant -> '21 Oct 2026' (UTC, deterministic on server and client). */
export function formatDay(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return value;
  const d = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (value.length > 10 && !Number.isNaN(d.getTime())) return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}`;
}
export function formatInstantUtc(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
export function formatPurity(n: number): string {
  return `${Number.isInteger(n) ? n.toFixed(1) : String(+n.toFixed(2))}%`;
}
