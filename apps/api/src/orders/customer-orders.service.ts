import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { CUSTOMER_ORDERS_DEFAULT_LIMIT, CUSTOMER_ORDERS_MAX_LIMIT, type CustomerOrderDetail, type CustomerOrderPage } from './customer-orders.dto';
import { decodeOrderCursor, encodeOrderCursor, toOrderDetail, toOrderSummary } from './customer-orders.mappers';

const NOT_FOUND = 'Order not found.';
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const TOTALS = { id: true, status: true, totalCents: true, subtotalCents: true, shippingCents: true, taxCents: true, currency: true, createdAt: true } as const;

/**
 * Read-only order history for the signed-in customer. Every query is filtered by the resolved customer's id, so an
 * order that belongs to someone else is indistinguishable from one that does not exist. Selects are explicit:
 * staff notes, admin ids, the shipment note and wallet/payment columns are never read.
 */
@Injectable()
export class CustomerOrdersService {
  constructor(private readonly prisma: PrismaService) {}

  /** `email` comes from the shared identity resolver (already normalised). Customers are never created here. */
  async list(email: string, query: { limit?: number; cursor?: string }): Promise<CustomerOrderPage> {
    const limit = query.limit ?? CUSTOMER_ORDERS_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > CUSTOMER_ORDERS_MAX_LIMIT) throw new BadRequestException(`limit must be between 1 and ${CUSTOMER_ORDERS_MAX_LIMIT}.`);
    const cursor = query.cursor ? decodeOrderCursor(query.cursor) : null;
    const customerId = await this.customerId(email);
    if (!customerId) return { items: [], nextCursor: null };

    const where: Prisma.OrderWhereInput = { customerId };
    if (cursor) {
      // Keyset on (createdAt DESC, id DESC): strictly after the last row of the previous page, stable across createdAt ties.
      where.OR = [{ createdAt: { lt: cursor.createdAt } }, { AND: [{ createdAt: cursor.createdAt }, { id: { lt: cursor.id } }] }];
    }
    const rows = await this.prisma.order.findMany({
      where,
      select: {
        ...TOTALS,
        items: { select: { quantity: true } },
        shipments: { select: { id: true, carrier: true, trackingNumber: true, shippedAt: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page.map(toOrderSummary), nextCursor: rows.length > limit && last ? encodeOrderCursor(last.createdAt, last.id) : null };
  }

  async detail(email: string, id: string): Promise<CustomerOrderDetail> {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new NotFoundException(NOT_FOUND);
    const customerId = await this.customerId(email);
    if (!customerId) throw new NotFoundException(NOT_FOUND);
    const order = await this.prisma.order.findFirst({
      where: { id, customerId },
      select: {
        ...TOTALS,
        shippingAddress: true,
        items: { select: { id: true, productId: true, lotCode: true, quantity: true, unitCents: true }, orderBy: { id: 'asc' } },
        shipments: { select: { id: true, carrier: true, trackingNumber: true, shippedAt: true, deliveredAt: true }, orderBy: [{ shippedAt: 'asc' }, { id: 'asc' }] },
        // Only the target status and time of STATUS events: the note and adminId columns are not selected.
        events: { where: { kind: 'STATUS' }, select: { toStatus: true, createdAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      },
    });
    if (!order) throw new NotFoundException(NOT_FOUND);

    const productIds = [...new Set(order.items.map((item) => item.productId))];
    const [products, purchase] = await Promise.all([
      productIds.length ? this.prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, slug: true, name: true } }) : [],
      // Settlement writes no OrderEvent; the finalized purchase time is the PAID moment (only the timestamp is selected).
      this.prisma.cryptoTransaction.findFirst({ where: { orderId: id, type: 'PURCHASE', status: 'FINALIZED' }, select: { finalizedAt: true }, orderBy: { finalizedAt: 'asc' } }),
    ]);
    return toOrderDetail(order, new Map(products.map((product) => [product.id, product])), purchase?.finalizedAt ?? null);
  }

  private async customerId(email: string): Promise<string | null> {
    const customer = await this.prisma.customer.findUnique({ where: { email: email.trim().toLowerCase() }, select: { id: true } });
    return customer?.id ?? null;
  }
}
