/**
 * Admin fulfillment contract (docs/api/admin-orders.md). The admin UI codes against exactly these shapes.
 * Nothing here carries customer wallet addresses; only email, name and the shipping address are customer data.
 */
export const ORDER_STATUSES = ['PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'] as const;
export type OrderStatusName = (typeof ORDER_STATUSES)[number];

export const CARRIERS = ['USPS', 'UPS', 'FedEx', 'DHL', 'OTHER'] as const;
export type CarrierName = (typeof CARRIERS)[number];

export const TRACKING_NUMBER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 -]*$/;
export const TRACKING_NUMBER_MIN = 4;
export const TRACKING_NUMBER_MAX = 64;
export const SHIP_NOTE_MAX = 500;
export const CANCEL_REASON_MAX = 500;
export const ORDER_NOTE_MAX = 1000;
export const SEARCH_QUERY_MAX = 100;

export const DEFAULT_LIST_LIMIT = 25;
export const MAX_LIST_LIMIT = 100;

export type AdminOrderAction = 'start-packing' | 'ship' | 'mark-delivered' | 'cancel' | 'refund' | 'add-note';

export const PAID_ORDER_CANCEL_MESSAGE = 'Paid orders are refunded through the refunds process, not cancelled.';

export interface AdminOrderSummary {
  id: string;
  status: OrderStatusName;
  /** Sum of the line prices; null for orders created before totals were stored. totalCents = subtotal + shipping + tax. */
  subtotalCents: number | null;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  currency: string;
  createdAt: string;
  customer: { id: string; email: string; name: string | null };
  /** Sum of line quantities. */
  itemCount: number;
  hasShipment: boolean;
  trackingNumber: string | null;
}

export interface AdminOrderItem {
  id: string;
  productId: string;
  sku: string;
  name: string;
  lotCode: string;
  quantity: number;
  unitCents: number;
}

export interface AdminOrderPayment {
  status: string;
  /** Decimal string of USDC base units. */
  amountAtomic: string;
  txSignature: string | null;
  network: string;
  finalizedAt: string | null;
}

export interface AdminOrderShipment {
  id: string;
  carrier: string;
  trackingNumber: string;
  shippedAt: string;
  deliveredAt: string | null;
  note: string | null;
}

export interface AdminOrderEvent {
  id: string;
  kind: 'STATUS' | 'NOTE';
  fromStatus: OrderStatusName | null;
  toStatus: OrderStatusName | null;
  note: string | null;
  adminName: string | null;
  createdAt: string;
}

/** The order's refund (docs/api/admin-refunds.md): the one in progress, else the latest one. Never carries a wallet address. */
export interface AdminOrderRefund {
  id: string;
  status: 'REQUESTED' | 'SUBMITTED' | 'FINALIZED' | 'FAILED';
  /** Decimal string of USDC base units. */
  amountAtomic: string;
  txSignature: string | null;
  requestedAt: string;
  failureReason: string | null;
}

export interface AdminOrderDetail extends AdminOrderSummary {
  shippingAddress: string | null;
  items: AdminOrderItem[];
  payment: AdminOrderPayment | null;
  shipments: AdminOrderShipment[];
  /** Oldest first. */
  events: AdminOrderEvent[];
  refund: AdminOrderRefund | null;
  allowedActions: AdminOrderAction[];
}

export interface AdminOrderPage {
  items: AdminOrderSummary[];
  nextCursor: string | null;
}

export type AdminOrderCounts = { counts: Record<OrderStatusName, number> };

/** What the guard resolved; the service only needs these for attribution. */
export interface AdminActor {
  id: string;
  ip: string | null;
}
