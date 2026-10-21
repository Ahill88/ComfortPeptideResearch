import type { Prisma } from '@prisma/client';

/** Inventory contract (docs/api/commerce-contract.md section 3). */
export const INVENTORY_PORT = Symbol('INVENTORY_PORT');
export interface InventoryPort {
  /** Puts every quantity reserved for the order back on hand. Idempotent (ORDER_RELEASE rows are unique per order/product; sets Order.inventoryReleasedAt). Must run inside the caller's transaction. */
  releaseForOrder(tx: Prisma.TransactionClient, orderId: string, reason: string): Promise<void>;
}
