import { ConflictException } from '@nestjs/common';
import type { OrderStatus, Prisma } from '@prisma/client';
import type { AdminOrderAction, AdminOrderRefund } from './admin-orders.types';

/**
 * Read-side helpers for the order refund (docs/api/admin-refunds.md). Kept out of admin-orders.service.ts so that file only needs two
 * small calls into here. Nothing in this file writes money state.
 */

/** CryptoTransaction (type REFUND) statuses that count as "a refund exists / is in progress" (FAILED and EXPIRED free the order). */
export const ACTIVE_REFUND_STATUSES = ['PREPARED', 'SUBMITTED', 'CONFIRMED', 'FINALIZED'] as const;
/** Statuses where a signed transfer may already be on its way to the customer: the order must not move on (pack / ship) meanwhile. */
export const IN_FLIGHT_REFUND_STATUSES = ['SUBMITTED', 'CONFIRMED'] as const;
/** The only order states from which the owner may refund here. */
export const REFUNDABLE_ORDER_STATUSES: readonly OrderStatus[] = ['PAID', 'PROCESSING'];

export const REFUND_IN_PROGRESS_MESSAGE = 'A refund is in progress for this order.';

export interface RefundRow {
  id: string;
  status: string;
  amountAtomic: bigint;
  txSignature: string | null;
  failureReason: string | null;
  destinationAddress: string;
  createdAt: Date;
}

export const REFUND_ROW_SELECT = {
  id: true,
  status: true,
  amountAtomic: true,
  txSignature: true,
  failureReason: true,
  destinationAddress: true,
  createdAt: true,
} satisfies Prisma.CryptoTransactionSelect;

type RefundReader = Pick<Prisma.TransactionClient, 'cryptoTransaction'>;

export async function loadRefundRows(client: RefundReader, orderId: string): Promise<RefundRow[]> {
  return client.cryptoTransaction.findMany({ where: { orderId, type: 'REFUND' }, select: REFUND_ROW_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
}

/** The refund to show and act on: an active one if any (there is at most one), otherwise the newest (a FAILED one), otherwise none. */
export function currentRefund(rows: RefundRow[]): RefundRow | null {
  const active = rows.filter((row) => (ACTIVE_REFUND_STATUSES as readonly string[]).includes(row.status));
  const pool = active.length > 0 ? active : rows;
  return pool.length > 0 ? pool[pool.length - 1] : null;
}

export function toAdminRefund(row: RefundRow | null): AdminOrderRefund | null {
  if (!row) return null;
  const status = row.status === 'PREPARED' ? 'REQUESTED' : row.status === 'SUBMITTED' || row.status === 'CONFIRMED' ? 'SUBMITTED' : row.status === 'FINALIZED' ? 'FINALIZED' : 'FAILED';
  return {
    id: row.id,
    status,
    amountAtomic: row.amountAtomic.toString(),
    txSignature: row.txSignature ?? null,
    requestedAt: row.createdAt.toISOString(),
    failureReason: row.failureReason ?? null,
  };
}

/** `refund` is offered on PAID/PROCESSING orders that have no refund in progress; it sits just before 'add-note'. */
export function withRefundAction(actions: AdminOrderAction[], status: OrderStatus, rows: RefundRow[]): AdminOrderAction[] {
  if (!REFUNDABLE_ORDER_STATUSES.includes(status) || currentRefundIsActive(rows)) return actions;
  const index = actions.indexOf('add-note');
  return index < 0 ? [...actions, 'refund'] : [...actions.slice(0, index), 'refund', ...actions.slice(index)];
}

export function currentRefundIsActive(rows: RefundRow[]): boolean {
  return rows.some((row) => (ACTIVE_REFUND_STATUSES as readonly string[]).includes(row.status));
}

/**
 * Called inside the transaction of a PAID -> PROCESSING or PROCESSING -> SHIPPED flip: an order whose refund has been submitted must not
 * be packed or shipped. The status flip has already taken the order's row lock, so a refund submit racing with it is serialised
 * (see RefundsService: its claim touches the order row first).
 */
export async function assertNoRefundInFlight(tx: RefundReader, orderId: string): Promise<void> {
  const rows = await tx.cryptoTransaction.findMany({ where: { orderId, type: 'REFUND', status: { in: [...IN_FLIGHT_REFUND_STATUSES] } }, select: { id: true } });
  if (rows.length > 0) throw new ConflictException(REFUND_IN_PROGRESS_MESSAGE);
}
