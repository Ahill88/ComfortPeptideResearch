import type { OrderCounts } from './types';

export const PAGE_SIZE = 25;
export const ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface QueueTab { slug: string; label: string; statuses: string | null; empty: string }

export const QUEUE_TABS: readonly QueueTab[] = [
  { slug: 'to-pack', label: 'To pack', statuses: 'PAID', empty: 'Nothing is waiting to be packed.' },
  { slug: 'packing', label: 'Packing', statuses: 'PROCESSING', empty: 'No orders are being packed.' },
  { slug: 'shipped', label: 'Shipped', statuses: 'SHIPPED', empty: 'No shipped orders.' },
  { slug: 'delivered', label: 'Delivered', statuses: 'DELIVERED', empty: 'No delivered orders.' },
  { slug: 'awaiting-payment', label: 'Awaiting payment', statuses: 'PENDING_PAYMENT', empty: 'No orders are awaiting payment.' },
  { slug: 'all', label: 'All', statuses: null, empty: 'No orders.' },
];

export const DEFAULT_TAB = 'to-pack';

export function queueQuery(tab: string, q: string): Record<string, string | number | undefined> {
  const def = QUEUE_TABS.find((t) => t.slug === tab) ?? QUEUE_TABS[0];
  return { status: def.statuses ?? undefined, q: q.trim() || undefined, limit: PAGE_SIZE };
}

export function tabCount(slug: string, counts: OrderCounts | null): number | null {
  if (!counts) return null;
  const def = QUEUE_TABS.find((t) => t.slug === slug);
  if (!def) return null;
  if (!def.statuses) return Object.values(counts).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  return counts[def.statuses as keyof OrderCounts] ?? 0;
}
