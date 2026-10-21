// Types for the fixed admin API contract. The API returns these shapes; nothing here is invented client-side.
export type AdminRole = 'OWNER' | 'STAFF';

export interface AdminIdentity { id: string; email: string; name: string; role: AdminRole }
export interface SessionInfo { expiresAt: string; idleTimeoutSeconds: number }

export type OrderStatus = 'PENDING_PAYMENT' | 'PAID' | 'PROCESSING' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' | 'REFUNDED';
export const ORDER_STATUSES: readonly OrderStatus[] = ['PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'];

export type OrderCounts = Record<OrderStatus, number>;

export interface AdminOrderSummary {
  id: string;
  status: OrderStatus;
  totalCents: number;
  currency: string;
  createdAt: string;
  customer: { id: string; email: string; name: string | null };
  itemCount: number;
  hasShipment: boolean;
  trackingNumber: string | null;
}

export type OrderAction = 'start-packing' | 'ship' | 'mark-delivered' | 'cancel' | 'add-note';

export interface AdminOrderDetail extends AdminOrderSummary {
  shippingAddress: string | null;
  items: Array<{ id: string; productId: string; sku: string; name: string; lotCode: string | null; quantity: number; unitCents: number }>;
  payment: null | { status: string; amountAtomic: string; txSignature: string | null; network: string; finalizedAt: string | null };
  shipments: Array<{ id: string; carrier: string; trackingNumber: string; shippedAt: string; deliveredAt: string | null; note: string | null }>;
  events: Array<{ id: string; kind: 'STATUS' | 'NOTE'; fromStatus: OrderStatus | null; toStatus: OrderStatus | null; note: string | null; adminName: string | null; createdAt: string }>;
  allowedActions: OrderAction[];
}

export const CARRIERS = ['USPS', 'UPS', 'FedEx', 'DHL', 'OTHER'] as const;
export type Carrier = (typeof CARRIERS)[number];

export interface AdminUserRow { id: string; email: string; name: string; role: AdminRole; active: boolean; lastLoginAt: string | null; createdAt: string }
export interface CreatedAdmin { admin: AdminUserRow | AdminIdentity; temporaryPassword: string; mfa: { otpauthUri: string; seedBase32: string } }

export interface AuditRow {
  id: string;
  adminEmail: string | null;
  action: string;
  targetType: string;
  targetId: string;
  detail: unknown;
  ip: string | null;
  createdAt: string;
}
