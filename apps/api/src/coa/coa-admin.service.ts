import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { timingSafeEqual } from 'node:crypto';
import { AdminAuditService } from '../admin/admin-audit.service';
import type { AdminPrincipal } from '../admin/admin.types';
import { PrismaService } from '../prisma.service';
import { AnchorService, CoaAnchorRefusedError } from './anchor/anchor.service';
import { requestAnchorSafely } from './coa-anchor-call';
import { DEFAULT_LOT_LIMIT, MAX_LOT_LIMIT, SEARCH_MAX } from './coa-admin.dto';
import { type AdminCoa, type AdminLotSummary, toAdminCoa, toLotSummary } from './coa-mappers';
import { isPublishedCoaRequired } from './coa-requirement';
import {
  MAX_DRAFTS_PER_LOT,
  REVOKE_REASON_MAX,
  type UploadedPdfFile,
  assertPdf,
  normalizeSha256,
  parseCoaFields,
  sanitizeFileName,
  sha256Hex,
} from './coa-validation';
import { COA_ANCHOR_PORT, type CoaAnchorKindName, type CoaAnchorPort, LOT_CODE_PATTERN } from './coa.types';

/** Placeholder lot values: identical to prisma/seed.ts conventions (no analytical data: purity 0.00, coaKey PENDING-NO-COA). */
export const PLACEHOLDER_COA_KEY = 'PENDING-NO-COA';
export const PLACEHOLDER_PURITY = '0.00';

export const PRODUCT_NO_PUBLISHED_COA_MESSAGE = 'Product has no lot with a published COA.';
const UPLOAD_ATTEMPTS = 4;
/** Interactive transactions wait on a per-lot row lock; allow a burst of uploads to queue without tripping Prisma's 5 s default. */
const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

export interface AdminActor {
  id: string;
  role: AdminPrincipal['role'];
  ip: string | null;
}

export interface AdminProductItem {
  id: string;
  sku: string;
  slug: string;
  name: string;
  active: boolean;
  priceCents: number;
  inventory: number;
  lotCount: number;
  publishedCoaLotCount: number;
}

const isUniqueViolation = (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'P2002';

/** Prisma passes `contains` to LIKE unescaped; PostgreSQL's default LIKE escape is a backslash. */
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, '\\$&');

const LOT_SUMMARY_SELECT = {
  id: true,
  code: true,
  productId: true,
  releasedAt: true,
  product: { select: { name: true, sku: true } },
  coas: { select: { version: true, status: true, anchors: { where: { kind: 'PUBLISH' as const }, select: { kind: true, status: true } } } },
} satisfies Prisma.LotSelect;

export function encodeLotCursor(code: string): string {
  return Buffer.from(JSON.stringify({ c: code }), 'utf8').toString('base64url');
}
export function decodeLotCursor(cursor: string): string {
  const invalid = () => new BadRequestException('Invalid cursor.');
  if (typeof cursor !== 'string' || cursor.length > 300 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { c?: unknown };
    // eslint-disable-next-line no-control-regex
    if (typeof parsed.c !== 'string' || parsed.c.length < 1 || parsed.c.length > 200 || /[\u0000-\u001f]/.test(parsed.c)) throw invalid();
    return parsed.c;
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw invalid();
  }
}

@Injectable()
export class CoaAdminService {
  private readonly logger = new Logger(CoaAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    @Optional() @Inject(COA_ANCHOR_PORT) private readonly anchorPort?: CoaAnchorPort,
    // The real anchor engine: its retry() re-attempts FAILED/stuck anchors (the port's requestAnchor is a no-op for those).
    @Optional() private readonly anchors?: AnchorService,
  ) {}

  /* ------------------------------------------------------------------------------------------------------------- catalog */

  async listProducts(): Promise<{ items: AdminProductItem[] }> {
    const rows = await this.prisma.product.findMany({
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        sku: true,
        slug: true,
        name: true,
        active: true,
        priceCents: true,
        inventory: true,
        lots: { select: { id: true, coas: { where: { status: 'PUBLISHED' }, select: { id: true }, take: 1 } } },
      },
    });
    return { items: rows.map((row) => this.productItem(row)) };
  }

  private productItem(row: { id: string; sku: string; slug: string; name: string; active: boolean; priceCents: number; inventory: number; lots: Array<{ coas: unknown[] }> }): AdminProductItem {
    return {
      id: row.id,
      sku: row.sku,
      slug: row.slug,
      name: row.name,
      active: row.active,
      priceCents: row.priceCents,
      inventory: row.inventory,
      lotCount: row.lots.length,
      publishedCoaLotCount: row.lots.filter((lot) => lot.coas.length > 0).length,
    };
  }

  private async productById(id: string) {
    const row = await this.prisma.product.findUnique({
      where: { id },
      select: {
        id: true,
        sku: true,
        slug: true,
        name: true,
        active: true,
        priceCents: true,
        inventory: true,
        lots: { select: { id: true, coas: { where: { status: 'PUBLISHED' }, select: { id: true }, take: 1 } } },
      },
    });
    if (!row) throw new NotFoundException('Product not found.');
    return row;
  }

  /** OWNER. active=true. With REQUIRE_PUBLISHED_COA=true the product needs at least one lot with a PUBLISHED COA. */
  async publishProduct(id: string, actor: AdminActor): Promise<AdminProductItem> {
    const product = await this.productById(id);
    if (isPublishedCoaRequired() && !product.lots.some((lot) => lot.coas.length > 0)) throw new ConflictException(PRODUCT_NO_PUBLISHED_COA_MESSAGE);
    await this.prisma.product.update({ where: { id }, data: { active: true } });
    await this.record(actor, 'product.publish', 'product', id, { slug: product.slug, wasActive: product.active });
    return this.productItem({ ...(await this.productById(id)) });
  }

  async unpublishProduct(id: string, actor: AdminActor): Promise<AdminProductItem> {
    const product = await this.productById(id);
    await this.prisma.product.update({ where: { id }, data: { active: false } });
    await this.record(actor, 'product.unpublish', 'product', id, { slug: product.slug, wasActive: product.active });
    return this.productItem({ ...(await this.productById(id)) });
  }

  /* --------------------------------------------------------------------------------------------------------------- lots */

  async listLots(query: { productId?: string; q?: string; limit?: number; cursor?: string }): Promise<{ items: AdminLotSummary[]; nextCursor: string | null }> {
    const limit = query.limit ?? DEFAULT_LOT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LOT_LIMIT) throw new BadRequestException(`limit must be between 1 and ${MAX_LOT_LIMIT}.`);
    const q = (query.q ?? '').trim();
    if (q.length > SEARCH_MAX) throw new BadRequestException(`q must be at most ${SEARCH_MAX} characters.`);
    const and: Prisma.LotWhereInput[] = [];
    if (query.productId) and.push({ productId: query.productId });
    if (q) {
      const like = escapeLike(q);
      and.push({
        OR: [
          { code: { contains: like, mode: 'insensitive' } },
          { product: { name: { contains: like, mode: 'insensitive' } } },
          { product: { sku: { contains: like, mode: 'insensitive' } } },
        ],
      });
    }
    if (query.cursor) and.push({ code: { gt: decodeLotCursor(query.cursor) } });
    const rows = await this.prisma.lot.findMany({ where: and.length ? { AND: and } : {}, select: LOT_SUMMARY_SELECT, orderBy: { code: 'asc' }, take: limit + 1 });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page.map((row) => toLotSummary(row)), nextCursor: rows.length > limit && last ? encodeLotCursor(last.code) : null };
  }

  async createLot(input: { productId: unknown; code: unknown }, actor: AdminActor): Promise<AdminLotSummary> {
    const code = typeof input.code === 'string' ? input.code.trim() : '';
    if (!LOT_CODE_PATTERN.test(code)) {
      throw new BadRequestException('Lot code must be 2-63 characters: letters, numbers, ".", "_" or "-", starting with a letter or number.');
    }
    if (typeof input.productId !== 'string' || !input.productId) throw new BadRequestException('productId is required.');
    const product = await this.prisma.product.findUnique({ where: { id: input.productId }, select: { id: true } });
    if (!product) throw new NotFoundException('Product not found.');
    const duplicate = () => new ConflictException('A lot with this code already exists.');
    // Case-insensitive pre-check: two lots differing only in case would be confusable on a public verify page.
    if (await this.prisma.lot.findFirst({ where: { code: { equals: code, mode: 'insensitive' } }, select: { id: true } })) throw duplicate();
    let lot;
    try {
      lot = await this.prisma.lot.create({ data: { code, productId: product.id, coaKey: PLACEHOLDER_COA_KEY, purity: PLACEHOLDER_PURITY }, select: { id: true } });
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicate();
      throw error;
    }
    await this.record(actor, 'lot.create', 'lot', lot.id, { code, productId: product.id });
    return this.lotSummary(lot.id);
  }

  private async lotSummary(id: string): Promise<AdminLotSummary> {
    const row = await this.prisma.lot.findUnique({ where: { id }, select: LOT_SUMMARY_SELECT });
    if (!row) throw new NotFoundException('Lot not found.');
    return toLotSummary(row);
  }

  async getLot(id: string): Promise<{ lot: AdminLotSummary; coas: AdminCoa[] }> {
    const lot = await this.lotSummary(id);
    const rows = await this.prisma.coa.findMany({ where: { lotId: id }, orderBy: { version: 'desc' }, include: { anchors: true } });
    const names = await this.adminNames(rows.flatMap((row) => [row.createdByAdminId, row.publishedByAdminId, row.revokedByAdminId]));
    return { lot, coas: rows.map((row) => toAdminCoa(row, names)) };
  }

  /* --------------------------------------------------------------------------------------------------------------- coas */

  /**
   * Draft upload. The SHA-256 is computed here from the received bytes; the client's MIME type and file name decide nothing.
   * version = max+1 under a row lock on the lot, so concurrent uploads for one lot get distinct versions; a unique violation on
   * (lotId, version) (should the lock ever be bypassed) is retried.
   */
  async upload(lotId: string, file: UploadedPdfFile | undefined, rawFields: unknown, actor: AdminActor): Promise<AdminCoa> {
    const fields = parseCoaFields(rawFields);
    const bytes = assertPdf(file);
    const fileSha256 = sha256Hex(bytes);
    const fileName = sanitizeFileName(file?.originalname);

    let created: { id: string; version: number } | undefined;
    for (let attempt = 1; !created; attempt += 1) {
      try {
        created = await this.prisma.$transaction(async (tx) => {
          if (!(await this.lockLot(tx, lotId))) throw new NotFoundException('Lot not found.');
          const duplicate = await tx.coa.findFirst({ where: { lotId, fileSha256 }, select: { version: true } });
          if (duplicate) throw new ConflictException(`This file was already uploaded for this lot (version ${duplicate.version}).`);
          if ((await tx.coa.count({ where: { lotId, status: 'DRAFT' } })) >= MAX_DRAFTS_PER_LOT) {
            throw new ConflictException('This lot has too many unpublished drafts. Delete unused drafts first.');
          }
          const max = await tx.coa.aggregate({ where: { lotId }, _max: { version: true } });
          return tx.coa.create({
            data: {
              lotId,
              version: (max._max.version ?? 0) + 1,
              status: 'DRAFT',
              labName: fields.labName,
              labReportId: fields.labReportId,
              testedAt: new Date(`${fields.testedAt}T00:00:00.000Z`),
              method: fields.method,
              purityPercent: fields.purityPercent,
              notes: fields.notes,
              fileName,
              fileSize: bytes.length,
              fileSha256,
              createdByAdminId: actor.id,
              file: { create: { bytes: bytes as unknown as Uint8Array<ArrayBuffer> } },
            },
            select: { id: true, version: true },
          });
        }, TX_OPTIONS);
      } catch (error) {
        if (isUniqueViolation(error) && attempt < UPLOAD_ATTEMPTS) continue;
        throw error;
      }
    }
    const lot = await this.prisma.lot.findUnique({ where: { id: lotId }, select: { code: true } });
    await this.record(actor, 'coa.upload', 'coa', created.id, { lotId, lotCode: lot?.code ?? null, version: created.version, sha256: fileSha256, sizeBytes: bytes.length });
    return this.loadCoa(created.id);
  }

  /** The stored PDF of any status (admin review). */
  async getFile(id: string): Promise<{ bytes: Buffer; sha256: string }> {
    const coa = await this.prisma.coa.findUnique({ where: { id }, select: { fileSha256: true, file: { select: { bytes: true } } } });
    if (!coa || !coa.file) throw new NotFoundException('COA not found.');
    return { bytes: Buffer.from(coa.file.bytes), sha256: coa.fileSha256 };
  }

  /**
   * DRAFT -> PUBLISHED in ONE transaction under the lot's row lock: the claim is a conditional updateMany (status must still be DRAFT),
   * so a double click yields one 200 and one 409. The previous PUBLISHED becomes SUPERSEDED and Lot.purity/coaKey are synced.
   * The anchor request happens after the commit and can never fail the publish.
   */
  async publish(id: string, confirmSha256: unknown, actor: AdminActor): Promise<AdminCoa> {
    const confirm = normalizeSha256(confirmSha256);
    if (!confirm) throw new BadRequestException('confirmSha256 must be the 64-character SHA-256 hex of the file.');
    const coa = await this.prisma.coa.findUnique({ where: { id }, select: { id: true, lotId: true, version: true, status: true, fileSha256: true, lot: { select: { code: true } } } });
    if (!coa) throw new NotFoundException('COA not found.');
    if (coa.status !== 'DRAFT') throw new ConflictException('Only a draft COA can be published.');
    if (!hexEquals(confirm, coa.fileSha256)) throw new BadRequestException('confirmSha256 does not match the stored file hash.');

    const supersededIds = await this.prisma.$transaction(async (tx) => {
      await this.lockLot(tx, coa.lotId);
      const claimed = await tx.coa.updateMany({
        where: { id, status: 'DRAFT', fileSha256: coa.fileSha256 },
        data: { status: 'PUBLISHED', publishedByAdminId: actor.id, publishedAt: new Date() },
      });
      if (claimed.count !== 1) throw new ConflictException('Only a draft COA can be published.');
      const previous = await tx.coa.findMany({ where: { lotId: coa.lotId, status: 'PUBLISHED', id: { not: id } }, select: { id: true } });
      if (previous.length) await tx.coa.updateMany({ where: { id: { in: previous.map((row) => row.id) }, status: 'PUBLISHED' }, data: { status: 'SUPERSEDED' } });
      const published = await tx.coa.findUniqueOrThrow({ where: { id }, select: { purityPercent: true } });
      await tx.lot.update({ where: { id: coa.lotId }, data: { purity: published.purityPercent, coaKey: `coa/${id}` } });
      return previous.map((row) => row.id);
    }, TX_OPTIONS);

    await this.record(actor, 'coa.publish', 'coa', id, { lotId: coa.lotId, lotCode: coa.lot.code, version: coa.version, sha256: coa.fileSha256, supersededCoaIds: supersededIds });
    await requestAnchorSafely(this.anchorPort, { coaId: id, kind: 'PUBLISH' });
    return this.loadCoa(id);
  }

  /**
   * PUBLISHED or SUPERSEDED -> REVOKED (needs a reason). Revoking the PUBLISHED coa leaves the lot with no current COA, so the lot's
   * legacy purity/coaKey fields go back to the "no data" placeholders (existing readers must not keep showing a revoked result).
   */
  async revoke(id: string, reasonInput: unknown, actor: AdminActor): Promise<AdminCoa> {
    const reason = typeof reasonInput === 'string' ? reasonInput.trim() : '';
    if (!reason || reason.length > REVOKE_REASON_MAX) throw new BadRequestException(`reason is required (1-${REVOKE_REASON_MAX} characters).`);
    const coa = await this.prisma.coa.findUnique({ where: { id }, select: { id: true, lotId: true, version: true, status: true, lot: { select: { code: true } } } });
    if (!coa) throw new NotFoundException('COA not found.');
    this.assertRevocable(coa.status);

    const previousStatus = await this.prisma.$transaction(async (tx) => {
      await this.lockLot(tx, coa.lotId);
      const current = await tx.coa.findUnique({ where: { id }, select: { status: true } });
      if (!current) throw new NotFoundException('COA not found.');
      this.assertRevocable(current.status);
      const claimed = await tx.coa.updateMany({
        where: { id, status: { in: ['PUBLISHED', 'SUPERSEDED'] } },
        data: { status: 'REVOKED', revokedByAdminId: actor.id, revokedAt: new Date(), revokeReason: reason },
      });
      if (claimed.count !== 1) throw new ConflictException('This COA was changed by someone else; reload and try again.');
      if (current.status === 'PUBLISHED') await tx.lot.update({ where: { id: coa.lotId }, data: { purity: PLACEHOLDER_PURITY, coaKey: PLACEHOLDER_COA_KEY } });
      return current.status;
    }, TX_OPTIONS);

    await this.record(actor, 'coa.revoke', 'coa', id, { lotId: coa.lotId, lotCode: coa.lot.code, version: coa.version, previousStatus, reason });
    await requestAnchorSafely(this.anchorPort, { coaId: id, kind: 'REVOKE' });
    return this.loadCoa(id);
  }

  private assertRevocable(status: string): void {
    if (status === 'DRAFT') throw new ConflictException('A draft COA cannot be revoked; delete it instead.');
    if (status === 'REVOKED') throw new ConflictException('This COA is already revoked.');
  }

  /** DRAFT only; the OWNER or the admin who uploaded it. */
  async delete(id: string, actor: AdminActor): Promise<void> {
    const coa = await this.prisma.coa.findUnique({ where: { id }, select: { id: true, lotId: true, version: true, status: true, fileSha256: true, createdByAdminId: true, lot: { select: { code: true } } } });
    if (!coa) throw new NotFoundException('COA not found.');
    if (actor.role !== 'OWNER' && coa.createdByAdminId !== actor.id) throw new ForbiddenException('Only an owner or the uploader can delete a draft.');
    if (coa.status !== 'DRAFT') throw new ConflictException('Only a draft COA can be deleted.');
    await this.prisma.$transaction(async (tx) => {
      await this.lockLot(tx, coa.lotId);
      const current = await tx.coa.findUnique({ where: { id }, select: { status: true } });
      if (!current) throw new NotFoundException('COA not found.');
      if (current.status !== 'DRAFT') throw new ConflictException('Only a draft COA can be deleted.');
      await tx.coaAnchor.deleteMany({ where: { coaId: id } });
      await tx.coaFile.deleteMany({ where: { coaId: id } });
      const removed = await tx.coa.deleteMany({ where: { id, status: 'DRAFT' } });
      if (removed.count !== 1) throw new ConflictException('Only a draft COA can be deleted.');
    }, TX_OPTIONS);
    await this.record(actor, 'coa.delete', 'coa', id, { lotId: coa.lotId, lotCode: coa.lot.code, version: coa.version, sha256: coa.fileSha256 });
  }

  /** Re-requests the PUBLISH or REVOKE anchor of a coa that has reached that state. The port is idempotent per (coa, kind). */
  async retryAnchor(id: string, kind: unknown, actor: AdminActor): Promise<AdminCoa> {
    if (kind !== 'PUBLISH' && kind !== 'REVOKE') throw new BadRequestException('kind must be PUBLISH or REVOKE.');
    const coa = await this.prisma.coa.findUnique({ where: { id }, select: { id: true, status: true, publishedAt: true } });
    if (!coa) throw new NotFoundException('COA not found.');
    if (kind === 'PUBLISH' && !(coa.publishedAt && coa.status !== 'DRAFT')) throw new ConflictException('This COA was never published.');
    if (kind === 'REVOKE' && coa.status !== 'REVOKED') throw new ConflictException('This COA is not revoked.');
    if (this.anchors) {
      try {
        await this.anchors.retry(id, kind as CoaAnchorKindName);
      } catch (error) {
        if (error instanceof CoaAnchorRefusedError) {
          if (error.reason === 'NOT_FOUND') throw new NotFoundException(error.message);
          if (error.reason === 'ALREADY_CONFIRMED' || error.reason === 'IN_FLIGHT' || error.reason === 'NOT_ELIGIBLE') throw new ConflictException(error.message);
          throw new ServiceUnavailableException(error.message);
        }
        throw error;
      }
    } else {
      if (!this.anchorPort) throw new ServiceUnavailableException('Anchoring is not available on this server.');
      await requestAnchorSafely(this.anchorPort, { coaId: id, kind: kind as CoaAnchorKindName });
    }
    await this.record(actor, 'coa.anchor.retry', 'coa', id, { kind });
    return this.loadCoa(id);
  }

  /* --------------------------------------------------------------------------------------------------------------- helpers */

  /** Row lock on the lot: serializes version numbering, publish, revoke and delete for that lot. False when the lot does not exist. */
  private async lockLot(tx: Prisma.TransactionClient, lotId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Lot" WHERE "id" = ${lotId} FOR UPDATE`;
    return rows.length > 0;
  }

  private async adminNames(ids: Array<string | null>): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((value): value is string => Boolean(value)))];
    if (!wanted.length) return new Map();
    const admins = await this.prisma.adminUser.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true } });
    return new Map(admins.map((admin) => [admin.id, admin.name]));
  }

  async loadCoa(id: string): Promise<AdminCoa> {
    const row = await this.prisma.coa.findUnique({ where: { id }, include: { anchors: true } });
    if (!row) throw new NotFoundException('COA not found.');
    const names = await this.adminNames([row.createdByAdminId, row.publishedByAdminId, row.revokedByAdminId]);
    return toAdminCoa(row, names);
  }

  /** The mutation is already committed when this runs, so an audit failure is logged (ids only) instead of turning success into an error. */
  private async record(actor: AdminActor, action: string, targetType: string, targetId: string, detail: Record<string, unknown>): Promise<void> {
    try {
      await this.audit.record({ adminId: actor.id, action, targetType, targetId, detail, ip: actor.ip });
    } catch {
      this.logger.error(`audit write failed action=${action} target=${targetType}:${targetId}`);
    }
  }
}

/** Constant-time comparison of two lower-case hex strings. */
export function hexEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
