import type { OrderStatus, Prisma } from '@prisma/client';

/**
 * Side effects of the single call that moves an order to REFUNDED. RefundsService invokes the hook INSIDE the transaction that
 * finalizes the refund and flips the order, so the order event and the stock release commit (or roll back) together with the status.
 * Unbound (as in the engine's unit tests) the engine simply flips the status.
 */
export const REFUND_ORDER_HOOK = Symbol('REFUND_ORDER_HOOK');

export interface RefundOrderHook {
  onOrderRefunded(
    tx: Prisma.TransactionClient,
    info: { orderId: string; fromStatus: OrderStatus; refundId: string; txSignature: string | null },
  ): Promise<void>;
}
