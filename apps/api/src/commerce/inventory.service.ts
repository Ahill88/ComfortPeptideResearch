import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { INT32_MAX } from './commerce.config';
import type { InventoryPort } from './inventory.types';

export const OUT_OF_STOCK_CODE = 'OUT_OF_STOCK';
export const STOCK_BELOW_ZERO_MESSAGE = 'Adjustment would take stock below zero.';
export const STOCK_OVERFLOW_MESSAGE = 'Adjustment would exceed the maximum stock count.';
const LEDGER_REASON_MAX = 200;

export interface ReserveLine {
  productId: string;
  quantity: number;
}

/** 409 body exactly as in the contract: { code, message, productId, available }. */
export class OutOfStockException extends ConflictException {
  constructor(name: string, readonly productId: string, readonly available: number) {
    super({ code: OUT_OF_STOCK_CODE, message: `Insufficient stock for ${name}.`, productId, available });
  }
}

/**
 * Stock is Product.inventory: the units still SELLABLE. A reservation takes units out of it immediately, so reserved
 * units are no longer counted there; releasing puts them back. Every movement writes an InventoryAdjustment ledger row.
 *
 * Every method takes the caller's transaction client: reserve/release are only correct inside the transaction that
 * creates/cancels the order, so a failure anywhere rolls back every stock change with it.
 */
@Injectable()
export class InventoryService implements InventoryPort {
  /**
   * Reserves stock for every line of a just-created order. Quantities are summed per product (two lots of one product are
   * one stock pool) and products are processed in ascending id order, so two concurrent orders that list the same products
   * in opposite order take their row locks in the same sequence and cannot deadlock. Each product is one conditional
   * statement (`UPDATE "Product" SET inventory = inventory - q WHERE id = $1 AND inventory >= q`): under concurrency the
   * database serialises on the row, so stock can never go negative and the total sold can never exceed what was there.
   * The first product that cannot be covered throws OutOfStockException; the caller's transaction then rolls back every
   * earlier reservation of this order.
   */
  async reserveForOrder(tx: Prisma.TransactionClient, orderId: string, lines: ReserveLine[]): Promise<void> {
    const perProduct = new Map<string, number>();
    for (const line of lines) perProduct.set(line.productId, (perProduct.get(line.productId) ?? 0) + line.quantity);
    const ordered = [...perProduct.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [productId, quantity] of ordered) {
      const taken = await tx.product.updateMany({ where: { id: productId, inventory: { gte: quantity } }, data: { inventory: { decrement: quantity } } });
      if (taken.count !== 1) {
        const product = await tx.product.findUnique({ where: { id: productId }, select: { name: true, inventory: true } });
        throw new OutOfStockException(product?.name ?? 'this product', productId, Math.max(0, product?.inventory ?? 0));
      }
      await tx.inventoryAdjustment.create({ data: { productId, delta: -quantity, kind: 'ORDER_RESERVE', orderId, reason: null } });
    }
  }

  /**
   * Idempotent. The claim on Order.inventoryReleasedAt is a conditional update, so exactly one caller proceeds even if a
   * sweep, an admin cancel and a refund race; the unique (orderId, productId, kind) on the ledger is the second guard.
   * Only quantities that have an ORDER_RESERVE row are returned (an order created before stock holds existed has none,
   * so nothing is invented for it).
   */
  async releaseForOrder(tx: Prisma.TransactionClient, orderId: string, reason: string): Promise<void> {
    const claim = await tx.order.updateMany({ where: { id: orderId, inventoryReleasedAt: null }, data: { inventoryReleasedAt: new Date() } });
    if (claim.count !== 1) return;
    const reserved = await tx.inventoryAdjustment.findMany({ where: { orderId, kind: 'ORDER_RESERVE' }, select: { productId: true, delta: true } });
    const ordered = [...reserved].sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));
    for (const row of ordered) {
      const quantity = -row.delta;
      if (quantity <= 0) continue;
      const inserted = await tx.inventoryAdjustment.createMany({
        data: [{ productId: row.productId, delta: quantity, kind: 'ORDER_RELEASE', orderId, reason: reason.slice(0, LEDGER_REASON_MAX) }],
        skipDuplicates: true,
      });
      if (inserted.count === 1) {
        await tx.product.updateMany({ where: { id: row.productId }, data: { inventory: { increment: quantity } } });
      }
    }
  }

  /**
   * Manual stock correction (admin). One conditional update, so the result can never be negative or overflow, and one
   * ledger row. Returns the stock after the change.
   */
  async adjust(tx: Prisma.TransactionClient, input: { productId: string; delta: number; reason: string; adminId: string | null }): Promise<number> {
    const { productId, delta } = input;
    const where: Prisma.ProductWhereInput = delta < 0 ? { id: productId, inventory: { gte: -delta } } : { id: productId, inventory: { lte: INT32_MAX - delta } };
    const changed = await tx.product.updateMany({ where, data: { inventory: { increment: delta } } });
    if (changed.count !== 1) {
      const product = await tx.product.findUnique({ where: { id: productId }, select: { id: true } });
      if (!product) throw new NotFoundException('Product not found.');
      throw new ConflictException(delta < 0 ? STOCK_BELOW_ZERO_MESSAGE : STOCK_OVERFLOW_MESSAGE);
    }
    await tx.inventoryAdjustment.create({
      data: { productId, delta, kind: 'ADMIN_ADJUST', reason: input.reason.slice(0, LEDGER_REASON_MAX), adminId: input.adminId },
    });
    const after = await tx.product.findUnique({ where: { id: productId }, select: { inventory: true } });
    return after?.inventory ?? 0;
  }
}
