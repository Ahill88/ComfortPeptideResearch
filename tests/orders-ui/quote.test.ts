import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { canCheckout, cartKey, lineAvailability, MAX_CENTS, orderNeedsReview, parseCreatedOrder, parseQuote, parseTotals, type CartQuote, type CreatedOrder, type OrderQuote } from '../../apps/storefront/lib/orders/quote/model';
import { CommerceError, createQuotedOrder, fetchCartQuote, parseStockConflict, resolveCartLines } from '../../apps/storefront/lib/orders/quote/client';
import { createOrderReview } from '../../apps/storefront/lib/orders/quote/review';
import { createQuoteRequest, type QuoteState } from '../../apps/storefront/lib/orders/quote/request';

const cart = [{ slug: 'ghk-cu', quantity: 2 }];
const line = { productId: 'product-1', lotCode: 'LOT-A', quantity: 2 };
const product = { id: line.productId, slug: cart[0].slug, active: true, lots: [{ code: line.lotCode }], priceCents: 99999 };
const quote = (): OrderQuote => ({ currency: 'USD', subtotalCents: 8400, shippingCents: 500, taxCents: 693, totalCents: 9593, lines: [{ ...line, unitCents: 4200, lineCents: 8400 }], unavailable: [] });
const snapshot = (): CartQuote => ({ cartKey: cartKey(cart), lines: [{ ...line, slug: cart[0].slug }], issues: [], quote: quote() });
const order = (): CreatedOrder => ({ ...quote(), id: 'order-1', status: 'PENDING_PAYMENT', items: quote().lines });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const input = () => ({ items: cart, reviewed: snapshot(), email: 'buyer@example.test', shippingAddress: '123 Research Way', idempotencyKey: 'test-order-key-1' });
const wait = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('totals require USD, whole bounded cents, complete breakdown and consistent sums', () => {
  assert.deepEqual(parseTotals(quote()), { currency: 'USD', subtotalCents: 8400, shippingCents: 500, taxCents: 693, totalCents: 9593 });
  for (const field of ['subtotalCents', 'shippingCents', 'taxCents', 'totalCents']) {
    for (const bad of [undefined, null, '0', -1, 0.5, NaN, Infinity, MAX_CENTS + 1]) assert.equal(parseTotals({ ...quote(), [field]: bad }), null, `${field}=${bad}`);
  }
  assert.equal(parseTotals({ ...quote(), currency: 'EUR' }), null);
  assert.equal(parseTotals({ ...quote(), totalCents: 9594 }), null);
});

test('honest zero shipping and tax (and zero priced items) are valid, missing values are not zero', () => {
  const zero = { currency: 'USD', subtotalCents: 0, shippingCents: 0, taxCents: 0, totalCents: 0 };
  assert.deepEqual(parseTotals(zero), zero);
  const free = { ...zero, lines: [{ ...line, unitCents: 0, lineCents: 0 }], unavailable: [] };
  assert.ok(parseQuote(free, [line]));
  assert.equal(parseQuote({ ...free, shippingCents: undefined }, [line]), null);
});

test('quote validates exact requested product/lot/quantity, no extra/duplicate/omitted lines or false sums', () => {
  assert.ok(parseQuote(quote(), [line]));
  const mutations = [
    { lines: [] }, { lines: [...quote().lines, ...quote().lines] },
    ...[{ productId: 'other' }, { lotCode: 'other' }, { quantity: 1 }, { quantity: 0 }, { quantity: 1001 }, { unitCents: -1 }, { unitCents: '4200' }, { lineCents: 8401 }].map((change) => ({ lines: [{ ...quote().lines[0], ...change }] })),
    { subtotalCents: 8399, totalCents: 9592 }, { unavailable: undefined },
  ];
  for (const change of mutations) assert.equal(parseQuote({ ...quote(), ...change }, [line]), null, JSON.stringify(change));
});

test('inactive and unknown-lot lines may be omitted only with explicit unavailable records', () => {
  for (const reason of ['inactive', 'unknown_lot'] as const) {
    const unavailable = [{ productId: line.productId, reason, available: null }];
    const parsed = parseQuote({ currency: 'USD', subtotalCents: 0, shippingCents: 0, taxCents: 0, totalCents: 0, lines: [], unavailable }, [line]);
    assert.ok(parsed);
    assert.equal(canCheckout({ ...snapshot(), quote: parsed }), false);
    assert.equal(parseQuote({ ...parsed, unavailable: [{ ...unavailable[0], available: 0 }] }, [line]), null);
  }
  assert.equal(parseQuote({ ...quote(), unavailable: [{ productId: line.productId, reason: 'inactive', available: null }] }, [line]), null);
});

test('out-of-stock lines stay priced; checkout blocks and offers a valid quantity reduction', () => {
  const q = parseQuote({ ...quote(), unavailable: [{ productId: line.productId, reason: 'out_of_stock', available: 1 }] }, [line]);
  assert.ok(q);
  const blocked = { ...snapshot(), quote: q };
  assert.equal(blocked.quote.totalCents, 9593);
  assert.equal(canCheckout(blocked), false);
  assert.equal(lineAvailability(blocked, 'ghk-cu')?.reduceTo, 1);
  blocked.quote.unavailable[0].available = 0;
  assert.deepEqual(lineAvailability(blocked, 'ghk-cu'), { message: 'Out of stock.', reduceTo: null });
  for (const bad of [null, undefined, -1, 0.5, '1', 2]) assert.equal(parseQuote({ ...quote(), unavailable: [{ productId: line.productId, reason: 'out_of_stock', available: bad }] }, [line]), null);
});

test('stock reduction subtracts other lots/aliases, rather than granting the full pool to every line', () => {
  const s = snapshot();
  s.lines.push({ ...line, slug: 'other-lot', lotCode: 'LOT-B', quantity: 1 });
  s.quote!.unavailable = [{ productId: line.productId, reason: 'out_of_stock', available: 2 }];
  assert.equal(lineAvailability(s, 'ghk-cu')?.reduceTo, 1);
  assert.equal(lineAvailability(s, 'other-lot')?.reduceTo, null);
});

test('missing quotes and unresolved catalog entries never enable checkout', () => {
  assert.equal(canCheckout(null), false);
  assert.equal(canCheckout({ ...snapshot(), quote: null }), false);
  assert.equal(canCheckout({ ...snapshot(), issues: [{ slug: 'missing', reason: 'not_found' }] }), false);
  assert.equal(canCheckout(snapshot()), true);
});

test('orders require a valid pending order, complete monetary breakdown and exact ordered items', () => {
  assert.ok(parseCreatedOrder(order(), [line]));
  for (const change of [{ id: '' }, { status: 'PAID' }, { subtotalCents: null }, { shippingCents: undefined }, { totalCents: -1 }, { currency: 'SOL' }, { items: [] }, { items: [{ ...line, unitCents: null }] }]) assert.equal(parseCreatedOrder({ ...order(), ...change }, [line]), null);
});

test('total, breakdown or individual line-price changes require review, even when the grand total is unchanged', () => {
  assert.equal(orderNeedsReview(quote(), order()), false);
  assert.equal(orderNeedsReview(quote(), { ...order(), shippingCents: 600, totalCents: 9693 }), true);
  assert.equal(orderNeedsReview(quote(), { ...order(), shippingCents: 600, taxCents: 593 }), true);
  assert.equal(orderNeedsReview(quote(), { ...order(), items: [{ ...order().items[0], unitCents: 4199 }] }), true);
});

test('changed-order gate blocks prepare/top-up/retry until explicit review and binds the accepted amount and order', () => {
  const gate = createOrderReview();
  assert.equal(gate.allows('order-1', 9593), false);
  const changed = { ...order(), shippingCents: 600, totalCents: 9693 };
  assert.equal(gate.record(quote(), changed), true);
  const calls: string[] = [];
  const pay = () => { if (gate.allows(changed.id, changed.totalCents)) calls.push('prepare-or-topup'); };
  pay(); pay();
  assert.deepEqual(calls, []);
  assert.equal(gate.accept('another-order'), false);
  assert.equal(gate.accept(changed.id), true);
  assert.equal(gate.allows(changed.id, 9593), false);
  pay();
  assert.deepEqual(calls, ['prepare-or-topup']);
  gate.record(quote(), { ...changed, id: 'new-order' });
  assert.equal(gate.allows(changed.id, changed.totalCents), false, 'an earlier approval cannot cross into a new order');
  assert.equal(gate.allows('new-order', changed.totalCents), false);
});

test('matching order proceeds with its own total; restored top-up consent authorizes only its original exact amount', () => {
  const gate = createOrderReview();
  assert.equal(gate.record(quote(), order()), false);
  assert.equal(gate.allows(order().id, order().totalCents), true);
  assert.equal(gate.restoreConsent('earlier', MAX_CENTS + 1), false);
  assert.equal(gate.restoreConsent('earlier', 123), true);
  assert.equal(gate.allows('earlier', 123), true);
  assert.equal(gate.allows('order-1', 123), false);
});

test('quote and order share slug resolution and exactly the same API line payload; cookies and cancellation are sent', async () => {
  const seen: Array<{ path: string; init: RequestInit }> = [];
  const signal = new AbortController().signal;
  const options = { signal, baseUrl: 'https://commerce.test/v1', fetcher: (async (url, init) => {
    const path = new URL(String(url)).pathname;
    seen.push({ path, init: init! });
    return response(path.includes('/products/') ? product : path.endsWith('/quote') ? quote() : order());
  }) as typeof fetch };
  const reviewed = await fetchCartQuote(cart, options);
  assert.equal(reviewed.quote?.totalCents, 9593, 'catalog preview price ignored');
  await createQuotedOrder({ ...input(), reviewed }, options);
  assert.deepEqual(seen.map((call) => call.path), ['/v1/products/ghk-cu', '/v1/orders/quote', '/v1/products/ghk-cu', '/v1/orders']);
  const body = (index: number) => JSON.parse(seen[index].init.body as string);
  assert.deepEqual(body(1).items, body(3).items);
  assert.deepEqual(body(3).items, [line]);
  assert.equal(body(3).researchUseAcknowledged, true);
  assert.equal((seen[3].init.headers as Record<string, string>)['Idempotency-Key'], input().idempotencyKey);
  for (const call of seen) { assert.equal(call.init.credentials, 'include'); assert.equal(call.init.signal, signal); assert.equal(call.init.cache, 'no-store'); }
});

test('resolver requires exact slug, active flag, real id and lot; missing products/lots remain unavailable', async () => {
  const run = (body: unknown, status = 200) => resolveCartLines(cart, { fetcher: (async () => response(body, status)) as typeof fetch });
  for (const bad of [null, { ...product, id: '' }, { ...product, slug: 'other' }, { ...product, active: 'true' }, { ...product, lots: [{ code: null }] }]) await assert.rejects(run(bad), CommerceError);
  assert.deepEqual((await run({}, 404)).issues, [{ slug: 'ghk-cu', reason: 'not_found' }]);
  assert.equal((await run({ ...product, active: false })).issues[0].reason, 'inactive');
  assert.equal((await run({ ...product, lots: [] })).issues[0].reason, 'unknown_lot');
  for (const items of [[], [{ slug: 'x', quantity: 0 }], [{ slug: 'x', quantity: 1.5 }], [cart[0], cart[0]]]) await assert.rejects(resolveCartLines(items), /whole quantities/);
});

test('all-unresolved catalog never invents a zero total or posts an empty quote', async () => {
  const paths: string[] = [];
  const result = await fetchCartQuote(cart, { fetcher: (async (url) => { paths.push(String(url)); return response({}, 404); }) as typeof fetch });
  assert.equal(result.quote, null);
  assert.equal(canCheckout(result), false);
  assert.equal(paths.length, 1);
});

test('missing or malformed quote endpoint fails closed and order cannot use a stale cart or unresolved line', async () => {
  for (const answer of [response(null), response({}, 404), response({ ...quote(), taxCents: undefined })]) {
    await assert.rejects(fetchCartQuote(cart, { fetcher: (async (url) => String(url).includes('/products/') ? response(product) : answer) as typeof fetch }), CommerceError);
  }
  const neverFetch = (async () => { throw new Error('must not call API'); }) as typeof fetch;
  await assert.rejects(createQuotedOrder({ ...input(), items: [{ ...cart[0], quantity: 3 }] }, { fetcher: neverFetch }), /Refresh and review/);
  await assert.rejects(createQuotedOrder({ ...input(), reviewed: { ...snapshot(), quote: null } }, { fetcher: neverFetch }), /Refresh and review/);
});

test('a changed product/lot mapping prevents order creation and requires a refreshed quote', async () => {
  let calls = 0;
  await assert.rejects(createQuotedOrder(input(), { fetcher: (async () => { calls += 1; return response({ ...product, lots: [{ code: 'NEW-LOT' }] }); }) as typeof fetch }), /lot changed/);
  assert.equal(calls, 1, 'only re-resolution, no order post');
});

test('OUT_OF_STOCK 409 is structured, not matched from prose; refresh reports the new quantity', async () => {
  let onHand = 1;
  const options = { fetcher: (async (url) => {
    if (String(url).includes('/products/')) return response(product);
    if (String(url).endsWith('/quote')) return response({ ...quote(), unavailable: [{ productId: line.productId, reason: 'out_of_stock', available: onHand }] });
    return response({ code: 'OUT_OF_STOCK', message: 'Insufficient stock', productId: line.productId, available: onHand }, 409);
  }) as typeof fetch };
  await assert.rejects(createQuotedOrder(input(), options), (e: unknown) => e instanceof CommerceError && e.status === 409 && e.stock?.available === 1);
  onHand = 0;
  const refreshed = await fetchCartQuote(cart, options);
  assert.equal(canCheckout(refreshed), false);
  assert.equal(lineAvailability(refreshed, 'ghk-cu')?.message, 'Out of stock.');
  for (const bad of [{ code: 'OTHER' }, { available: null }, { available: -1 }, { available: '1' }, { productId: '' }]) assert.equal(parseStockConflict(409, { code: 'OUT_OF_STOCK', productId: 'p', available: 1, ...bad }), null);
  assert.equal(parseStockConflict(400, { code: 'OUT_OF_STOCK', productId: 'p', available: 1 }), null);
});

test('malformed order never supplies a payable amount; retry uses the same idempotency key', async () => {
  const keys: string[] = [];
  const options = { fetcher: (async (url, init) => {
    if (String(url).includes('/products/')) return response(product);
    keys.push((init!.headers as Record<string, string>)['Idempotency-Key']);
    return response({ ...order(), totalCents: undefined });
  }) as typeof fetch };
  await assert.rejects(createQuotedOrder(input(), options), /could not be verified/);
  await assert.rejects(createQuotedOrder(input(), options), /could not be verified/);
  assert.deepEqual(keys, [input().idempotencyKey, input().idempotencyKey]);
});

test('quote requests debounce quantity bursts and immediately invalidate the displayed quote', async () => {
  const states: QuoteState[] = [];
  let loads = 0;
  const request = createQuoteRequest(async () => { loads += 1; return snapshot(); }, (state) => states.push(state), 10);
  request.schedule('one', cart); request.schedule('two', cart); request.schedule('three', cart);
  assert.equal(states.at(-1)?.kind, 'loading');
  await wait(30);
  assert.equal(loads, 1);
  assert.deepEqual(states.filter((s) => s.kind === 'ready').map((s) => s.key), ['three']);
  request.cancel();
});

test('out-of-order success cannot overwrite the latest quote, even when fetch ignores abort', async () => {
  const states: QuoteState[] = [];
  const pending: Array<{ signal: AbortSignal; resolve: (quote: CartQuote) => void }> = [];
  const request = createQuoteRequest((_items, signal) => new Promise((resolve) => pending.push({ signal, resolve })), (state) => states.push(state), 0);
  request.schedule('old', cart); await wait();
  request.schedule('new', cart); await wait();
  assert.equal(pending[0].signal.aborted, true);
  pending[1].resolve(snapshot()); await wait();
  pending[0].resolve({ ...snapshot(), quote: { ...quote(), totalCents: 1 } }); await wait();
  assert.deepEqual(states.filter((s) => s.kind === 'ready').map((s) => s.key), ['new']);
  request.cancel();
});

test('stale rejection and unmounted request completion cannot erase a valid quote or publish an error', async () => {
  const states: QuoteState[] = [];
  const pending: Array<{ resolve: (value: CartQuote) => void; reject: (error: Error) => void }> = [];
  const request = createQuoteRequest(() => new Promise((resolve, reject) => pending.push({ resolve, reject })), (state) => states.push(state), 0);
  request.schedule('old', cart); await wait();
  request.schedule('new', cart); await wait();
  pending[1].resolve(snapshot()); await wait();
  pending[0].reject(new Error('stale service failure')); await wait();
  assert.equal(states.at(-1)?.kind, 'ready');
  request.schedule('unmounted', cart); await wait(); request.cancel();
  const count = states.length;
  pending[2].resolve(snapshot()); await wait();
  assert.equal(states.length, count);
  assert.equal(states.filter((s) => s.kind === 'error').length, 0);
});
