import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { InventoryService } from '../../commerce/inventory.service';
import { PrismaService } from '../../prisma.service';
import { AdminAuditService } from '../admin-audit.service';
import type { AdminActor } from '../orders/admin-orders.types';
import {
  ADJUST_REASON_MAX,
  type AdminInventoryItem,
  type AdminInventoryPage,
  type AdminLedgerPage,
  DEFAULT_LEDGER_LIMIT,
  DEFAULT_LIST_LIMIT,
  type InventoryKindName,
  MAX_ADJUST_DELTA,
  MAX_LEDGER_LIMIT,
  MAX_LIST_LIMIT,
  SEARCH_QUERY_MAX,
} from './admin-inventory.types';

/** Prisma passes `contains` to LIKE unescaped, so `%` and `_` typed by the admin would act as wildcards. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

const invalidCursor = () => new BadRequestException('Invalid cursor.');
const CURSOR_TEXT = /^[A-Za-z0-9_-]+$/;

function decodeCursorObject(cursor: string): Record<string, unknown> {
  if (typeof cursor !== 'string' || cursor.length > 200 || !CURSOR_TEXT.test(cursor)) throw invalidCursor();
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw invalidCursor();
    return parsed as Record<string, unknown>;
  } catch {
    throw invalidCursor();
  }
}

/** Inventory list cursor: the last SKU of the page (SKU is unique; the list is ordered by SKU ascending). */
export const encodeInventoryCursor = (sku: string): string => Buffer.from(JSON.stringify({ s: sku }), 'utf8').toString('base64url');
export function decodeInventoryCursor(cursor: string): string {
  const { s } = decodeCursorObject(cursor);
  if (typeof s !== 'string' || s.length < 1 || s.length > 100) throw invalidCursor();
  return s;
}

/** Ledger cursor: (createdAt ms, id) of the last row; the ledger is newest first. */
export const encodeLedgerCursor = (createdAt: Date, id: string): string => Buffer.from(JSON.stringify({ t: createdAt.getTime(), i: id }), 'utf8').toString('base64url');
export function decodeLedgerCursor(cursor: string): { createdAt: Date; id: string } {
  const { t, i } = decodeCursorObject(cursor);
  if (typeof t !== 'number' || !Number.isSafeInteger(t) || typeof i !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(i)) throw invalidCursor();
  const createdAt = new Date(t);
  if (Number.isNaN(createdAt.getTime())) throw invalidCursor();
  return { createdAt, id: i };
}

export function toInventoryItem(
  product: { id: string; sku: string; name: string; active: boolean; inventory: number; lowStockThreshold: number | null },
  reserved: number,
): AdminInventoryItem {
  return {
    productId: product.id,
    sku: product.sku,
    name: product.name,
    active: product.active,
    onHand: product.inventory,
    reserved,
    lowStockThreshold: product.lowStockThreshold,
    lowStock: product.lowStockThreshold !== null && product.inventory <= product.lowStockThreshold,
  };
}

const PRODUCT_SELECT = { id: true, sku: true, name: true, active: true, inventory: true, lowStockThreshold: true } satisfies Prisma.ProductSelect;

@Injectable()
export class AdminInventoryService {
  private readonly logger = new Logger(AdminInventoryService.name);

  constructor(private readonly prisma: PrismaService, private readonly audit: AdminAuditService, private readonly inventory: InventoryService) {}

  async list(query: { q?: string; lowStockOnly?: boolean; limit?: number; cursor?: string }): Promise<AdminInventoryPage> {
    const limit = query.limit ?? DEFAULT_LIST_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) throw new BadRequestException(`limit must be between 1 and ${MAX_LIST_LIMIT}.`);
    const q = (query.q ?? '').trim();
    if (q.length > SEARCH_QUERY_MAX) throw new BadRequestException(`q must be at most ${SEARCH_QUERY_MAX} characters.`);

    const and: Prisma.ProductWhereInput[] = [];
    if (q) {
      const like = escapeLike(q);
      and.push({ OR: [{ sku: { contains: like, mode: 'insensitive' } }, { name: { contains: like, mode: 'insensitive' } }] });
    }
    // Column-to-column comparison (inventory <= lowStockThreshold); a NULL threshold never matches.
    if (query.lowStockOnly === true) and.push({ lowStockThreshold: { not: null }, inventory: { lte: this.prisma.product.fields.lowStockThreshold } });
    if (query.cursor) and.push({ sku: { gt: decodeInventoryCursor(query.cursor) } });

    const rows = await this.prisma.product.findMany({ where: and.length ? { AND: and } : {}, select: PRODUCT_SELECT, orderBy: { sku: 'asc' }, take: limit + 1 });
    const page = rows.slice(0, limit);
    const reserved = await this.reservedByProduct(page.map((row) => row.id));
    const last = page[page.length - 1];
    return { items: page.map((row) => toInventoryItem(row, reserved.get(row.id) ?? 0)), nextCursor: rows.length > limit && last ? encodeInventoryCursor(last.sku) : null };
  }

  async adjust(productId: string, input: { delta: number; reason: string }, actor: AdminActor): Promise<AdminInventoryItem> {
    const reason = input.reason.trim();
    if (!Number.isInteger(input.delta) || input.delta === 0 || Math.abs(input.delta) > MAX_ADJUST_DELTA) {
      throw new BadRequestException(`delta must be a non-zero whole number with an absolute value of at most ${MAX_ADJUST_DELTA}.`);
    }
    if (!reason || reason.length > ADJUST_REASON_MAX) throw new BadRequestException(`reason must be 1-${ADJUST_REASON_MAX} characters.`);
    const onHand = await this.prisma.$transaction((tx) => this.inventory.adjust(tx, { productId, delta: input.delta, reason, adminId: actor.id }));
    await this.record(actor, 'inventory.adjust', productId, { delta: input.delta, onHandAfter: onHand, reasonLength: reason.length });
    return this.item(productId);
  }

  async setThreshold(productId: string, lowStockThreshold: number | null, actor: AdminActor): Promise<AdminInventoryItem> {
    if (lowStockThreshold !== null && (!Number.isInteger(lowStockThreshold) || lowStockThreshold < 0 || lowStockThreshold > 2_147_483_647)) {
      throw new BadRequestException('lowStockThreshold must be a whole number >= 0 or null.');
    }
    const before = await this.prisma.product.findUnique({ where: { id: productId }, select: { lowStockThreshold: true } });
    if (!before) throw new NotFoundException('Product not found.');
    await this.prisma.product.update({ where: { id: productId }, data: { lowStockThreshold } });
    await this.record(actor, 'inventory.threshold', productId, { from: before.lowStockThreshold, to: lowStockThreshold });
    return this.item(productId);
  }

  async ledger(productId: string, query: { limit?: number; cursor?: string }): Promise<AdminLedgerPage> {
    const limit = query.limit ?? DEFAULT_LEDGER_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LEDGER_LIMIT) throw new BadRequestException(`limit must be between 1 and ${MAX_LEDGER_LIMIT}.`);
    const cursor = query.cursor ? decodeLedgerCursor(query.cursor) : null;
    const product = await this.prisma.product.findUnique({ where: { id: productId }, select: { id: true } });
    if (!product) throw new NotFoundException('Product not found.');

    const where: Prisma.InventoryAdjustmentWhereInput = { productId };
    if (cursor) {
      // Keyset on (createdAt DESC, id DESC): strictly after the last row of the previous page, stable across createdAt ties.
      where.OR = [{ createdAt: { lt: cursor.createdAt } }, { AND: [{ createdAt: cursor.createdAt }, { id: { lt: cursor.id } }] }];
    }
    const rows = await this.prisma.inventoryAdjustment.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 });
    const page = rows.slice(0, limit);
    const adminIds = [...new Set(page.map((row) => row.adminId).filter((value): value is string => Boolean(value)))];
    const admins = adminIds.length ? await this.prisma.adminUser.findMany({ where: { id: { in: adminIds } }, select: { id: true, name: true } }) : [];
    const names = new Map(admins.map((admin) => [admin.id, admin.name]));
    const last = page[page.length - 1];
    return {
      items: page.map((row) => ({
        id: row.id,
        delta: row.delta,
        kind: row.kind as InventoryKindName,
        reason: row.reason ?? null,
        orderId: row.orderId ?? null,
        adminName: row.adminId ? names.get(row.adminId) ?? null : null,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: rows.length > limit && last ? encodeLedgerCursor(last.createdAt, last.id) : null,
    };
  }

  private async item(productId: string): Promise<AdminInventoryItem> {
    const product = await this.prisma.product.findUnique({ where: { id: productId }, select: PRODUCT_SELECT });
    if (!product) throw new NotFoundException('Product not found.');
    const reserved = await this.reservedByProduct([productId]);
    return toInventoryItem(product, reserved.get(productId) ?? 0);
  }

  /** Units held by unpaid orders whose hold has not run out and whose stock has not been released. */
  private async reservedByProduct(productIds: string[]): Promise<Map<string, number>> {
    if (!productIds.length) return new Map();
    const rows = await this.prisma.orderItem.groupBy({
      by: ['productId'],
      where: { productId: { in: productIds }, order: { status: 'PENDING_PAYMENT', inventoryReleasedAt: null, expiresAt: { gt: new Date() } } },
      _sum: { quantity: true },
    });
    return new Map(rows.map((row) => [row.productId, row._sum.quantity ?? 0]));
  }

  /** The stock change is already committed when this runs: an audit failure is logged (ids only), never turned into an error the admin would retry. */
  private async record(actor: AdminActor, action: string, productId: string, detail: Record<string, unknown>): Promise<void> {
    try {
      await this.audit.record({ adminId: actor.id, action, targetType: 'product', targetId: productId, detail, ip: actor.ip });
    } catch (error) {
      this.logger.error(`Audit write failed for ${action} on product ${productId}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
}
