import { canCheckout, cartKey, isCents, isIdentifier, parseCreatedOrder, parseQuote, record, sameResolution, validateCartLines, type CartLine, type CartQuote, type CreatedOrder, type OrderLine, type Resolution, type ResolvedLine } from './model';

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/v1').replace(/\/+$/, '');
export type CommerceOptions = { signal?: AbortSignal; fetcher?: typeof fetch; baseUrl?: string };
export type StockConflict = { productId: string; available: number };

export class CommerceError extends Error {
  constructor(message: string, readonly status: number | null = null, readonly stock: StockConflict | null = null) {
    super(message);
    this.name = 'CommerceError';
  }
}

export function parseStockConflict(status: number, raw: unknown): StockConflict | null {
  const r = record(raw);
  return status === 409 && r.code === 'OUT_OF_STOCK' && isIdentifier(r.productId) && isCents(r.available) ? { productId: r.productId, available: r.available } : null;
}

async function request(path: string, options: CommerceOptions, body?: unknown, headers?: Record<string, string>): Promise<unknown> {
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(`${options.baseUrl ?? API_BASE}${path}`, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'include', cache: 'no-store', signal: options.signal,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new CommerceError('The order service is unavailable. Try refreshing the quote.');
  }
  let raw: unknown;
  try { raw = await response.json(); } catch { raw = null; }
  if (!response.ok) {
    const stock = parseStockConflict(response.status, raw);
    const message = record(raw).message;
    throw new CommerceError(stock ? 'Stock changed before your order could be placed. Review the updated availability.' : typeof message === 'string' && message.length <= 500 ? message : 'The order service could not return a quote or order. Please try again.', response.status, stock);
  }
  return raw;
}

/** The ONLY slug -> product/lot resolver for quoting and order creation. Catalog prices are deliberately not read. */
export async function resolveCartLines(items: readonly CartLine[], options: CommerceOptions = {}): Promise<Resolution> {
  validateCartLines(items);
  const entries = await Promise.all(items.map(async (item): Promise<Resolution> => {
    let raw: unknown;
    try { raw = await request(`/products/${encodeURIComponent(item.slug)}`, options); }
    catch (error) {
      if (error instanceof CommerceError && error.status === 404) return { lines: [], issues: [{ slug: item.slug, reason: 'not_found' }] };
      throw error;
    }
    const product = record(raw);
    if (!isIdentifier(product.id) || product.slug !== item.slug || typeof product.active !== 'boolean' || !Array.isArray(product.lots) || product.lots.some((lot) => !isIdentifier(record(lot).code))) throw new CommerceError('The catalog returned an invalid product. Refresh the quote before ordering.');
    if (!product.active) return { lines: [], issues: [{ slug: item.slug, reason: 'inactive' }] };
    const lot = record(product.lots[0]);
    if (!isIdentifier(lot.code)) return { lines: [], issues: [{ slug: item.slug, reason: 'unknown_lot' }] };
    return { lines: [{ slug: item.slug, productId: product.id, lotCode: lot.code, quantity: item.quantity }], issues: [] };
  }));
  return { lines: entries.flatMap((entry) => entry.lines), issues: entries.flatMap((entry) => entry.issues) };
}

const orderLines = (lines: readonly ResolvedLine[]): OrderLine[] => lines.map(({ productId, lotCode, quantity }) => ({ productId, lotCode, quantity }));

export async function fetchCartQuote(items: readonly CartLine[], options: CommerceOptions = {}): Promise<CartQuote> {
  const resolved = await resolveCartLines(items, options);
  if (!resolved.lines.length) return { ...resolved, cartKey: cartKey(items), quote: null };
  const lines = orderLines(resolved.lines);
  const quote = parseQuote(await request('/orders/quote', options, { items: lines }), lines);
  if (!quote) throw new CommerceError('The order service returned an incomplete or invalid quote. Totals are unavailable.');
  return { ...resolved, cartKey: cartKey(items), quote };
}

export async function createQuotedOrder(input: { items: readonly CartLine[]; reviewed: CartQuote; email: string; shippingAddress: string; idempotencyKey: string }, options: CommerceOptions = {}): Promise<CreatedOrder> {
  if (!canCheckout(input.reviewed) || input.reviewed.cartKey !== cartKey(input.items)) throw new CommerceError('Refresh and review an available quote before placing your order.');
  const resolved = await resolveCartLines(input.items, options);
  if (resolved.issues.length || !sameResolution(resolved.lines, input.reviewed.lines)) throw new CommerceError('The selected material or lot changed. Refresh and review the quote before ordering.');
  const lines = orderLines(resolved.lines);
  const raw = await request('/orders', options, {
    email: input.email.trim(), shippingAddress: input.shippingAddress.trim(), items: lines,
    researchUseAcknowledged: true, idempotencyKey: input.idempotencyKey,
  }, { 'Idempotency-Key': input.idempotencyKey });
  const order = parseCreatedOrder(raw, lines);
  if (!order) throw new CommerceError('The order response could not be verified. Nothing will be paid or topped up. Retry with the same order request to check it.');
  return order;
}
