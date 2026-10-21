import { ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { OrderStatus } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { centsToAtomic } from '../../wallet/contracts';
import { KeyedLock } from '../../wallet/checkout/checkout.util';
import { RefundsService } from '../../wallet/refunds/refunds.service';
import { AdminAuditService } from '../admin-audit.service';
import {
  ACTIVE_REFUND_STATUSES,
  REFUNDABLE_ORDER_STATUSES,
  currentRefund,
  loadRefundRows,
  type RefundRow,
} from './admin-order-refund.view';
import { AdminOrdersService } from './admin-orders.service';
import type { AdminActor, AdminOrderDetail } from './admin-orders.types';

export const REFUND_SIGNING_UNAVAILABLE_MESSAGE = 'Refund signing is not available.';
export const SHIPPED_REFUND_MESSAGE = 'Shipped orders cannot be refunded here.';
export const REFUND_ALREADY_REQUESTED_MESSAGE = 'A refund is already in progress for this order.';
export const NO_REFUND_MESSAGE = 'No refund has been requested for this order.';
export const WALLET_MISMATCH_MESSAGE = "The customer's linked wallet is not the wallet that paid; the refund needs manual review.";

/**
 * Owner-facing refund workflow for an order (docs/api/admin-refunds.md). It adds NO money logic: every step delegates to RefundsService
 * (request builds the refund row, submit asks the bound merchant signer and broadcasts, verify re-reads the chain and finalizes). This class
 * only decides WHEN the owner may call those steps, never accepts a destination or an amount, and records the audit trail.
 *
 *  - Amount: always the exact paid amount (the order total), never client input.
 *  - Destination: never client input. The engine derives it from the order's finalized purchase (the wallet the customer paid from);
 *    this service additionally requires that wallet to be the customer's currently linked wallet.
 *  - One refund at a time per order; SHIPPED/DELIVERED orders are refused (409).
 */
@Injectable()
export class AdminOrderRefundService {
  private readonly logger = new Logger(AdminOrderRefundService.name);
  private readonly locks = new KeyedLock();

  constructor(
    private readonly prisma: PrismaService,
    private readonly refunds: RefundsService,
    private readonly audit: AdminAuditService,
    private readonly orders: AdminOrdersService,
  ) {}

  /** POST /admin/orders/:id/refund */
  async request(orderId: string, reason: string, actor: AdminActor): Promise<AdminOrderDetail> {
    return this.locks.run(`order:${orderId}`, async () => {
      const order = await this.loadRefundableOrder(orderId);
      const rows = await loadRefundRows(this.prisma, orderId);
      if (rows.some((row) => isActive(row))) throw new ConflictException(REFUND_ALREADY_REQUESTED_MESSAGE);
      await this.assertPayerIsLinkedWallet(order.customerId, orderId);
      const refund = await this.refunds.requestRefund(orderId, centsToAtomic(order.totalCents), reason, actor.id);
      await this.record(actor, 'order.refund.request', orderId, { refundId: refund.refundId, amountAtomic: refund.amountAtomic, orderStatus: order.status });
      return this.orders.detail(orderId);
    });
  }

  /** POST /admin/orders/:id/refund/submit: idempotent; a second call never signs or broadcasts again. */
  async submit(orderId: string, actor: AdminActor): Promise<AdminOrderDetail> {
    return this.locks.run(`order:${orderId}`, async () => {
      if (!this.refunds.isSigningAvailable()) throw new ServiceUnavailableException(REFUND_SIGNING_UNAVAILABLE_MESSAGE);
      const order = await this.loadRefundableOrder(orderId);
      const row = currentRefund(await loadRefundRows(this.prisma, orderId));
      if (!row || !isActive(row)) throw new ConflictException(NO_REFUND_MESSAGE);
      if (row.status !== 'PREPARED') return this.orders.detail(orderId); // already SUBMITTED/CONFIRMED: nothing to do
      await this.assertPayerIsLinkedWallet(order.customerId, orderId, row);
      const submitted = await this.refunds.prepareAndSubmit(row.id);
      await this.record(actor, 'order.refund.submit', orderId, { refundId: submitted.refundId, txSignature: submitted.txSignature, amountAtomic: submitted.amountAtomic });
      return this.orders.detail(orderId);
    });
  }

  /** POST /admin/orders/:id/refund/verify: re-reads the chain. Idempotent; on FINALIZED the engine flips the order and releases stock. */
  async verify(orderId: string, actor: AdminActor): Promise<AdminOrderDetail> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { id: true } });
    if (!order) throw new NotFoundException('Order not found.');
    const row = currentRefund(await loadRefundRows(this.prisma, orderId));
    if (!row) throw new ConflictException(NO_REFUND_MESSAGE);
    const result = await this.refunds.verifyRefund(row.id);
    if (result.outcome === 'FINALIZED' || result.outcome === 'FAILED') {
      await this.record(actor, 'order.refund.verify', orderId, {
        refundId: row.id,
        outcome: result.outcome,
        orderRefunded: result.orderRefunded,
        txSignature: result.refund.txSignature,
      });
    }
    return this.orders.detail(orderId);
  }

  private async loadRefundableOrder(orderId: string): Promise<{ id: string; status: OrderStatus; customerId: string; totalCents: number }> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { id: true, status: true, customerId: true, totalCents: true } });
    if (!order) throw new NotFoundException('Order not found.');
    if (order.status === 'SHIPPED' || order.status === 'DELIVERED') throw new ConflictException(SHIPPED_REFUND_MESSAGE);
    if (!REFUNDABLE_ORDER_STATUSES.includes(order.status)) throw new ConflictException(`Order is ${order.status}; cannot refund.`);
    return order;
  }

  /**
   * The engine pays the wallet the customer paid from. Here that wallet must still be the customer's own linked wallet, so a refund can
   * never go anywhere the customer has not proven control of. Fails closed when the customer has no linked wallet.
   */
  private async assertPayerIsLinkedWallet(customerId: string, orderId: string, row?: RefundRow): Promise<void> {
    const wallet = await this.prisma.customerWallet.findUnique({ where: { customerId }, select: { address: true } });
    let payer = row?.destinationAddress;
    if (!payer) {
      const purchases = await this.prisma.cryptoTransaction.findMany({ where: { orderId, type: 'PURCHASE', status: 'FINALIZED' }, select: { sourceAddress: true } });
      if (purchases.length !== 1) return; // zero or several purchases: the engine refuses with its own precise message
      payer = purchases[0].sourceAddress;
    }
    if (!wallet || wallet.address !== payer) {
      this.logger.warn(`Refund refused for order ${orderId}: the paying wallet is not the customer's linked wallet`);
      throw new ConflictException(WALLET_MISMATCH_MESSAGE);
    }
  }

  /** The money step has already happened when this runs, so an audit failure must not turn it into an error the owner would retry. */
  private async record(actor: AdminActor, action: string, orderId: string, detail: Record<string, unknown>): Promise<void> {
    try {
      await this.audit.record({ adminId: actor.id, action, targetType: 'order', targetId: orderId, detail, ip: actor.ip });
    } catch (error) {
      this.logger.error(`Audit write failed for ${action} on order ${orderId}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
}

function isActive(row: RefundRow): boolean {
  return (ACTIVE_REFUND_STATUSES as readonly string[]).includes(row.status);
}
