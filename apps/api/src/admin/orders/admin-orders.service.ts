import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AdminAuditService } from '../admin-audit.service';
import { INVENTORY_PORT, type InventoryPort } from '../../commerce/inventory.types';
import { PrismaService } from '../../prisma.service';
import { assertNoRefundInFlight, currentRefund, loadRefundRows, toAdminRefund, withRefundAction } from './admin-order-refund.view';
import { EMAIL_PORT, type EmailPort } from '../../email/email.types';
import { runOrderEmailHook } from '../../orders/customer-orders.email-hook';
import { buildTrackingUrl } from '../../orders/customer-orders.mappers';
import {
  type AdminActor,
  type AdminOrderAction,
  type AdminOrderCounts,
  type AdminOrderDetail,
  type AdminOrderPage,
  type AdminOrderPayment,
  type AdminOrderSummary,
  type CarrierName,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  ORDER_STATUSES,
  type OrderStatusName,
  PAID_ORDER_CANCEL_MESSAGE,
  SEARCH_QUERY_MAX,
} from './admin-orders.types';

/** Statuses from which an order is on its way to (or past) the customer's payment; never cancellable here. */
const PAID_STATES: ReadonlySet<OrderStatusName> = new Set(['PAID', 'PROCESSING', 'SHIPPED']);

/** Which actions the owner may take next. 'add-note' is always allowed. */
export function allowedActionsFor(status: OrderStatusName): AdminOrderAction[] {
  const next: Partial<Record<OrderStatusName, AdminOrderAction>> = {
    PENDING_PAYMENT: 'cancel',
    PAID: 'start-packing',
    PROCESSING: 'ship',
    SHIPPED: 'mark-delivered',
  };
  const action = next[status];
  return action ? [action, 'add-note'] : ['add-note'];
}

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt.getTime(), i: id }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const invalid = () => new BadRequestException('Invalid cursor.');
  if (typeof cursor !== 'string' || cursor.length > 200 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const { t, i } = (parsed ?? {}) as { t?: unknown; i?: unknown };
  if (typeof t !== 'number' || !Number.isSafeInteger(t) || typeof i !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(i)) throw invalid();
  const createdAt = new Date(t);
  if (Number.isNaN(createdAt.getTime())) throw invalid();
  return { createdAt, id: i };
}

/** `status=PAID,PROCESSING` -> ['PAID','PROCESSING'] (deduplicated). Unknown values are a 400, never silently ignored. */
export function parseStatusFilter(raw: string | undefined): OrderStatusName[] | null {
  if (raw === undefined || raw.trim() === '') return null;
  const parts = [...new Set(raw.split(',').map((part) => part.trim()).filter(Boolean))];
  const unknown = parts.filter((part) => !(ORDER_STATUSES as readonly string[]).includes(part));
  if (unknown.length || parts.length === 0) throw new BadRequestException(`Unknown order status. Allowed: ${ORDER_STATUSES.join(', ')}.`);
  return parts as OrderStatusName[];
}

/** Prisma passes `contains`/`startsWith` to LIKE unescaped, so `%` and `_` typed by the admin would act as wildcards. PostgreSQL's default LIKE escape is a backslash. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export function buildListWhere(filter: { statuses: OrderStatusName[] | null; q: string | null; cursor: { createdAt: Date; id: string } | null }): Prisma.OrderWhereInput {
  const and: Prisma.OrderWhereInput[] = [];
  if (filter.statuses) and.push({ status: { in: filter.statuses } });
  if (filter.q) {
    const q = escapeLike(filter.q);
    and.push({ OR: [{ id: { startsWith: q, mode: 'insensitive' } }, { customer: { email: { contains: q, mode: 'insensitive' } } }] });
  }
  if (filter.cursor) {
    // Keyset on (createdAt DESC, id DESC): strictly "after" the last row of the previous page, stable across createdAt ties.
    and.push({ OR: [{ createdAt: { lt: filter.cursor.createdAt } }, { AND: [{ createdAt: filter.cursor.createdAt }, { id: { lt: filter.cursor.id } }] }] });
  }
  return and.length ? { AND: and } : {};
}

const SUMMARY_SELECT = {
  id: true,
  status: true,
  totalCents: true,
  subtotalCents: true,
  shippingCents: true,
  taxCents: true,
  currency: true,
  createdAt: true,
  customer: { select: { id: true, email: true, name: true } },
  items: { select: { quantity: true } },
  shipments: { select: { id: true, trackingNumber: true, shippedAt: true } },
} satisfies Prisma.OrderSelect;
type SummaryRow = Prisma.OrderGetPayload<{ select: typeof SUMMARY_SELECT }>;

const PURCHASE_PRIORITY: Record<string, number> = { FINALIZED: 5, CONFIRMED: 4, SUBMITTED: 3, PREPARED: 2, FAILED: 1, EXPIRED: 0 };

function summarize(row: Pick<SummaryRow, 'id' | 'status' | 'totalCents' | 'subtotalCents' | 'shippingCents' | 'taxCents' | 'currency' | 'createdAt' | 'customer' | 'items' | 'shipments'>): AdminOrderSummary {
  // The tracking number shown in lists is the most recent shipment's.
  const latest = [...row.shipments].sort((a, b) => b.shippedAt.getTime() - a.shippedAt.getTime() || (a.id < b.id ? 1 : -1))[0];
  return {
    id: row.id,
    status: row.status,
    subtotalCents: row.subtotalCents ?? null,
    shippingCents: row.shippingCents ?? 0,
    taxCents: row.taxCents ?? 0,
    totalCents: row.totalCents,
    currency: row.currency,
    createdAt: row.createdAt.toISOString(),
    customer: { id: row.customer.id, email: row.customer.email, name: row.customer.name },
    itemCount: row.items.reduce((sum, item) => sum + item.quantity, 0),
    hasShipment: row.shipments.length > 0,
    trackingNumber: latest?.trackingNumber ?? null,
  };
}

interface Transition {
  id: string;
  from: OrderStatusName;
  to: OrderStatusName;
  /** Human wording used in `Order is X; cannot <label>.` */
  label: string;
  note: string | null;
  actor: AdminActor;
  /** Runs inside the same transaction, only for the call that actually flipped the status. */
  during?: (tx: Prisma.TransactionClient) => Promise<void>;
}

@Injectable()
export class AdminOrdersService {
  private readonly logger = new Logger(AdminOrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    @Optional() @Inject(EMAIL_PORT) private readonly email?: EmailPort,
    @Optional() @Inject(INVENTORY_PORT) private readonly inventory?: InventoryPort,
  ) {}

  async counts(): Promise<AdminOrderCounts> {
    const rows = await this.prisma.order.groupBy({ by: ['status'], _count: { _all: true } });
    const counts = Object.fromEntries(ORDER_STATUSES.map((status) => [status, 0])) as Record<OrderStatusName, number>;
    for (const row of rows) counts[row.status] = row._count._all;
    return { counts };
  }

  async list(query: { status?: string; q?: string; limit?: number; cursor?: string }): Promise<AdminOrderPage> {
    const limit = query.limit ?? DEFAULT_LIST_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) throw new BadRequestException(`limit must be between 1 and ${MAX_LIST_LIMIT}.`);
    const q = (query.q ?? '').trim();
    if (q.length > SEARCH_QUERY_MAX) throw new BadRequestException(`q must be at most ${SEARCH_QUERY_MAX} characters.`);
    const where = buildListWhere({
      statuses: parseStatusFilter(query.status),
      q: q || null,
      cursor: query.cursor ? decodeCursor(query.cursor) : null,
    });
    const rows = await this.prisma.order.findMany({
      where,
      select: SUMMARY_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page.map(summarize), nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null };
  }

  async detail(id: string): Promise<AdminOrderDetail> {
    const order = await this.prisma.order.findUnique({
      where: { id },
      select: {
        ...SUMMARY_SELECT,
        shippingAddress: true,
        items: { select: { id: true, productId: true, lotCode: true, quantity: true, unitCents: true }, orderBy: { id: 'asc' } },
        shipments: { select: { id: true, carrier: true, trackingNumber: true, shippedAt: true, deliveredAt: true, note: true }, orderBy: [{ shippedAt: 'asc' }, { id: 'asc' }] },
        events: { select: { id: true, kind: true, fromStatus: true, toStatus: true, note: true, adminId: true, createdAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      },
    });
    if (!order) throw new NotFoundException('Order not found.');

    const productIds = [...new Set(order.items.map((item) => item.productId))];
    const adminIds = [...new Set(order.events.map((event) => event.adminId).filter((value): value is string => Boolean(value)))];
    const [products, admins, purchases] = await Promise.all([
      productIds.length ? this.prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, sku: true, name: true } }) : [],
      adminIds.length ? this.prisma.adminUser.findMany({ where: { id: { in: adminIds } }, select: { id: true, name: true } }) : [],
      // Read-only view of the chain-side purchase row. Wallet addresses are deliberately not selected.
      this.prisma.cryptoTransaction.findMany({
        where: { orderId: id, type: 'PURCHASE' },
        select: { status: true, amountAtomic: true, txSignature: true, network: true, finalizedAt: true, createdAt: true },
      }),
    ]);
    const refundRows = await loadRefundRows(this.prisma, id);
    const productById = new Map(products.map((product) => [product.id, product]));
    const adminById = new Map(admins.map((admin) => [admin.id, admin.name]));

    return {
      ...summarize(order),
      shippingAddress: order.shippingAddress ?? null,
      items: order.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        sku: productById.get(item.productId)?.sku ?? 'UNKNOWN',
        name: productById.get(item.productId)?.name ?? 'Unknown product',
        lotCode: item.lotCode,
        quantity: item.quantity,
        unitCents: item.unitCents,
      })),
      payment: this.paymentSummary(purchases),
      shipments: order.shipments.map((shipment) => ({
        id: shipment.id,
        carrier: shipment.carrier,
        trackingNumber: shipment.trackingNumber,
        shippedAt: shipment.shippedAt.toISOString(),
        deliveredAt: shipment.deliveredAt ? shipment.deliveredAt.toISOString() : null,
        note: shipment.note ?? null,
      })),
      events: order.events.map((event) => ({
        id: event.id,
        kind: event.kind === 'NOTE' ? 'NOTE' : 'STATUS',
        fromStatus: event.fromStatus ?? null,
        toStatus: event.toStatus ?? null,
        note: event.note ?? null,
        adminName: event.adminId ? adminById.get(event.adminId) ?? null : null,
        createdAt: event.createdAt.toISOString(),
      })),
      refund: toAdminRefund(currentRefund(refundRows)),
      allowedActions: withRefundAction(allowedActionsFor(order.status), order.status, refundRows),
    };
  }

  /** PAID -> PROCESSING */
  async startPacking(id: string, actor: AdminActor): Promise<AdminOrderDetail> {
    await this.transition({ id, from: 'PAID', to: 'PROCESSING', label: 'start packing', note: null, actor });
    await this.record(actor, 'order.start-packing', id, { fromStatus: 'PAID', toStatus: 'PROCESSING' });
    return this.detail(id);
  }

  /** PROCESSING -> SHIPPED, recording the Shipment. Exactly one concurrent caller can succeed. */
  async ship(id: string, input: { carrier: CarrierName; trackingNumber: string; note?: string | null }, actor: AdminActor): Promise<AdminOrderDetail> {
    const note = input.note?.trim() ? input.note.trim() : null;
    const duplicate = () => new ConflictException('This tracking number is already recorded for this order.');
    try {
      await this.transition({
        id,
        from: 'PROCESSING',
        to: 'SHIPPED',
        label: 'ship',
        note,
        actor,
        during: async (tx) => {
          if (await tx.shipment.findFirst({ where: { orderId: id, trackingNumber: input.trackingNumber }, select: { id: true } })) throw duplicate();
          await tx.shipment.create({
            data: { orderId: id, carrier: input.carrier, trackingNumber: input.trackingNumber, note, createdByAdminId: actor.id },
          });
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicate();
      throw error;
    }
    await this.record(actor, 'order.ship', id, { fromStatus: 'PROCESSING', toStatus: 'SHIPPED', carrier: input.carrier, trackingNumber: input.trackingNumber });
    await this.notifyShipped(id, input.carrier, input.trackingNumber);
    return this.detail(id);
  }

  /**
   * Runs only after the ship transaction committed (and only for the one call that flipped the status). Fail-soft and
   * time-boxed: see runOrderEmailHook. The dedupeKey makes a repeated enqueue a no-op in the outbox.
   */
  private async notifyShipped(orderId: string, carrier: CarrierName, trackingNumber: string): Promise<void> {
    await runOrderEmailHook({
      email: this.email,
      logger: this.logger,
      template: 'order_shipped',
      orderId,
      build: async () => {
        const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { customer: { select: { email: true } } } });
        const to = order?.customer?.email;
        if (!to) return null;
        return {
          to,
          template: 'order_shipped',
          dedupeKey: `order_shipped:${orderId}:${trackingNumber}`,
          data: { orderId, carrier, trackingNumber, trackingUrl: buildTrackingUrl(carrier, trackingNumber) },
        };
      },
    });
  }

  /** SHIPPED -> DELIVERED */
  async markDelivered(id: string, actor: AdminActor): Promise<AdminOrderDetail> {
    await this.transition({
      id,
      from: 'SHIPPED',
      to: 'DELIVERED',
      label: 'mark delivered',
      note: null,
      actor,
      during: async (tx) => {
        await tx.shipment.updateMany({ where: { orderId: id, deliveredAt: null }, data: { deliveredAt: new Date() } });
      },
    });
    await this.record(actor, 'order.mark-delivered', id, { fromStatus: 'SHIPPED', toStatus: 'DELIVERED' });
    return this.detail(id);
  }

  /** PENDING_PAYMENT -> CANCELLED only. Paid orders go through the refunds process. */
  async cancel(id: string, reason: string, actor: AdminActor): Promise<AdminOrderDetail> {
    await this.transition({
      id,
      from: 'PENDING_PAYMENT',
      to: 'CANCELLED',
      label: 'cancel',
      note: reason.trim(),
      actor,
      // Same transaction as the status flip: either the order is cancelled AND its stock is back, or neither happened.
      during: async (tx) => {
        if (!this.inventory) throw new Error('INVENTORY_PORT is not wired: refusing to cancel without releasing stock');
        await this.inventory.releaseForOrder(tx, id, 'Cancelled by admin');
      },
    });
    // The reason text stays on the OrderEvent; the audit row keeps ids and statuses only.
    await this.record(actor, 'order.cancel', id, { fromStatus: 'PENDING_PAYMENT', toStatus: 'CANCELLED' });
    return this.detail(id);
  }

  async addNote(id: string, note: string, actor: AdminActor): Promise<AdminOrderDetail> {
    const order = await this.prisma.order.findUnique({ where: { id }, select: { id: true } });
    if (!order) throw new NotFoundException('Order not found.');
    await this.prisma.orderEvent.create({ data: { orderId: id, kind: 'NOTE', note: note.trim(), adminId: actor.id } });
    await this.record(actor, 'order.add-note', id, { noteLength: note.trim().length });
    return this.detail(id);
  }

  /**
   * One transaction: conditional status flip, then (only if this call flipped it) the caller's side effects and the
   * STATUS event. A second concurrent/double-clicked call matches zero rows and writes nothing.
   */
  private async transition(spec: Transition): Promise<void> {
    const flipped = await this.prisma.$transaction(async (tx) => {
      const result = await tx.order.updateMany({ where: { id: spec.id, status: spec.from }, data: { status: spec.to } });
      if (result.count !== 1) return false;
      // An order whose refund is already on its way to the customer is neither packed nor shipped (admin-order-refund.view.ts).
      if (spec.to === 'PROCESSING' || spec.to === 'SHIPPED') await assertNoRefundInFlight(tx, spec.id);
      await spec.during?.(tx);
      await tx.orderEvent.create({
        data: { orderId: spec.id, kind: 'STATUS', fromStatus: spec.from, toStatus: spec.to, note: spec.note, adminId: spec.actor.id },
      });
      return true;
    });
    if (flipped) return;
    const current = await this.prisma.order.findUnique({ where: { id: spec.id }, select: { status: true } });
    if (!current) throw new NotFoundException('Order not found.');
    if (spec.to === 'CANCELLED' && PAID_STATES.has(current.status)) throw new ConflictException(PAID_ORDER_CANCEL_MESSAGE);
    throw new ConflictException(`Order is ${current.status}; cannot ${spec.label}.`);
  }

  private paymentSummary(
    purchases: Array<{ status: string; amountAtomic: bigint; txSignature: string | null; network: string; finalizedAt: Date | null; createdAt: Date }>,
  ): AdminOrderPayment | null {
    if (!purchases.length) return null;
    // Retries leave several PURCHASE rows: show the furthest-along one, newest first on ties.
    const best = [...purchases].sort((a, b) => (PURCHASE_PRIORITY[b.status] ?? -1) - (PURCHASE_PRIORITY[a.status] ?? -1) || b.createdAt.getTime() - a.createdAt.getTime())[0];
    return {
      status: best.status,
      amountAtomic: best.amountAtomic.toString(),
      txSignature: best.txSignature ?? null,
      network: best.network,
      finalizedAt: best.finalizedAt ? best.finalizedAt.toISOString() : null,
    };
  }

  /**
   * The status change is already committed when this runs, so an audit failure must not turn a successful action into an
   * error the admin would retry. It is logged loudly (ids only) instead.
   */
  private async record(actor: AdminActor, action: string, orderId: string, detail: Record<string, unknown>): Promise<void> {
    try {
      await this.audit.record({ adminId: actor.id, action, targetType: 'order', targetId: orderId, detail, ip: actor.ip });
    } catch (error) {
      this.logger.error(`Audit write failed for ${action} on order ${orderId}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'P2002';
}
