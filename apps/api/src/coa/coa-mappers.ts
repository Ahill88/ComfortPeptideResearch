import { type CoaAnchorNetwork, isCoaAnchorNetwork } from './coa-anchor-info';

/* ---------------------------------------------------------------------------------------------------------------------------------
 * Response shapes: docs/api/coa-contract.md (FIXED CONTRACT). Field names here are the contract's.
 * ------------------------------------------------------------------------------------------------------------------------------- */

export type AdminCoaStatus = 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED' | 'REVOKED';
export type AdminAnchorStatus = 'PENDING' | 'CONFIRMED' | 'FAILED';

export interface PublicAnchor {
  network: CoaAnchorNetwork;
  txSignature: string;
  slot: number | null;
  blockTime: string | null;
  memo: string;
  explorerUrl: string;
}
export interface PublicCoa {
  version: number;
  status: 'published' | 'superseded' | 'revoked';
  lab: { name: string; reportId: string };
  testedAt: string;
  method: string;
  purityPercent: number;
  notes: string | null;
  file: { name: string; sizeBytes: number; sha256: string; url: string };
  publishedAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  anchors: { publish: PublicAnchor | null; revoke: PublicAnchor | null };
}
export interface PublicLotRecord {
  lotCode: string;
  product: { slug: string; name: string } | null;
  status: 'current' | 'revoked';
  current: PublicCoa | null;
  versions: PublicCoa[];
}

export interface AdminAnchor {
  status: AdminAnchorStatus;
  network: string;
  txSignature: string | null;
  slot: number | null;
  blockTime: string | null;
  attempts: number;
  error: string | null;
  memo: string;
  explorerUrl: string | null;
}
export interface AdminCoa {
  id: string;
  lotId: string;
  version: number;
  status: AdminCoaStatus;
  labName: string;
  labReportId: string;
  testedAt: string;
  method: string;
  purityPercent: number;
  notes: string | null;
  file: { name: string; sizeBytes: number; sha256: string };
  createdBy: { name: string } | null;
  createdAt: string;
  publishedBy: { name: string } | null;
  publishedAt: string | null;
  revokedBy: { name: string } | null;
  revokedAt: string | null;
  revokeReason: string | null;
  anchors: { publish: AdminAnchor | null; revoke: AdminAnchor | null };
}
export interface AdminLotSummary {
  id: string;
  code: string;
  productId: string;
  productName: string;
  productSku: string;
  releasedAt: string;
  currentCoaVersion: number | null;
  coaStatus: 'none' | 'draft' | 'published' | 'revoked';
  anchorStatus: 'none' | 'pending' | 'confirmed' | 'failed';
}

/* ------------------------------------------------------------------------------------------------------------------------------- */

interface Decimalish {
  toNumber(): number;
}
export interface AnchorRow {
  kind: 'PUBLISH' | 'REVOKE';
  status?: AdminAnchorStatus;
  network: string;
  txSignature: string | null;
  slot: bigint | number | null;
  blockTime: Date | null;
  memo: string;
  attempts?: number;
  error?: string | null;
}
export interface CoaRow {
  id: string;
  lotId: string;
  version: number;
  status: AdminCoaStatus;
  labName: string;
  labReportId: string;
  testedAt: Date;
  method: string;
  purityPercent: Decimalish | number | string;
  notes: string | null;
  fileName: string;
  fileSize: number;
  fileSha256: string;
  createdByAdminId: string | null;
  createdAt: Date;
  publishedByAdminId: string | null;
  publishedAt: Date | null;
  revokedByAdminId: string | null;
  revokedAt: Date | null;
  revokeReason: string | null;
  anchors: AnchorRow[];
}

export const toIsoDate = (value: Date): string => value.toISOString().slice(0, 10);
export const toNumber = (value: Decimalish | number | string): number => (typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : value.toNumber());
const slotNumber = (slot: bigint | number | null): number | null => (slot === null || slot === undefined ? null : Number(slot));

/** Solana Explorer link. devnet carries the cluster query; mainnet is the default cluster. Unknown network => no link. */
export function explorerUrl(network: string, txSignature: string | null): string | null {
  if (!txSignature || !/^[1-9A-HJ-NP-Za-km-z]{20,128}$/.test(txSignature)) return null;
  if (network === 'solana-devnet') return `https://explorer.solana.com/tx/${txSignature}?cluster=devnet`;
  if (network === 'solana-mainnet') return `https://explorer.solana.com/tx/${txSignature}`;
  return null;
}

const MAX_ERROR_LENGTH = 500;

export function toAdminAnchor(row: AnchorRow | undefined): AdminAnchor | null {
  if (!row) return null;
  return {
    status: row.status ?? 'PENDING',
    network: row.network,
    txSignature: row.txSignature ?? null,
    slot: slotNumber(row.slot),
    blockTime: row.blockTime ? row.blockTime.toISOString() : null,
    attempts: row.attempts ?? 0,
    error: row.error ? row.error.slice(0, MAX_ERROR_LENGTH) : null,
    memo: row.memo,
    explorerUrl: explorerUrl(row.network, row.txSignature ?? null),
  };
}

export function toAdminCoa(row: CoaRow, adminNames: ReadonlyMap<string, string>): AdminCoa {
  const named = (id: string | null) => (id ? { name: adminNames.get(id) ?? 'Unknown admin' } : null);
  return {
    id: row.id,
    lotId: row.lotId,
    version: row.version,
    status: row.status,
    labName: row.labName,
    labReportId: row.labReportId,
    testedAt: toIsoDate(row.testedAt),
    method: row.method,
    purityPercent: toNumber(row.purityPercent),
    notes: row.notes ?? null,
    file: { name: row.fileName, sizeBytes: row.fileSize, sha256: row.fileSha256 },
    createdBy: named(row.createdByAdminId),
    createdAt: row.createdAt.toISOString(),
    publishedBy: named(row.publishedByAdminId),
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    revokedBy: named(row.revokedByAdminId),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    revokeReason: row.revokeReason ?? null,
    anchors: {
      publish: toAdminAnchor(row.anchors.find((anchor) => anchor.kind === 'PUBLISH')),
      revoke: toAdminAnchor(row.anchors.find((anchor) => anchor.kind === 'REVOKE')),
    },
  };
}

/** Public anchor: only a CONFIRMED row with a signature, a known network and a link; anything else is simply absent. */
export function toPublicAnchor(row: AnchorRow | undefined): PublicAnchor | null {
  if (!row || row.status !== 'CONFIRMED' || !row.txSignature || !isCoaAnchorNetwork(row.network)) return null;
  const url = explorerUrl(row.network, row.txSignature);
  if (!url) return null;
  return {
    network: row.network,
    txSignature: row.txSignature,
    slot: slotNumber(row.slot),
    blockTime: row.blockTime ? row.blockTime.toISOString() : null,
    memo: row.memo,
    explorerUrl: url,
  };
}

export const publicPdfPath = (lotCode: string, version: number): string => `/v1/public/lots/${lotCode}/coa/${version}.pdf`;

export function toPublicCoa(lotCode: string, row: CoaRow): PublicCoa {
  return {
    version: row.version,
    status: row.status === 'PUBLISHED' ? 'published' : row.status === 'SUPERSEDED' ? 'superseded' : 'revoked',
    lab: { name: row.labName, reportId: row.labReportId },
    testedAt: toIsoDate(row.testedAt),
    method: row.method,
    purityPercent: toNumber(row.purityPercent),
    notes: row.notes ?? null,
    file: { name: row.fileName, sizeBytes: row.fileSize, sha256: row.fileSha256, url: publicPdfPath(lotCode, row.version) },
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    revokeReason: row.revokeReason ?? null,
    anchors: {
      publish: toPublicAnchor(row.anchors.find((anchor) => anchor.kind === 'PUBLISH')),
      revoke: toPublicAnchor(row.anchors.find((anchor) => anchor.kind === 'REVOKE')),
    },
  };
}

/**
 * Admin lot summary. "Relevant" coa = the PUBLISHED one if any, else the newest DRAFT/REVOKED (SUPERSEDED rows are history).
 * currentCoaVersion / coaStatus / anchorStatus all describe that one coa; anchorStatus is its PUBLISH anchor.
 */
export function toLotSummary(lot: {
  id: string;
  code: string;
  productId: string;
  releasedAt: Date;
  product: { name: string; sku: string };
  coas: Array<{ version: number; status: AdminCoaStatus; anchors: Array<{ kind: 'PUBLISH' | 'REVOKE'; status: AdminAnchorStatus }> }>;
}): AdminLotSummary {
  const published = lot.coas.find((coa) => coa.status === 'PUBLISHED');
  const newestOther = [...lot.coas].filter((coa) => coa.status === 'DRAFT' || coa.status === 'REVOKED').sort((a, b) => b.version - a.version)[0];
  const relevant = published ?? newestOther;
  const publishAnchor = relevant?.anchors.find((anchor) => anchor.kind === 'PUBLISH');
  return {
    id: lot.id,
    code: lot.code,
    productId: lot.productId,
    productName: lot.product.name,
    productSku: lot.product.sku,
    releasedAt: lot.releasedAt.toISOString(),
    currentCoaVersion: relevant ? relevant.version : null,
    coaStatus: !relevant ? 'none' : relevant.status === 'PUBLISHED' ? 'published' : relevant.status === 'DRAFT' ? 'draft' : 'revoked',
    anchorStatus: !publishAnchor ? 'none' : (publishAnchor.status.toLowerCase() as AdminLotSummary['anchorStatus']),
  };
}
