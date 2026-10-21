import { loginPath } from '../auth/navigation';

/** Customer-order wire boundary. Rebuild only customer-facing fields; never pass arbitrary API objects to the UI. */
export const ORDER_STATUSES = ['PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'] as const;
export type OrderStatus = typeof ORDER_STATUSES[number];
export type DisplayOrderStatus = OrderStatus | 'UNKNOWN';

export type OrderTotals = {
  totalCents: number; subtotalCents: number | null; shippingCents: number; taxCents: number; currency: string;
};
type OrderBase = OrderTotals & { id: string; status: DisplayOrderStatus; createdAt: string };
export type CustomerOrderSummary = OrderBase & { itemCount: number; carrier: string | null; trackingNumber: string | null };
export type CustomerOrderPage = { items: CustomerOrderSummary[]; nextCursor: string | null };
export type CustomerOrderItem = { productId: string; slug: string | null; name: string; lotCode: string; quantity: number; unitCents: number };
export type CustomerShipment = { carrier: string; trackingNumber: string; trackingUrl: string | null; shippedAt: string; deliveredAt: string | null };
export type CustomerTimelineEntry = { status: OrderStatus; at: string };
export type CustomerOrderDetail = OrderBase & {
  shippingAddress: string | null; items: CustomerOrderItem[]; shipments: CustomerShipment[]; timeline: CustomerTimelineEntry[];
};

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const integer = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= 2_147_483_647;
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
// Retain literal markup as text (React escapes it), but remove controls that can disguise a status, address or number.
const cleanText = (value: string) => value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '').trim();

export function isOrderId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

export function isOrderCursor(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
}

export function isOrderInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)) return false;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) && time.toISOString() === (value.includes('.') ? value : value.replace('Z', '.000Z'));
}

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === 'string' && (ORDER_STATUSES as readonly string[]).includes(value);
}

export function orderStatusLabel(status: DisplayOrderStatus): string {
  const labels: Record<DisplayOrderStatus, string> = {
    PENDING_PAYMENT: 'Pending payment', PAID: 'Paid', PROCESSING: 'Processing', SHIPPED: 'Shipped',
    DELIVERED: 'Delivered', CANCELLED: 'Cancelled', REFUNDED: 'Refunded', UNKNOWN: 'Status unavailable',
  };
  return Object.prototype.hasOwnProperty.call(labels, status) ? labels[status] : labels.UNKNOWN;
}

export function isTerminalOrder(status: DisplayOrderStatus): boolean {
  return status === 'DELIVERED' || status === 'CANCELLED' || status === 'REFUNDED';
}

export function orderProductHref(slug: unknown): string | null {
  return typeof slug === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(slug) ? `/catalog/${encodeURIComponent(slug)}` : null;
}

/** Construct the return path from a validated order id, never from a query parameter or an external URL. */
export function ordersSignInHref(id?: string): string {
  return loginPath(isOrderId(id) ? `/orders/${id}` : '/orders');
}

const CARRIER_ROUTES: Record<string, { host: string; path: string; query: string }> = {
  USPS: { host: 'tools.usps.com', path: '/go/TrackConfirmAction', query: 'tLabels' },
  UPS: { host: 'www.ups.com', path: '/track', query: 'tracknum' },
  FedEx: { host: 'www.fedex.com', path: '/fedextrack/', query: 'trknbr' },
  DHL: { host: 'www.dhl.com', path: '/global-en/home/tracking.html', query: 'tracking-id' },
};

/** Only the API's documented HTTPS carrier tracking pages, with the matching number. No redirects or arbitrary subdomains. */
export function safeTrackingUrl(value: unknown, carrier: string, trackingNumber: string): string | null {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\\u0000-\u001F\u007F]/.test(value)) return null;
  const route = Object.prototype.hasOwnProperty.call(CARRIER_ROUTES, carrier) ? CARRIER_ROUTES[carrier] : null;
  if (!route || !trackingNumber.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== route.host || url.port || url.username || url.password || url.hash) return null;
    if (url.pathname !== route.path || [...url.searchParams].length !== 1 || url.searchParams.get(route.query) !== trackingNumber.trim()) return null;
    return url.href;
  } catch { return null; }
}

function parseBase(value: unknown): OrderBase | null {
  if (!record(value) || !isOrderId(value.id) || !text(value.status) || !isOrderInstant(value.createdAt)) return null;
  const { totalCents, subtotalCents, shippingCents, taxCents, currency } = value;
  if (!integer(totalCents) || !(subtotalCents === null || integer(subtotalCents)) || !integer(shippingCents) || !integer(taxCents)) return null;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return null;
  if (subtotalCents !== null && subtotalCents + shippingCents + taxCents !== totalCents) return null;
  return { id: value.id, status: isOrderStatus(value.status) ? value.status : 'UNKNOWN', createdAt: value.createdAt, totalCents, subtotalCents, shippingCents, taxCents, currency };
}

export function parseCustomerOrderPage(value: unknown): CustomerOrderPage | null {
  if (!record(value) || !Array.isArray(value.items) || value.items.length > 50 || !(value.nextCursor === null || isOrderCursor(value.nextCursor))) return null;
  const items: CustomerOrderSummary[] = [];
  for (const entry of value.items) {
    const base = parseBase(entry);
    if (!base || !record(entry) || !integer(entry.itemCount) || !(entry.carrier === null || text(entry.carrier)) || !(entry.trackingNumber === null || text(entry.trackingNumber))) return null;
    if (items.some((item) => item.id === base.id)) return null;
    items.push({ ...base, itemCount: entry.itemCount, carrier: entry.carrier === null ? null : cleanText(entry.carrier), trackingNumber: entry.trackingNumber === null ? null : cleanText(entry.trackingNumber) });
  }
  return { items, nextCursor: value.nextCursor };
}

/** No event/note/admin fallback; unrecognised or undated transitions cannot become customer history. */
export function parseCustomerTimeline(value: unknown): CustomerTimelineEntry[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    if (!record(entry) || !isOrderStatus(entry.status) || !isOrderInstant(entry.at) || (entry.kind !== undefined && entry.kind !== 'STATUS')) return [];
    return [{ status: entry.status, at: entry.at }];
  }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function parseCustomerOrderDetail(value: unknown): CustomerOrderDetail | null {
  const base = parseBase(value);
  if (!base || !record(value) || !Array.isArray(value.items) || !Array.isArray(value.shipments)) return null;
  if (!(value.shippingAddress === null || text(value.shippingAddress))) return null;
  const timeline = parseCustomerTimeline(value.timeline);
  if (!timeline) return null;
  const items: CustomerOrderItem[] = [];
  for (const item of value.items) {
    if (!record(item) || !text(item.productId) || !text(item.name) || !text(item.lotCode) || !integer(item.quantity, 1) || !integer(item.unitCents)) return null;
    if (!(item.slug === null || typeof item.slug === 'string') || !Number.isSafeInteger(item.quantity * item.unitCents)) return null;
    items.push({ productId: cleanText(item.productId), slug: orderProductHref(item.slug) ? item.slug as string : null, name: cleanText(item.name), lotCode: cleanText(item.lotCode), quantity: item.quantity, unitCents: item.unitCents });
  }
  const shipments: CustomerShipment[] = [];
  for (const shipment of value.shipments) {
    if (!record(shipment) || !text(shipment.carrier) || !text(shipment.trackingNumber) || !isOrderInstant(shipment.shippedAt) || !(shipment.deliveredAt === null || isOrderInstant(shipment.deliveredAt))) return null;
    const carrier = cleanText(shipment.carrier);
    const trackingNumber = cleanText(shipment.trackingNumber);
    shipments.push({ carrier, trackingNumber, trackingUrl: safeTrackingUrl(shipment.trackingUrl, carrier, trackingNumber), shippedAt: shipment.shippedAt, deliveredAt: shipment.deliveredAt });
  }
  return { ...base, shippingAddress: value.shippingAddress === null ? null : cleanText(value.shippingAddress), items, shipments, timeline };
}

export function orderTotalRows(totals: OrderTotals): Array<{ label: string; cents: number }> {
  return [
    ...(totals.subtotalCents === null ? [] : [
      { label: 'Subtotal', cents: totals.subtotalCents }, { label: 'Shipping', cents: totals.shippingCents }, { label: 'Tax', cents: totals.taxCents },
    ]),
    { label: 'Total', cents: totals.totalCents },
  ];
}

export function formatOrderMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
}

export function formatOrderDate(instant: string, withTime = false): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
    ...(withTime ? { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' } as const : {}),
  }).format(new Date(instant));
}
