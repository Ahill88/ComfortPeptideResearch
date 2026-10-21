import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { OrderStatus, Prisma } from '@prisma/client';
import { INVENTORY_PORT, type InventoryPort } from '../../commerce/inventory.types';
import type { RefundOrderHook } from './refund-order-hook';

/** Order states in which nothing has left the building yet: only then does a refund put the stock back. */
const UNSHIPPED = new Set(['PAID', 'PROCESSING']);

/**
 * Effects of an order becoming REFUNDED (see RefundOrderHook):
 *  - a STATUS OrderEvent (fromStatus -> REFUNDED), written for every refund path (admin session routes and the admin-token routes);
 *  - for an UNSHIPPED order, InventoryPort.releaseForOrder in the same transaction (idempotent on the port side).
 * A shipped/delivered order is never restocked: the goods are with the customer.
 *
 * INVENTORY_PORT is optional so the refunds engine still works where no inventory implementation is bound; in that case the missing
 * release is logged loudly (the money has already moved on chain, so the refund is not blocked).
 */
@Injectable()
export class OrderRefundedEffects implements RefundOrderHook {
  private readonly logger = new Logger(OrderRefundedEffects.name);

  constructor(
    private readonly moduleRef: ModuleRef,
    @Optional() @Inject(INVENTORY_PORT) private readonly inventory?: InventoryPort,
  ) {}

  async onOrderRefunded(
    tx: Prisma.TransactionClient,
    info: { orderId: string; fromStatus: OrderStatus; refundId: string; txSignature: string | null },
  ): Promise<void> {
    await tx.orderEvent.create({
      data: { orderId: info.orderId, kind: 'STATUS', fromStatus: info.fromStatus, toStatus: 'REFUNDED', note: 'Refund finalized on chain.', adminId: null },
    });
    if (!UNSHIPPED.has(info.fromStatus)) return;
    const inventory = this.inventory ?? this.lookupInventory();
    if (!inventory) {
      this.logger.error(`No INVENTORY_PORT is bound: stock for refunded order ${info.orderId} was NOT released; adjust it manually`);
      return;
    }
    await inventory.releaseForOrder(tx, info.orderId, `refund:${info.refundId}`);
  }

  /** The port may live in a module this one does not import; resolve it application-wide at call time. */
  private lookupInventory(): InventoryPort | undefined {
    try {
      return this.moduleRef.get<InventoryPort>(INVENTORY_PORT, { strict: false }) ?? undefined;
    } catch {
      return undefined;
    }
  }
}
