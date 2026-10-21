/** Admin inventory contract (docs/api/commerce-contract.md section 3, docs/api/inventory-and-totals.md). */
export const DEFAULT_LIST_LIMIT = 25;
export const MAX_LIST_LIMIT = 100;
export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 100;
export const MAX_ADJUST_DELTA = 100_000;
export const ADJUST_REASON_MAX = 200;
export const SEARCH_QUERY_MAX = 100;
export const INVENTORY_KINDS = ['ORDER_RESERVE', 'ORDER_RELEASE', 'ADMIN_ADJUST'] as const;
export type InventoryKindName = (typeof INVENTORY_KINDS)[number];

export interface AdminInventoryItem {
  productId: string;
  sku: string;
  name: string;
  active: boolean;
  /** Product.inventory: units still sellable. Units held by unpaid orders are already taken out of it. */
  onHand: number;
  /** Units held by unpaid, unexpired orders (already deducted from onHand; they return if those orders expire or are cancelled). */
  reserved: number;
  lowStockThreshold: number | null;
  /** lowStockThreshold is set and onHand <= lowStockThreshold. */
  lowStock: boolean;
}

export interface AdminInventoryPage {
  items: AdminInventoryItem[];
  nextCursor: string | null;
}

export interface AdminLedgerEntry {
  id: string;
  delta: number;
  kind: InventoryKindName;
  reason: string | null;
  orderId: string | null;
  adminName: string | null;
  createdAt: string;
}

export interface AdminLedgerPage {
  items: AdminLedgerEntry[];
  nextCursor: string | null;
}
