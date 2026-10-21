import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { InventoryService } from '../../commerce/inventory.service';
import { ShippingTaxCalculator } from '../../commerce/shipping-tax.calculator';
import { loadCommerceConfig } from '../../commerce/commerce.config';
import { computeRequestHash, OrdersService } from '../orders.service';
import { createInMemoryPrisma, Product } from './in-memory-prisma';

const previousNodeEnv = process.env.NODE_ENV;
afterEach(() => {
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  delete process.env.REQUIRE_PUBLISHED_COA;
});

const products = (): Product[] => [
  { id: 'p-a', name: 'Alpha', priceCents: 1000, active: true, inventory: 5, lots: [{ code: 'LOT-A' }] },
  { id: 'p-b', name: 'Beta', priceCents: 250, active: true, inventory: 3, lots: [{ code: 'LOT-B1' }, { code: 'LOT-B2' }] },
  { id: 'p-off', name: 'Off', priceCents: 100, active: false, inventory: 9, lots: [{ code: 'LOT-OFF' }] },
];

function setup(env: Record<string, string> = {}, seed = products()) {
  const { prisma, state } = createInMemoryPrisma(seed);
  const config = loadCommerceConfig(env);
  const service = new OrdersService(prisma as any, new InventoryService(), new ShippingTaxCalculator(config), config);
  return { service, state, prisma };
}
const request = (overrides: Record<string, unknown> = {}) => ({
  email: 'buyer@example.test',
  shippingAddress: '1 Lab Way',
  researchUseAcknowledged: true as const,
  idempotencyKey: 'order-key-00000001',
  items: [{ productId: 'p-a', lotCode: 'LOT-A', quantity: 2 }],
  ...overrides,
});
const stock = (state: ReturnType<typeof setup>['state'], id: string) => state.products.find((p) => p.id === id)!.inventory;

test('totals are stored and returned: subtotal + shipping + tax, expiresAt = now + hold', async () => {
  const { service, state } = setup({ SHIPPING_FLAT_CENTS: '599', TAX_RATE_BPS: '825', ORDER_HOLD_MINUTES: '30' });
  const before = Date.now();
  const order = await service.create(request());
  // 2 x 1000 = 2000; tax 2000 x 8.25% = 165; shipping 599.
  assert.deepEqual({ s: order.subtotalCents, h: order.shippingCents, t: order.taxCents, total: order.totalCents }, { s: 2000, h: 599, t: 165, total: 2764 });
  const row = state.orders[0];
  assert.equal(row.subtotalCents + row.shippingCents + row.taxCents, row.totalCents);
  const hold = row.expiresAt.getTime() - before;
  assert.ok(hold >= 30 * 60_000 && hold < 30 * 60_000 + 5_000, `hold ${hold}`);
  assert.ok(!('expiresAt' in order) && !('shippingAddress' in order));
});

test('stock is reserved with ledger rows ORDER_RESERVE per product, summing lines of the same product', async () => {
  const { service, state } = setup();
  const order = await service.create(request({ items: [{ productId: 'p-b', lotCode: 'LOT-B1', quantity: 1 }, { productId: 'p-b', lotCode: 'LOT-B2', quantity: 2 }, { productId: 'p-a', lotCode: 'LOT-A', quantity: 1 }] }));
  assert.equal(stock(state, 'p-a'), 4);
  assert.equal(stock(state, 'p-b'), 0);
  const rows = state.ledger.map((r) => ({ productId: r.productId, delta: r.delta, kind: r.kind, orderId: r.orderId })).sort((x, y) => (x.productId < y.productId ? -1 : 1));
  assert.deepEqual(rows, [
    { productId: 'p-a', delta: -1, kind: 'ORDER_RESERVE', orderId: order.id },
    { productId: 'p-b', delta: -3, kind: 'ORDER_RESERVE', orderId: order.id },
  ]);
});

test('a failing line rolls back every reservation and the order; the 409 body is exactly the contract', async () => {
  const { service, state } = setup();
  await assert.rejects(
    service.create(request({ items: [{ productId: 'p-a', lotCode: 'LOT-A', quantity: 5 }, { productId: 'p-b', lotCode: 'LOT-B1', quantity: 4 }] })),
    (error: unknown) => {
      assert.ok(error instanceof ConflictException);
      assert.deepEqual((error as ConflictException).getResponse(), { code: 'OUT_OF_STOCK', message: 'Insufficient stock for Beta.', productId: 'p-b', available: 3 });
      return true;
    },
  );
  assert.equal(stock(state, 'p-a'), 5, 'p-a was reserved first (sorted order) and must be rolled back');
  assert.equal(stock(state, 'p-b'), 3);
  assert.equal(state.orders.length, 0);
  assert.equal(state.ledger.length, 0);
});

test('exactly the stock on hand can be bought, then the next order is OUT_OF_STOCK with available 0', async () => {
  const { service, state } = setup();
  await service.create(request({ items: [{ productId: 'p-a', lotCode: 'LOT-A', quantity: 5 }] }));
  assert.equal(stock(state, 'p-a'), 0);
  await assert.rejects(service.create(request({ idempotencyKey: 'order-key-00000002', items: [{ productId: 'p-a', lotCode: 'LOT-A', quantity: 1 }] })), (error: unknown) => {
    assert.equal(((error as ConflictException).getResponse() as Record<string, unknown>).available, 0);
    return true;
  });
  assert.equal(stock(state, 'p-a'), 0);
});

test('an idempotent replay returns the ORIGINAL order and does not reserve again, even after config and stock changed', async () => {
  const first = setup({ SHIPPING_FLAT_CENTS: '500' });
  const original = await first.service.create(request());
  assert.equal(stock(first.state, 'p-a'), 3);
  // Same data, but the operator changed shipping/tax settings and an admin emptied the shelf in the meantime.
  const config = loadCommerceConfig({ SHIPPING_FLAT_CENTS: '900', TAX_RATE_BPS: '1000' });
  const changed = new OrdersService(first.prisma as any, new InventoryService(), new ShippingTaxCalculator(config), config);
  first.state.products[0].inventory = 0;
  const replay = await changed.create(request());
  assert.deepEqual(replay, original);
  assert.equal(first.state.orders.length, 1);
  assert.equal(first.state.ledger.length, 1);
  assert.equal(first.state.products[0].inventory, 0, 'no second reservation');
});

test('the request hash does not depend on totals, shipping or tax settings', () => {
  const base = request();
  const hash = computeRequestHash(base);
  const withExtras = { ...base, subtotalCents: 1, shippingCents: 2, taxCents: 3, totalCents: 6, expiresAt: new Date() } as never;
  assert.equal(computeRequestHash(withExtras), hash);
});

test('inactive product, unknown lot and bounds still win with the original 400s and touch no stock', async () => {
  const { service, state } = setup();
  await assert.rejects(service.create(request({ items: [{ productId: 'p-off', lotCode: 'LOT-OFF', quantity: 1 }] })), /Unavailable product in order/);
  await assert.rejects(service.create(request({ items: [{ productId: 'p-a', lotCode: 'LOT-B1', quantity: 1 }] })), /Invalid lot/);
  assert.equal(state.ledger.length, 0);
  assert.equal(stock(state, 'p-a'), 5);
});

test('total including shipping and tax must fit Int32: otherwise 400 and nothing is reserved', async () => {
  const big: Product = { id: 'p-x', name: 'X', priceCents: 2_147_483_000, active: true, inventory: 5, lots: [{ code: 'LOT-X' }] };
  const { service, state } = setup({ SHIPPING_FLAT_CENTS: '1000' }, [big]);
  await assert.rejects(service.create(request({ items: [{ productId: 'p-x', lotCode: 'LOT-X', quantity: 1 }] })), (error: unknown) => error instanceof BadRequestException && /too large/.test(error.message));
  assert.equal(state.orders.length, 0);
  assert.equal(big.inventory, 5);
});

test('identity: the order belongs to the signed-in customer; a different body email is 400; no body email is fine', async () => {
  const { service, state } = setup();
  const identity = { email: 'Owner@Example.test' };
  const order = await service.create({ ...request({ email: undefined }), identity });
  assert.equal(state.customers.length, 1);
  assert.equal(state.customers[0].email, 'owner@example.test');
  assert.equal(order.customerId, state.customers[0].id);
  await assert.rejects(service.create({ ...request({ email: 'someone-else@example.test', idempotencyKey: 'order-key-00000002' }), identity }), (error: unknown) => error instanceof BadRequestException && /must match/.test(error.message));
  // A matching (differently cased) body email is accepted and is the same idempotent request.
  const again = await service.create({ ...request({ email: ' OWNER@example.test ' }), identity });
  assert.equal(again.id, order.id);
  assert.equal(state.orders.length, 1);
  // With a resolver-supplied customer id the row is used as is.
  const byId = await service.create({ ...request({ email: undefined, idempotencyKey: 'order-key-00000003' }), identity: { email: 'owner@example.test', customerId: state.customers[0].id } });
  assert.equal(byId.customerId, state.customers[0].id);
});

test('an anonymous order is accepted in development/test and is 401 in every production-like runtime (fail closed)', async () => {
  for (const nodeEnv of ['development', 'test']) {
    process.env.NODE_ENV = nodeEnv;
    const { service } = setup();
    assert.ok((await service.create(request())).id, nodeEnv);
  }
  for (const nodeEnv of ['production', undefined, 'staging', 'Production', '']) {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    const { service, state } = setup();
    await assert.rejects(service.create(request()), UnauthorizedException, String(nodeEnv));
    assert.equal(state.orders.length, 0);
    assert.equal(stock(state, 'p-a'), 5);
    // With an identity it is accepted, in any runtime.
    assert.ok((await service.create({ ...request({ email: undefined }), identity: { email: 'x@example.test' } })).id);
  }
});

test('quote: priced lines, totals and unavailable reasons; reserves and writes nothing', async () => {
  const { service, state } = setup({ SHIPPING_FLAT_CENTS: '500', SHIPPING_FREE_OVER_CENTS: '4000', TAX_RATE_BPS: '1000' });
  const quote = await service.quote({
    items: [
      { productId: 'p-a', lotCode: 'LOT-A', quantity: 2 },
      { productId: 'p-b', lotCode: 'LOT-B1', quantity: 2 },
      { productId: 'p-b', lotCode: 'LOT-B2', quantity: 2 },
      { productId: 'p-off', lotCode: 'LOT-OFF', quantity: 1 },
      { productId: 'p-a', lotCode: 'LOT-NOPE', quantity: 1 },
      { productId: 'does-not-exist', lotCode: 'LOT-A', quantity: 1 },
    ],
  });
  assert.equal(quote.currency, 'USD');
  assert.deepEqual(quote.lines, [
    { productId: 'p-a', lotCode: 'LOT-A', quantity: 2, unitCents: 1000, lineCents: 2000 },
    { productId: 'p-b', lotCode: 'LOT-B1', quantity: 2, unitCents: 250, lineCents: 500 },
    { productId: 'p-b', lotCode: 'LOT-B2', quantity: 2, unitCents: 250, lineCents: 500 },
  ]);
  assert.deepEqual({ s: quote.subtotalCents, h: quote.shippingCents, t: quote.taxCents, total: quote.totalCents }, { s: 3000, h: 500, t: 300, total: 3800 });
  // Per-line problems in request order, then stock shortfalls (one entry per product, counting every priced line of it).
  assert.deepEqual(quote.unavailable, [
    { productId: 'p-off', reason: 'inactive', available: null },
    { productId: 'p-a', reason: 'unknown_lot', available: null },
    { productId: 'does-not-exist', reason: 'inactive', available: null },
    { productId: 'p-b', reason: 'out_of_stock', available: 3 },
  ]);
  assert.equal(state.orders.length, 0);
  assert.equal(state.ledger.length, 0);
  assert.equal(state.customers.length, 0);
  assert.equal(stock(state, 'p-a'), 5);
});

test('quote totals equal the totals of the order created from the same cart', async () => {
  for (const quantity of [1, 2, 3]) {
    const { service } = setup({ SHIPPING_FLAT_CENTS: '700', SHIPPING_FREE_OVER_CENTS: '1999', TAX_RATE_BPS: '725' });
    const items = [{ productId: 'p-a', lotCode: 'LOT-A', quantity }];
    const quote = await service.quote({ items });
    const order = await service.create(request({ idempotencyKey: `order-key-qty-${quantity}`, items }));
    assert.deepEqual({ s: order.subtotalCents, h: order.shippingCents, t: order.taxCents, total: order.totalCents }, { s: quote.subtotalCents, h: quote.shippingCents, t: quote.taxCents, total: quote.totalCents });
  }
});

test('quote validates like create (line count, quantity bounds, total) and an empty priced cart is all zeros', async () => {
  const { service } = setup({ SHIPPING_FLAT_CENTS: '500' });
  await assert.rejects(service.quote({ items: [] }), /at least one item/);
  await assert.rejects(service.quote({ items: Array.from({ length: 51 }, () => ({ productId: 'p-a', lotCode: 'LOT-A', quantity: 1 })) }), /at most 50 lines/);
  for (const quantity of [0, 1001, 1.5, -1]) await assert.rejects(service.quote({ items: [{ productId: 'p-a', lotCode: 'LOT-A', quantity }] }), /Quantity must be/);
  const none = await service.quote({ items: [{ productId: 'p-off', lotCode: 'LOT-OFF', quantity: 1 }] });
  assert.deepEqual({ s: none.subtotalCents, h: none.shippingCents, t: none.taxCents, total: none.totalCents, lines: none.lines.length }, { s: 0, h: 0, t: 0, total: 0, lines: 0 });
  const big: Product = { id: 'p-x', name: 'X', priceCents: 2_147_483_000, active: true, inventory: 5, lots: [{ code: 'LOT-X' }] };
  await assert.rejects(setup({ SHIPPING_FLAT_CENTS: '1000' }, [big]).service.quote({ items: [{ productId: 'p-x', lotCode: 'LOT-X', quantity: 1 }] }), /too large/);
});

test('releaseForOrder returns the held stock once; a second call and a concurrent call change nothing', async () => {
  const { service, state, prisma } = setup();
  const inventory = new InventoryService();
  const order = await service.create(request({ items: [{ productId: 'p-a', lotCode: 'LOT-A', quantity: 2 }, { productId: 'p-b', lotCode: 'LOT-B1', quantity: 1 }] }));
  assert.equal(stock(state, 'p-a'), 3);
  await Promise.all([1, 2, 3].map(() => (prisma as any).$transaction((tx: any) => inventory.releaseForOrder(tx, order.id, 'Order expired unpaid'))));
  assert.equal(stock(state, 'p-a'), 5);
  assert.equal(stock(state, 'p-b'), 3);
  assert.ok(state.orders[0].inventoryReleasedAt instanceof Date);
  assert.equal(state.ledger.filter((r) => r.kind === 'ORDER_RELEASE').length, 2);
  await (prisma as any).$transaction((tx: any) => inventory.releaseForOrder(tx, order.id, 'again'));
  assert.equal(stock(state, 'p-a'), 5);
  // An order with no reservation rows (created before holds existed) releases nothing and invents nothing.
  state.orders.push({ id: 'legacy', inventoryReleasedAt: null });
  await (prisma as any).$transaction((tx: any) => inventory.releaseForOrder(tx, 'legacy', 'x'));
  assert.equal(stock(state, 'p-a'), 5);
  assert.equal(state.ledger.filter((r) => r.orderId === 'legacy').length, 0);
});
