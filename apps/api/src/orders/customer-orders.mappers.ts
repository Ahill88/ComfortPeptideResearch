import { BadRequestException } from '@nestjs/common';
import type { CustomerOrderDetail, CustomerOrderItem, CustomerOrderSummary, CustomerShipment, CustomerTimelineEntry } from './customer-orders.dto';
import { CUSTOMER_ORDERS_CURSOR_MAX } from './customer-orders.dto';

/**
 * Carrier tracking-page URL templates. The carrier names are the exact values the admin ship action stores
 * (admin-orders.types CARRIERS). Anything else (including OTHER and any unexpected string) has no URL.
 */
const TRACKING_URL_PREFIX: Readonly<Record<string, string>> = {
  USPS: 'https://tools.usps.com/go/TrackConfirmAction?tLabels=',
  UPS: 'https://www.ups.com/track?tracknum=',
  FedEx: 'https://www.fedex.com/fedextrack/?trknbr=',
  DHL: 'https://www.dhl.com/global-en/home/tracking.html?tracking-id=',
};

/** encodeURIComponent leaves `!'()*` alone; they are harmless in a query value but cost nothing to encode too. */
function encodeQueryValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Pure. Returns null for OTHER/unknown carriers, an empty number, or a number that cannot be encoded (lone surrogates). */
export function buildTrackingUrl(carrier: string, trackingNumber: string): string | null {
  if (typeof carrier !== 'string' || typeof trackingNumber !== 'string') return null;
  const prefix = Object.prototype.hasOwnProperty.call(TRACKING_URL_PREFIX, carrier) ? TRACKING_URL_PREFIX[carrier] : undefined;
  const number = trackingNumber.trim();
  if (!prefix || number === '') return null;
  try {
    return `${prefix}${encodeQueryValue(number)}`;
  } catch {
    return null;
  }
}

export function encodeOrderCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt.getTime(), i: id }), 'utf8').toString('base64url');
}

export function decodeOrderCursor(cursor: string): { createdAt: Date; id: string } {
  const invalid = () => new BadRequestException('Invalid cursor.');
  if (typeof cursor !== 'string' || cursor.length > CUSTOMER_ORDERS_CURSOR_MAX || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const { t, i } = (parsed ?? {}) as { t?: unknown; i?: unknown };
  if (typeof t !== 'number' || !Number.isSafeInteger(t) || typeof i !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(i)) throw invalid();
  const createdAt = new Date(t);
  if (Number.isNaN(createdAt.getTime())) throw invalid();
  return { createdAt, id: i };
}

export interface OrderRowBase {
  id: string;
  status: string;
  totalCents: number;
  subtotalCents: number | null;
  shippingCents: number;
  taxCents: number;
  currency: string;
  createdAt: Date;
}

type ShipmentRow = { id: string; carrier: string; trackingNumber: string; shippedAt: Date; deliveredAt?: Date | null };

/** The most recent shipment (shippedAt, then id), the one a list row advertises. */
function latestShipment<T extends { id: string; shippedAt: Date }>(shipments: T[]): T | undefined {
  return [...shipments].sort((a, b) => b.shippedAt.getTime() - a.shippedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))[0];
}

function totals(row: OrderRowBase) {
  return {
    id: row.id,
    status: row.status,
    totalCents: row.totalCents,
    subtotalCents: row.subtotalCents ?? null,
    shippingCents: row.shippingCents,
    taxCents: row.taxCents,
    currency: row.currency,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toOrderSummary(row: OrderRowBase & { items: Array<{ quantity: number }>; shipments: ShipmentRow[] }): CustomerOrderSummary {
  const latest = latestShipment(row.shipments);
  return {
    ...totals(row),
    itemCount: row.items.reduce((sum, item) => sum + item.quantity, 0),
    carrier: latest?.carrier ?? null,
    trackingNumber: latest?.trackingNumber ?? null,
  };
}

export function toShipment(row: ShipmentRow): CustomerShipment {
  return {
    carrier: row.carrier,
    trackingNumber: row.trackingNumber,
    trackingUrl: buildTrackingUrl(row.carrier, row.trackingNumber),
    shippedAt: row.shippedAt.toISOString(),
    deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
  };
}

/**
 * Customer-safe status history. Inputs are ONLY status/time pairs: callers never pass notes or admin ids, so they cannot leak.
 *  - first entry: PENDING_PAYMENT at the order's createdAt (legacy orders with no events still get it);
 *  - then every STATUS event with a target status, oldest first;
 *  - payment settlement writes no OrderEvent, so when no event records PAID, the finalized purchase's time stands in for it.
 */
export function buildTimeline(
  createdAt: Date,
  events: Array<{ toStatus: string | null; createdAt: Date }>,
  paidAt: Date | null = null,
): CustomerTimelineEntry[] {
  const entries: Array<{ status: string; at: Date }> = events.filter((event) => event.toStatus).map((event) => ({ status: event.toStatus as string, at: event.createdAt }));
  if (paidAt && !entries.some((entry) => entry.status === 'PAID')) entries.push({ status: 'PAID', at: paidAt });
  // Stable sort keeps the database order for identical timestamps.
  entries.sort((a, b) => a.at.getTime() - b.at.getTime());
  return [{ status: 'PENDING_PAYMENT', at: createdAt }, ...entries].map((entry) => ({ status: entry.status, at: entry.at.toISOString() }));
}

export function toOrderDetail(
  row: OrderRowBase & {
    shippingAddress: string | null;
    items: Array<{ productId: string; lotCode: string; quantity: number; unitCents: number }>;
    shipments: ShipmentRow[];
    events: Array<{ toStatus: string | null; createdAt: Date }>;
  },
  products: Map<string, { slug: string; name: string }>,
  paidAt: Date | null,
): CustomerOrderDetail {
  const items: CustomerOrderItem[] = row.items.map((item) => ({
    productId: item.productId,
    slug: products.get(item.productId)?.slug ?? null,
    name: products.get(item.productId)?.name ?? 'Unavailable product',
    lotCode: item.lotCode,
    quantity: item.quantity,
    unitCents: item.unitCents,
  }));
  return {
    ...totals(row),
    shippingAddress: row.shippingAddress ?? null,
    items,
    shipments: [...row.shipments].sort((a, b) => a.shippedAt.getTime() - b.shippedAt.getTime() || (a.id < b.id ? -1 : 1)).map(toShipment),
    timeline: buildTimeline(row.createdAt, row.events, paidAt),
  };
}
