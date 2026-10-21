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
  subtotalCents: number | null;
  shippingCents: number;
  taxCents: number;
  currency: string;
  createdAt: string;
  customer: { id: string; email: string; name: string | null };
  itemCount: number;
  hasShipment: boolean;
  trackingNumber: string | null;
}

export type OrderAction = 'start-packing' | 'ship' | 'mark-delivered' | 'cancel' | 'refund' | 'add-note';

export interface AdminOrderRefund {
  id: string; status: 'REQUESTED' | 'SUBMITTED' | 'FINALIZED' | 'FAILED'; amountAtomic: string;
  txSignature: string | null; requestedAt: string; failureReason: string | null;
}

export interface AdminOrderDetail extends AdminOrderSummary {
  shippingAddress: string | null;
  items: Array<{ id: string; productId: string; sku: string; name: string; lotCode: string | null; quantity: number; unitCents: number }>;
  payment: null | { status: string; amountAtomic: string; txSignature: string | null; network: string; finalizedAt: string | null };
  shipments: Array<{ id: string; carrier: string; trackingNumber: string; shippedAt: string; deliveredAt: string | null; note: string | null }>;
  events: Array<{ id: string; kind: 'STATUS' | 'NOTE'; fromStatus: OrderStatus | null; toStatus: OrderStatus | null; note: string | null; adminName: string | null; createdAt: string }>;
  allowedActions: OrderAction[];
  refund: AdminOrderRefund | null;
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

// ---- Lots and certificates of analysis (docs/api/coa-contract.md, ADMIN API)
export type CoaListStatus = 'none' | 'draft' | 'published' | 'revoked';
export type AnchorListStatus = 'none' | 'pending' | 'confirmed' | 'failed';
export type CoaStatus = 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED' | 'REVOKED';
export type AnchorStatus = 'PENDING' | 'CONFIRMED' | 'FAILED';
export type AnchorKind = 'PUBLISH' | 'REVOKE';

export interface AdminProduct {
  id: string; sku: string; slug: string; name: string; active: boolean; priceCents: number; inventory: number;
  lotCount: number; publishedCoaLotCount: number;
}

export interface AdminLotSummary {
  id: string; code: string; productId: string; productName: string; productSku: string; releasedAt: string | null;
  currentCoaVersion: number | null; coaStatus: CoaListStatus; anchorStatus: AnchorListStatus;
}

export interface AdminAnchor {
  status: AnchorStatus; network: string; txSignature: string | null; slot: number | null; blockTime: string | null;
  attempts: number; error: string | null; memo: string; explorerUrl: string | null;
}

export interface AdminCoa {
  id: string; lotId: string; version: number; status: CoaStatus;
  labName: string; labReportId: string; testedAt: string; method: string; purityPercent: number; notes: string | null;
  file: { name: string; sizeBytes: number; sha256: string };
  createdBy: { name: string } | null; createdAt: string;
  publishedBy: { name: string } | null; publishedAt: string | null;
  revokedBy: { name: string } | null; revokedAt: string | null; revokeReason: string | null;
  anchors: { publish: AdminAnchor | null; revoke: AdminAnchor | null };
}

export interface AdminLotDetail { lot: AdminLotSummary; coas: AdminCoa[] }

export interface Page<T> { items: T[]; nextCursor: string | null }
export interface InventoryItem {
  productId: string; sku: string; name: string; active: boolean;
  /** Already sellable: unpaid reservations have been deducted. */
  onHand: number; reserved: number; lowStockThreshold: number | null; lowStock: boolean;
}
export interface InventoryMovement {
  id: string; delta: number; kind: string; reason: string | null; orderId: string | null;
  adminName: string | null; createdAt: string;
}
export interface SanctionsStatus {
  source: string; addressCount: number;
  lastRun: { fetchedAt: string; entryCount: number; status: string; error: string | null } | null;
}
export const EMAIL_STATUSES = ['PENDING', 'SENDING', 'SENT', 'FAILED'] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];
export interface EmailOutboxItem {
  id: string; toDomain: string; template: string; status: EmailStatus; attempts: number;
  lastError: string | null; createdAt: string; sentAt: string | null;
}
