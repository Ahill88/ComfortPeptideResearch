import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { COA_ANCHOR_INFO, type CoaAnchorInfo, type CoaAnchorNetwork, normalizeAnchorInfo } from './coa-anchor-info';
import { type PublicCoa, type PublicLotRecord, toPublicCoa } from './coa-mappers';
import { normalizeSha256 } from './coa-validation';
import { COA_MEMO_PREFIX, LOT_CODE_PATTERN, MEMO_PROGRAM_ID } from './coa.types';

export const PUBLIC_LOT_NOT_FOUND = 'Lot not found.';
export const PUBLIC_COA_NOT_FOUND = 'COA not found.';
/** Statuses that are visible to the public. DRAFT is never exposed anywhere under /public. */
const PUBLIC_STATUSES = ['PUBLISHED', 'SUPERSEDED', 'REVOKED'] as const;
const MAX_HASH_MATCHES = 50;

export interface PublicAnchorInfo {
  network: CoaAnchorNetwork | null;
  publisher: string | null;
  memoProgramId: string;
  memoFormat: string;
  anchoringEnabled: boolean;
}

export interface PublicPdf {
  sha256: string;
  size: number;
  load(): Promise<Buffer>;
}

@Injectable()
export class CoaPublicService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(COA_ANCHOR_INFO) private readonly anchorInfo?: CoaAnchorInfo,
  ) {}

  /** 404 for unknown lots and for lots that only have drafts (or nothing). Selects only public columns; never ids or admin data. */
  async lotRecord(lotCode: string): Promise<PublicLotRecord> {
    if (!LOT_CODE_PATTERN.test(lotCode)) throw new NotFoundException(PUBLIC_LOT_NOT_FOUND);
    const lot = await this.prisma.lot.findUnique({
      where: { code: lotCode },
      select: {
        code: true,
        product: { select: { slug: true, name: true, active: true } },
        coas: {
          where: { status: { in: [...PUBLIC_STATUSES] } },
          orderBy: { version: 'desc' },
          select: {
            id: true,
            lotId: true,
            version: true,
            status: true,
            labName: true,
            labReportId: true,
            testedAt: true,
            method: true,
            purityPercent: true,
            notes: true,
            fileName: true,
            fileSize: true,
            fileSha256: true,
            createdByAdminId: true,
            createdAt: true,
            publishedByAdminId: true,
            publishedAt: true,
            revokedByAdminId: true,
            revokedAt: true,
            revokeReason: true,
            anchors: { where: { status: 'CONFIRMED' }, select: { kind: true, status: true, network: true, txSignature: true, slot: true, blockTime: true, memo: true } },
          },
        },
      },
    });
    if (!lot || lot.coas.length === 0) throw new NotFoundException(PUBLIC_LOT_NOT_FOUND);
    const versions: PublicCoa[] = lot.coas.map((row) => toPublicCoa(lot.code, row));
    const current = versions.find((coa) => coa.status === 'published') ?? null;
    return {
      lotCode: lot.code,
      product: lot.product.active ? { slug: lot.product.slug, name: lot.product.name } : null,
      status: current ? 'current' : 'revoked',
      current,
      versions,
    };
  }

  /** Metadata first (no bytes), so a conditional GET never reads the PDF; the bytes are loaded only when they will be sent. */
  async pdf(lotCode: string, versionParam: string): Promise<PublicPdf> {
    if (!LOT_CODE_PATTERN.test(lotCode) || !/^[1-9]\d{0,8}$/.test(versionParam)) throw new NotFoundException(PUBLIC_COA_NOT_FOUND);
    const coa = await this.prisma.coa.findFirst({
      where: { version: Number(versionParam), status: { in: [...PUBLIC_STATUSES] }, lot: { code: lotCode } },
      select: { id: true, fileSha256: true, fileSize: true },
    });
    if (!coa) throw new NotFoundException(PUBLIC_COA_NOT_FOUND);
    return {
      sha256: coa.fileSha256,
      size: coa.fileSize,
      load: async () => {
        const file = await this.prisma.coaFile.findUnique({ where: { coaId: coa.id }, select: { bytes: true } });
        if (!file) throw new NotFoundException(PUBLIC_COA_NOT_FOUND);
        return Buffer.from(file.bytes);
      },
    };
  }

  async byHash(hash: string): Promise<{ found: boolean; matches: Array<{ lotCode: string; version: number; status: 'published' | 'superseded' | 'revoked' }> }> {
    const sha = normalizeSha256(hash);
    if (!sha) throw new BadRequestException('sha256 must be 64 hexadecimal characters.');
    const rows = await this.prisma.coa.findMany({
      where: { fileSha256: sha, status: { in: [...PUBLIC_STATUSES] } },
      select: { version: true, status: true, lot: { select: { code: true } } },
      orderBy: [{ lot: { code: 'asc' } }, { version: 'desc' }],
      take: MAX_HASH_MATCHES,
    });
    const matches = rows.map((row) => ({
      lotCode: row.lot.code,
      version: row.version,
      status: (row.status === 'PUBLISHED' ? 'published' : row.status === 'SUPERSEDED' ? 'superseded' : 'revoked') as 'published' | 'superseded' | 'revoked',
    }));
    return { found: matches.length > 0, matches };
  }

  info(): PublicAnchorInfo {
    const value = normalizeAnchorInfo(this.anchorInfo);
    return {
      network: value.network,
      publisher: value.publisher,
      memoProgramId: MEMO_PROGRAM_ID,
      memoFormat: `${COA_MEMO_PREFIX}:<kind>:<lotCode>:<version>:<sha256>`,
      anchoringEnabled: value.anchoringEnabled,
    };
  }
}
