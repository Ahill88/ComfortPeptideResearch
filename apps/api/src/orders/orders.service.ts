import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma.service';

type Line = { productId: string; lotCode: string; quantity: number };
type CreateOrderInput = {
  email: string;
  shippingAddress: string;
  items: Line[];
  researchUseAcknowledged: boolean;
  idempotencyKey: string;
};

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
/** PostgreSQL INT4 maximum: Order.totalCents, OrderItem.quantity and unitCents are all Int columns. */
export const INT32_MAX = 2_147_483_647;
export const MAX_QUANTITY_PER_LINE = 1000;
export const MAX_ORDER_LINES = 50;
/** The customer types the address as free text; we only require it to be present (after trimming) and bounded. */
export const MAX_SHIPPING_ADDRESS_LENGTH = 500;
export const IDEMPOTENCY_CONFLICT_MESSAGE = 'Idempotency key was already used with a different request';

/** Same normalization as WalletService.resolveCustomer so one email maps to one Customer everywhere. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Stable SHA-256 over the canonical JSON of the request: email lowercased, shipping address, acknowledgement and
 * line items sorted by productId then lotCode. Property order is fixed by construction, so the hash does not depend
 * on the key order or line order the client happened to send.
 */
export function computeRequestHash(input: Pick<CreateOrderInput, 'email' | 'shippingAddress' | 'researchUseAcknowledged' | 'items'>): string {
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const items = input.items
    .map((item) => ({ productId: item.productId, lotCode: item.lotCode, quantity: item.quantity }))
    .sort((a, b) => compare(a.productId, b.productId) || compare(a.lotCode, b.lotCode) || a.quantity - b.quantity);
  const canonical = JSON.stringify({
    email: normalizeEmail(input.email),
    shippingAddress: input.shippingAddress,
    researchUseAcknowledged: input.researchUseAcknowledged,
    items,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

type OrderRow = {
  id: string;
  customerId: string;
  status: string;
  totalCents: number;
  currency: string;
  researchAcknowledgedAt: Date | null;
  createdAt: Date;
  items: Array<{ id: string; orderId: string; productId: string; lotCode: string; quantity: number; unitCents: number }>;
};

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateOrderInput) {
    this.validate(input);
    const email = normalizeEmail(input.email);
    const requestHash = computeRequestHash({ ...input, email });

    // Replays are resolved strictly inside the (customerId, idempotencyKey) scope. Another customer's order that
    // happens to use the same key is never read, so nothing about it can be disclosed or returned.
    const knownCustomer = await this.prisma.customer.findUnique({ where: { email } });
    if (knownCustomer) {
      const replay = await this.findReplay(knownCustomer.id, input.idempotencyKey, requestHash);
      if (replay) return replay;
    }

    const productIds = [...new Set(input.items.map((item) => item.productId))];
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds }, active: true },
      include: { lots: true },
    });
    if (products.length !== productIds.length) {
      throw new BadRequestException('Unavailable product in order');
    }

    const total = input.items.reduce((sum, item) => {
      const product = products.find((candidate) => candidate.id === item.productId)!;
      if (!product.lots.some((lot) => lot.code === item.lotCode)) {
        throw new BadRequestException('Invalid lot');
      }
      return sum + product.priceCents * item.quantity;
    }, 0);
    if (!Number.isSafeInteger(total) || total > INT32_MAX) {
      throw new BadRequestException('Order total is too large');
    }

    const customer = knownCustomer ?? (await this.resolveCustomer(email));
    try {
      const order = await this.prisma.order.create({
        data: {
          customerId: customer.id,
          idempotencyKey: input.idempotencyKey,
          requestHash,
          // Stored trimmed for the person packing the parcel. The requestHash above is deliberately computed from the
          // address exactly as sent, so idempotency semantics are unchanged.
          shippingAddress: input.shippingAddress.trim(),
          totalCents: total,
          researchAcknowledgedAt: new Date(),
          items: {
            create: input.items.map((item) => ({
              ...item,
              unitCents: products.find((product) => product.id === item.productId)!.priceCents,
            })),
          },
        },
        include: { items: true },
      });
      return this.toResponse(order);
    } catch (error: unknown) {
      if (this.isUniqueConstraintError(error)) {
        // A concurrent request with the same (customerId, key) won the race: return its order (or 409 on mismatch).
        const replay = await this.findReplay(customer.id, input.idempotencyKey, requestHash);
        if (replay) return replay;
      }
      throw error;
    }
  }

  private validate(input: CreateOrderInput): void {
    if (!Array.isArray(input.items) || !input.items.length) {
      throw new BadRequestException('An order requires at least one item');
    }
    if (input.items.length > MAX_ORDER_LINES) {
      throw new BadRequestException(`An order may contain at most ${MAX_ORDER_LINES} lines`);
    }
    if (input.researchUseAcknowledged !== true) {
      throw new BadRequestException('Research-use acknowledgement is required');
    }
    if (typeof input.email !== 'string' || !normalizeEmail(input.email)) {
      throw new BadRequestException('A valid email is required');
    }
    if (typeof input.shippingAddress !== 'string' || !input.shippingAddress.trim()) {
      throw new BadRequestException('A shipping address is required');
    }
    if (input.shippingAddress.trim().length > MAX_SHIPPING_ADDRESS_LENGTH) {
      throw new BadRequestException(`Shipping address must be at most ${MAX_SHIPPING_ADDRESS_LENGTH} characters`);
    }
    if (typeof input.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) {
      throw new BadRequestException(
        'Idempotency key must be 8-128 characters and contain only letters, numbers, periods, underscores, or hyphens',
      );
    }
    for (const item of input.items) {
      if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QUANTITY_PER_LINE) {
        throw new BadRequestException(`Quantity must be a whole number between 1 and ${MAX_QUANTITY_PER_LINE}`);
      }
    }
  }

  private async findReplay(customerId: string, idempotencyKey: string, requestHash: string) {
    const existing = await this.prisma.order.findUnique({
      where: { customerId_idempotencyKey: { customerId, idempotencyKey } },
      include: { items: true },
    });
    if (!existing) return null;
    if (existing.requestHash !== requestHash) {
      throw new ConflictException(IDEMPOTENCY_CONFLICT_MESSAGE);
    }
    return this.toResponse(existing);
  }

  /** find-or-create by normalized email, tolerant of a concurrent creator (unique Customer.email). */
  private async resolveCustomer(email: string) {
    const existing = await this.prisma.customer.findUnique({ where: { email } });
    if (existing) return existing;
    try {
      return await this.prisma.customer.create({ data: { email } });
    } catch (error: unknown) {
      if (this.isUniqueConstraintError(error)) {
        const raced = await this.prisma.customer.findUnique({ where: { email } });
        if (raced) return raced;
      }
      throw error;
    }
  }

  /** Public shape only: never expose the idempotency key bookkeeping (requestHash) in responses. */
  private toResponse(order: OrderRow) {
    return {
      id: order.id,
      customerId: order.customerId,
      status: order.status,
      totalCents: order.totalCents,
      currency: order.currency,
      researchAcknowledgedAt: order.researchAcknowledgedAt,
      createdAt: order.createdAt,
      items: order.items.map((item) => ({
        id: item.id,
        orderId: item.orderId,
        productId: item.productId,
        lotCode: item.lotCode,
        quantity: item.quantity,
        unitCents: item.unitCents,
      })),
    };
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
  }
}
