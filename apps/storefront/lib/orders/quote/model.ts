/** Public commerce wire types. No local catalog prices or shipping/tax policy enter this module. */
export const MAX_CENTS = 2_147_483_647;
export type CartLine = { slug: string; quantity: number };
export type OrderLine = { productId: string; lotCode: string; quantity: number };
export type ResolvedLine = OrderLine & { slug: string };
export type Totals = { currency: 'USD'; subtotalCents: number; shippingCents: number; taxCents: number; totalCents: number };
export type PricedLine = OrderLine & { unitCents: number; lineCents: number };
export type Unavailable = { productId: string; reason: 'out_of_stock' | 'inactive' | 'unknown_lot'; available: number | null };
export type OrderQuote = Totals & { lines: PricedLine[]; unavailable: Unavailable[] };
export type ResolutionIssue = { slug: string; reason: 'not_found' | 'inactive' | 'unknown_lot' };
export type Resolution = { lines: ResolvedLine[]; issues: ResolutionIssue[] };
export type CartQuote = Resolution & { cartKey: string; quote: OrderQuote | null };
export type CreatedOrder = Totals & { id: string; status: 'PENDING_PAYMENT'; items: PricedLine[] };

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export const isCents = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_CENTS;
export const isIdentifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && value === value.trim() && !/[\s\u0000-\u001f\u007f]/.test(value);
const isQuantity = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1000;
const lineKey = (line: OrderLine) => JSON.stringify([line.productId, line.lotCode]);

export function cartKey(items: readonly CartLine[]): string {
  return JSON.stringify(items.map(({ slug, quantity }) => ({ slug, quantity })));
}

export function validateCartLines(items: readonly CartLine[]): void {
  if (!Array.isArray(items) || items.length < 1 || items.length > 50 || items.some((item) => !isIdentifier(item?.slug) || !isQuantity(item?.quantity)) || new Set(items.map((i) => i.slug)).size !== items.length) {
    throw new Error('Choose 1–50 materials with whole quantities between 1 and 1000.');
  }
}

export function parseTotals(raw: unknown): Totals | null {
  const r = record(raw);
  if (r.currency !== 'USD' || !isCents(r.subtotalCents) || !isCents(r.shippingCents) || !isCents(r.taxCents) || !isCents(r.totalCents)) return null;
  if (r.subtotalCents + r.shippingCents + r.taxCents !== r.totalCents) return null;
  return { currency: r.currency, subtotalCents: r.subtotalCents, shippingCents: r.shippingCents, taxCents: r.taxCents, totalCents: r.totalCents };
}

function parseLine(raw: unknown, order = false): PricedLine | null {
  const r = record(raw);
  if (!isIdentifier(r.productId) || !isIdentifier(r.lotCode) || !isQuantity(r.quantity) || !isCents(r.unitCents)) return null;
  const lineCents = r.unitCents * r.quantity;
  if (!isCents(lineCents) || (!order && r.lineCents !== lineCents)) return null;
  return { productId: r.productId, lotCode: r.lotCode, quantity: r.quantity, unitCents: r.unitCents, lineCents };
}

/** Every requested line must be priced exactly once or explicitly unavailable. Unknown/missing money is never zero. */
export function parseQuote(raw: unknown, expected: readonly OrderLine[]): OrderQuote | null {
  const r = record(raw);
  const totals = parseTotals(r);
  if (!totals || !Array.isArray(r.lines) || !Array.isArray(r.unavailable) || !expected.length) return null;
  const lines: PricedLine[] = [];
  const remaining = [...expected];
  for (const rawLine of r.lines) {
    const line = parseLine(rawLine);
    if (!line) return null;
    const index = remaining.findIndex((item) => lineKey(item) === lineKey(line) && item.quantity === line.quantity);
    if (index < 0) return null;
    remaining.splice(index, 1);
    lines.push(line);
  }
  const unavailable: Unavailable[] = [];
  for (const value of r.unavailable) {
    const u = record(value);
    if (!isIdentifier(u.productId) || !expected.some((l) => l.productId === u.productId)) return null;
    if (u.reason !== 'out_of_stock' && u.reason !== 'inactive' && u.reason !== 'unknown_lot') return null;
    if (unavailable.some((v) => v.productId === u.productId && v.reason === u.reason)) return null;
    if (u.reason === 'out_of_stock' ? !isCents(u.available) : u.available !== null) return null;
    if (u.reason === 'out_of_stock' && lines.filter((l) => l.productId === u.productId).reduce((sum, l) => sum + l.quantity, 0) <= (u.available as number)) return null;
    if (u.reason === 'inactive' && lines.some((l) => l.productId === u.productId)) return null;
    if (u.reason !== 'out_of_stock' && !remaining.some((l) => l.productId === u.productId)) return null;
    unavailable.push({ productId: u.productId, reason: u.reason, available: u.available as number | null });
  }
  if (remaining.some((line) => !unavailable.some((u) => u.productId === line.productId && u.reason !== 'out_of_stock'))) return null;
  if (lines.reduce((sum, l) => sum + l.lineCents, 0) !== totals.subtotalCents) return null;
  if (!lines.length && totals.totalCents !== 0) return null;
  return { ...totals, lines, unavailable };
}

export function parseCreatedOrder(raw: unknown, expected: readonly OrderLine[]): CreatedOrder | null {
  const r = record(raw);
  const totals = parseTotals(r);
  if (!totals || !isIdentifier(r.id) || r.status !== 'PENDING_PAYMENT' || !Array.isArray(r.items)) return null;
  const items = r.items.map((item) => parseLine(item, true));
  if (items.some((item) => item === null)) return null;
  const priced = items as PricedLine[];
  const parsed = parseQuote({ ...totals, lines: priced, unavailable: [] }, expected);
  return parsed ? { ...totals, id: r.id, status: 'PENDING_PAYMENT', items: priced } : null;
}

export function canCheckout(snapshot: CartQuote | null): snapshot is CartQuote & { quote: OrderQuote } {
  return !!snapshot?.quote && snapshot.issues.length === 0 && snapshot.quote.unavailable.length === 0 && snapshot.lines.length > 0;
}

/** Compare breakdown AND line prices: even a same-total redistribution needs a new review. */
export function orderNeedsReview(quote: OrderQuote, order: CreatedOrder): boolean {
  if ((['subtotalCents', 'shippingCents', 'taxCents', 'totalCents'] as const).some((key) => quote[key] !== order[key])) return true;
  const prices = (lines: PricedLine[]) => JSON.stringify(lines.map((l) => JSON.stringify([l.productId, l.lotCode, l.quantity, l.unitCents])).sort());
  return prices(quote.lines) !== prices(order.items);
}

export function sameResolution(a: readonly ResolvedLine[], b: readonly ResolvedLine[]): boolean {
  const key = (lines: readonly ResolvedLine[]) => JSON.stringify(lines.map((l) => JSON.stringify([l.slug, l.productId, l.lotCode, l.quantity])).sort());
  return key(a) === key(b);
}

export function lineAvailability(snapshot: CartQuote | null, slug: string): { message: string; reduceTo: number | null } | null {
  if (!snapshot) return null;
  const issue = snapshot.issues.find((i) => i.slug === slug);
  if (issue) return { message: issue.reason === 'unknown_lot' ? 'No orderable lot is available.' : 'This material is unavailable from the order service.', reduceTo: null };
  const line = snapshot.lines.find((l) => l.slug === slug);
  if (!line) return null;
  const unavailable = snapshot.quote?.unavailable.filter((u) => u.productId === line.productId) ?? [];
  if (!unavailable.length) return null;
  const stock = unavailable.find((u) => u.reason === 'out_of_stock');
  if (!stock || unavailable.some((u) => u.reason !== 'out_of_stock')) return { message: 'This material or selected lot is unavailable.', reduceTo: null };
  const available = stock.available!;
  // Stock is shared across all lots/aliases of a product. Do not offer each line the entire stock pool.
  const others = snapshot.lines.filter((l) => l.productId === line.productId && l.slug !== slug).reduce((sum, l) => sum + l.quantity, 0);
  const reduceTo = Math.max(0, available - others);
  return { message: available === 0 ? 'Out of stock.' : `Only ${available} available for this material across all lots. Reduce the quantity to continue.`, reduceTo: reduceTo > 0 && reduceTo < line.quantity ? reduceTo : null };
}
