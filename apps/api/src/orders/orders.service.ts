import { BadRequestException, ConflictException, Inject, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isPublishedCoaRequired, lotsWithPublishedCoa } from '../coa/coa-requirement';
import { COMMERCE_CONFIG, INT32_MAX as COMMERCE_INT32_MAX, loadCommerceConfig, type CommerceConfig } from '../commerce/commerce.config';
import { InventoryService } from '../commerce/inventory.service';
import { OrderTotalTooLargeError, ShippingTaxCalculator, type OrderTotals } from '../commerce/shipping-tax.calculator';
import { isNonProductionRuntime } from '../config/runtime';
import { PrismaService } from '../prisma.service';

type Line = { productId: string; lotCode: string; quantity: number };
/** The signed-in customer resolved by the shared identity resolver (see order-identity.ts). `customerId` is set when the resolver already knows the row. */
export type OrderIdentity = { email: string; customerId?: string };
type CreateOrderInput = {
  /** Required when there is no identity. With an identity it may be omitted; if present it must match the identity's email. */
  email?: string;
  shippingAddress: string;
  items: Line[];
  researchUseAcknowledged: boolean;
  idempotencyKey: string;
  identity?: OrderIdentity | null;
};
export type QuoteUnavailableReason = 'out_of_stock' | 'inactive' | 'unknown_lot';
export interface OrderQuote extends OrderTotals {
  currency: 'USD';
  lines: Array<{ productId: string; lotCode: string; quantity: number; unitCents: number; lineCents: number }>;
  unavailable: Array<{ productId: string; reason: QuoteUnavailableReason; available: number | null }>;
}

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
/** PostgreSQL INT4 maximum: Order.totalCents, OrderItem.quantity and unitCents are all Int columns. */
export const INT32_MAX = COMMERCE_INT32_MAX;
export const ORDER_TOTAL_TOO_LARGE_MESSAGE = 'Order total is too large';
export const EMAIL_MISMATCH_MESSAGE = 'The email must match the signed-in account.';
export const SIGN_IN_REQUIRED_MESSAGE = 'Sign in to place an order.';
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
export function computeRequestHash(input: Pick<CreateOrderInput, 'shippingAddress' | 'researchUseAcknowledged' | 'items'> & { email: string }): string {
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
  subtotalCents?: number | null;
  shippingCents?: number;
  taxCents?: number;
  currency: string;
  researchAcknowledgedAt: Date | null;
  createdAt: Date;
  items: Array<{ id: string; orderId: string; productId: string; lotCode: string; quantity: number; unitCents: number }>;
};

@Injectable()
export class OrdersService {
  private readonly inventory: InventoryService;
  private readonly calculator: ShippingTaxCalculator;
  private readonly holdMinutes: number;

  // The three commerce dependencies are optional (and default to the real implementations built from the environment) so
  // `new OrdersService(prisma)` keeps working in unit tests; in the application CommerceModule always provides them.
  constructor(
    private readonly prisma: PrismaService,
    @Optional() inventory?: InventoryService,
    @Optional() calculator?: ShippingTaxCalculator,
    @Optional() @Inject(COMMERCE_CONFIG) config?: CommerceConfig,
  ) {
    const resolved = config ?? loadCommerceConfig();
    this.inventory = inventory ?? new InventoryService();
    this.calculator = calculator ?? new ShippingTaxCalculator(resolved);
    this.holdMinutes = resolved.holdMinutes;
  }

  /**
   * Public price preview. Same pricing, lot, COA and stock rules as create(), but nothing is reserved or written. Lines that
   * cannot be bought are reported in `unavailable` instead of failing the request; lines that exist (active product, known
   * lot) are priced and counted in the totals even when stock is short, so the customer sees what the order would cost.
   */
  async quote(input: { items: Line[] }): Promise<OrderQuote> {
    this.validateLines(input.items);
    const productIds = [...new Set(input.items.map((item) => item.productId))];
    const products = await this.prisma.product.findMany({ where: { id: { in: productIds } }, include: { lots: true } });
    const byId = new Map(products.map((product) => [product.id, product]));
    const published = isPublishedCoaRequired() ? await lotsWithPublishedCoa(this.prisma, input.items.map((item) => item.lotCode)) : null;

    const unavailable: OrderQuote['unavailable'] = [];
    const flag = (productId: string, reason: QuoteUnavailableReason, available: number | null) => {
      if (!unavailable.some((entry) => entry.productId === productId && entry.reason === reason)) unavailable.push({ productId, reason, available });
    };
    const lines: OrderQuote['lines'] = [];
    for (const item of input.items) {
      const product = byId.get(item.productId);
      // An unknown id is reported exactly like an inactive product: nothing is revealed about which ids exist.
      if (!product || !product.active) {
        flag(item.productId, 'inactive', null);
        continue;
      }
      if (!product.lots.some((lot) => lot.code === item.lotCode) || (published && !published.has(item.lotCode))) {
        flag(item.productId, 'unknown_lot', null);
        continue;
      }
      lines.push({ productId: item.productId, lotCode: item.lotCode, quantity: item.quantity, unitCents: product.priceCents, lineCents: product.priceCents * item.quantity });
    }
    const wanted = new Map<string, number>();
    for (const line of lines) wanted.set(line.productId, (wanted.get(line.productId) ?? 0) + line.quantity);
    for (const [productId, quantity] of wanted) {
      const stock = Math.max(0, byId.get(productId)!.inventory);
      if (quantity > stock) flag(productId, 'out_of_stock', stock);
    }

    const totals = lines.length ? this.totalsFor(lines.reduce((sum, line) => sum + line.lineCents, 0)) : { subtotalCents: 0, shippingCents: 0, taxCents: 0, totalCents: 0 };
    return { currency: 'USD', ...totals, lines, unavailable };
  }

  async create(input: CreateOrderInput) {
    const identity = input.identity ?? null;
    // Fail closed: a production-like runtime never takes an anonymous, body-email order.
    if (!identity && !isNonProductionRuntime()) throw new UnauthorizedException(SIGN_IN_REQUIRED_MESSAGE);
    this.validate(input);
    const email = this.resolveEmail(input, identity);
    // The hash covers only what the customer sent (email, address, acknowledgement, lines). Totals, shipping and tax settings,
    // stock and the clock are deliberately NOT in it, so a replay after a price/shipping/env change still returns the original order.
    const requestHash = computeRequestHash({ ...input, email });

    // Replays are resolved strictly inside the (customerId, idempotencyKey) scope. Another customer's order that
    // happens to use the same key is never read, so nothing about it can be disclosed or returned.
    const knownCustomer = identity?.customerId
      ? { id: identity.customerId }
      : await this.prisma.customer.findUnique({ where: { email } });
    if (knownCustomer) {
      // A replay returns the stored order as it was: it never reserves stock again.
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

    const subtotal = input.items.reduce((sum, item) => {
      const product = products.find((candidate) => candidate.id === item.productId)!;
      if (!product.lots.some((lot) => lot.code === item.lotCode)) {
        throw new BadRequestException('Invalid lot');
      }
      return sum + product.priceCents * item.quantity;
    }, 0);
    const totals = this.totalsFor(subtotal);

    // REQUIRE_PUBLISHED_COA=true: every ordered lot must currently have a PUBLISHED COA (same check the catalog uses).
    if (isPublishedCoaRequired()) {
      const published = await lotsWithPublishedCoa(this.prisma, input.items.map((item) => item.lotCode));
      if (input.items.some((item) => !published.has(item.lotCode))) {
        throw new BadRequestException('Unavailable product in order');
      }
    }

    const customer = knownCustomer ?? (await this.resolveCustomer(email));
    const expiresAt = new Date(Date.now() + this.holdMinutes * 60_000);
    try {
      // One transaction: the order row, every line and every stock reservation commit together or not at all. The order is
      // inserted first so a lost idempotency race (P2002) fails before any stock is touched.
      const order = await this.prisma.$transaction(
        async (tx) => {
          const created = await tx.order.create({
            data: {
              customerId: customer.id,
              idempotencyKey: input.idempotencyKey,
              requestHash,
              // Stored trimmed for the person packing the parcel. The requestHash above is deliberately computed from the
              // address exactly as sent, so idempotency semantics are unchanged.
              shippingAddress: input.shippingAddress.trim(),
              subtotalCents: totals.subtotalCents,
              shippingCents: totals.shippingCents,
              taxCents: totals.taxCents,
              totalCents: totals.totalCents,
              expiresAt,
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
          await this.inventory.reserveForOrder(tx, created.id, input.items);
          return created;
        },
        // Parallel orders for one hot product queue on its row lock; give them room instead of the 2s/5s defaults.
        { maxWait: 15_000, timeout: 30_000 },
      );
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

  private totalsFor(subtotalCents: number): OrderTotals {
    try {
      return this.calculator.compute(subtotalCents);
    } catch (error) {
      if (error instanceof OrderTotalTooLargeError) throw new BadRequestException(ORDER_TOTAL_TOO_LARGE_MESSAGE);
      throw error;
    }
  }

  /** The order email: the signed-in customer's when there is one (a different body email is a 400), else the body email. */
  private resolveEmail(input: CreateOrderInput, identity: OrderIdentity | null): string {
    if (!identity) return normalizeEmail(input.email as string);
    const own = normalizeEmail(identity.email);
    if (typeof input.email === 'string' && input.email.trim() && normalizeEmail(input.email) !== own) {
      throw new BadRequestException(EMAIL_MISMATCH_MESSAGE);
    }
    return own;
  }

  private validateLines(items: Line[]): void {
    this.assertLineCount(items);
    this.assertQuantities(items);
  }

  private assertLineCount(items: Line[]): void {
    if (!Array.isArray(items) || !items.length) {
      throw new BadRequestException('An order requires at least one item');
    }
    if (items.length > MAX_ORDER_LINES) {
      throw new BadRequestException(`An order may contain at most ${MAX_ORDER_LINES} lines`);
    }
  }

  private assertQuantities(items: Line[]): void {
    for (const item of items) {
      if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QUANTITY_PER_LINE) {
        throw new BadRequestException(`Quantity must be a whole number between 1 and ${MAX_QUANTITY_PER_LINE}`);
      }
    }
  }

  private validate(input: CreateOrderInput): void {
    this.assertLineCount(input.items);
    if (input.researchUseAcknowledged !== true) {
      throw new BadRequestException('Research-use acknowledgement is required');
    }
    if (!input.identity && (typeof input.email !== 'string' || !normalizeEmail(input.email))) {
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
    this.assertQuantities(input.items);
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
      subtotalCents: order.subtotalCents ?? null,
      shippingCents: order.shippingCents ?? 0,
      taxCents: order.taxCents ?? 0,
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
