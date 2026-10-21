/**
 * Stock reservation, order totals, the unpaid-order sweep and admin cancel against REAL PostgreSQL.
 *
 *   TEST_DATABASE_URL=postgresql://helix@127.0.0.1:54329/helix_field?schema=agent_<name> NODE_ENV=test \
 *   pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only src/commerce/__tests__/commerce.integration.test.ts
 *
 * Refuses non-local databases. Every row is uniquely tagged and removed in `after`.
 */
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for the integration suite (run tests/run-all.mjs to see it reported as SKIPPED).');
const parsed = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || !/helix|test/i.test(parsed.pathname)) {
  throw new Error(`Refusing to run: ${parsed.hostname}${parsed.pathname} is not a local helix/test database.`);
}
process.env.DATABASE_URL = url;
if (process.env.NODE_ENV === 'production') process.env.NODE_ENV = 'test';
process.env.ORDER_SWEEP_INTERVAL_MS = '0'; // the tests drive the sweep explicitly
process.env.SHIPPING_FLAT_CENTS = '500';
process.env.SHIPPING_FREE_OVER_CENTS = '100000';
process.env.TAX_RATE_BPS = '1000';

const tag = `cm${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let app: import('@nestjs/common').INestApplication;
let prisma: import('../../prisma.service').PrismaService;
let sweeper: import('../order-sweep.service').OrderSweepService;
let inventory: import('../inventory.service').InventoryService;
let verification: import('../../wallet/checkout/verification.service').VerificationService;
let adminOrders: import('../../admin/orders/admin-orders.service').AdminOrdersService;
let base = '';
const productIds: string[] = [];
const emails: string[] = [];
const lotCodes: string[] = [];
let counter = 0;

const next = (label: string) => `${tag}-${label}-${++counter}`;
const track = (label: string) => {
  const value = `${next(label)}@example.test`;
  emails.push(value);
  return value;
};

async function mkProduct(label: string, inventoryUnits: number, priceCents = 1000, active = true) {
  const sku = next(label).toUpperCase();
  const product = await prisma.product.create({ data: { sku, slug: sku.toLowerCase(), name: `Product ${label}`, active, priceCents, inventory: inventoryUnits } });
  const lotCode = `LOT-${sku}`;
  await prisma.lot.create({ data: { code: lotCode, productId: product.id, coaKey: 'coa/test.pdf', purity: 99 } });
  productIds.push(product.id);
  lotCodes.push(lotCode);
  return { id: product.id, lotCode };
}
const stockOf = async (id: string) => (await prisma.product.findUniqueOrThrow({ where: { id } })).inventory;
const line = (p: { id: string; lotCode: string }, quantity = 1) => ({ productId: p.id, lotCode: p.lotCode, quantity });

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const orderBody = (email: string | undefined, items: unknown[]) => ({ email, shippingAddress: '1 Lab Way, Boston, MA', researchUseAcknowledged: true, items });
const placeOrder = (items: unknown[], opts: { email?: string; key?: string; headers?: Record<string, string> } = {}) =>
  post('/orders', orderBody(opts.email ?? track('buyer'), items), { 'idempotency-key': opts.key ?? next('key'), ...(opts.headers ?? {}) });

async function createOrderRow(customerEmail: string, p: { id: string; lotCode: string }, quantity: number, expiresAt: Date | null) {
  const placed = await placeOrder([line(p, quantity)], { email: customerEmail });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  if (expiresAt) await prisma.order.update({ where: { id: placed.body.id }, data: { expiresAt } });
  return placed.body.id as string;
}
const past = () => new Date(Date.now() - 60_000);
const orderRow = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });
const ledger = (productId: string) => prisma.inventoryAdjustment.findMany({ where: { productId }, orderBy: { createdAt: 'asc' } });
const customerIdOf = async (orderId: string) => (await orderRow(orderId)).customerId;

async function mkPurchase(orderId: string, status: 'PREPARED' | 'SUBMITTED' | 'CONFIRMED' | 'FINALIZED' | 'FAILED' | 'EXPIRED', reservation: 'ACTIVE_LIVE' | 'ACTIVE_EXPIRED' | 'NONE' = 'NONE') {
  const customerId = await customerIdOf(orderId);
  const order = await orderRow(orderId);
  const reference = `chk_${next('ref')}`;
  const row = await prisma.cryptoTransaction.create({
    data: {
      customerId, type: 'PURCHASE', status, amountAtomic: BigInt(order.totalCents) * 10_000n, sourceAddress: `SRC-${tag}`, destinationAddress: `DST-${tag}`,
      mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', network: 'solana-devnet', reference, orderId,
      txSignature: status === 'PREPARED' ? null : `sig-${reference}`,
    },
  });
  if (reservation !== 'NONE') {
    await prisma.creditReservation.create({
      data: { customerId, orderId, amountAtomic: row.amountAtomic, status: 'ACTIVE', expiresAt: new Date(Date.now() + (reservation === 'ACTIVE_LIVE' ? 600_000 : -60_000)) },
    });
  }
  return row;
}

before(async () => {
  const { Global, Module, ValidationPipe } = await import('@nestjs/common');
  const { Test } = await import('@nestjs/testing');
  const { PrismaService } = await import('../../prisma.service');
  const { OrdersModule } = await import('../../orders/orders.module');
  const { OrderSweepService } = await import('../order-sweep.service');
  const { InventoryService } = await import('../inventory.service');
  const { AdminOrdersService } = await import('../../admin/orders/admin-orders.service');
  const { AdminAuditService } = await import('../../admin/admin-audit.service');
  const { VerificationService } = await import('../../wallet/checkout/verification.service');
  const { referenceKeyFor } = await import('../../wallet/checkout/checkout.util');

  prisma = new PrismaService();
  await prisma.$connect();
  const real = prisma;
  @Global()
  @Module({ providers: [{ provide: PrismaService, useValue: real }], exports: [PrismaService] })
  class RealPrismaModule {}
  const moduleRef = await Test.createTestingModule({ imports: [RealPrismaModule, OrdersModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  sweeper = moduleRef.get(OrderSweepService, { strict: false });
  inventory = moduleRef.get(InventoryService, { strict: false });
  adminOrders = new AdminOrdersService(prisma, new AdminAuditService(prisma), undefined, inventory);

  // A fake chain that reports exactly the transfer that was prepared: lets the REAL VerificationService settle in the race tests.
  const chain = {
    network: 'solana-devnet',
    getTransfer: async (signature: string) => {
      const row = await prisma.cryptoTransaction.findUniqueOrThrow({ where: { txSignature: signature } });
      return {
        signature, network: 'solana-devnet', finalized: true, succeeded: true, mint: row.mint, sourceOwner: row.sourceAddress, destinationOwner: row.destinationAddress,
        amountAtomic: row.amountAtomic, referenceKeys: [referenceKeyFor(row.reference).toBase58()],
      };
    },
  };
  verification = new VerificationService(prisma, chain as never, { enableLiveFulfillment: false } as never, { trigger: async () => undefined } as never);
});

after(async () => {
  try {
    const customers = await prisma.customer.findMany({ where: { email: { in: emails } }, select: { id: true } });
    const ids = customers.map((customer) => customer.id);
    const orders = await prisma.order.findMany({ where: { customerId: { in: ids } }, select: { id: true } });
    const orderIds = orders.map((order) => order.id);
    await prisma.adminAuditEvent.deleteMany({ where: { targetId: { in: orderIds } } });
    await prisma.walletAuditEvent.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.orderEvent.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.creditReservation.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.cryptoTransaction.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.inventoryAdjustment.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
    await prisma.lot.deleteMany({ where: { code: { in: lotCodes } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
  } finally {
    await app?.close();
    await prisma?.$disconnect();
  }
});

// ------------------------------------------------------------------------------------------------ totals + quote

test('POST /orders stores subtotal, shipping, tax and total; the quote for the same cart gives the same numbers; the replay returns the original', async () => {
  const p = await mkProduct('totals', 10, 1250);
  const items = [line(p, 2)];
  const quote = await post('/orders/quote', { items });
  assert.equal(quote.status, 200, JSON.stringify(quote.body));
  // 2 x 1250 = 2500; shipping 500 (flat, not over 100000); tax 10% of 2500 = 250.
  assert.deepEqual(quote.body, {
    currency: 'USD', subtotalCents: 2500, shippingCents: 500, taxCents: 250, totalCents: 3250,
    lines: [{ productId: p.id, lotCode: p.lotCode, quantity: 2, unitCents: 1250, lineCents: 2500 }], unavailable: [],
  });
  assert.equal(await stockOf(p.id), 10, 'a quote reserves nothing');
  assert.equal((await ledger(p.id)).length, 0);

  const key = next('key');
  const email = track('totals');
  const created = await post('/orders', orderBody(email, items), { 'idempotency-key': key });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual({ s: created.body.subtotalCents, h: created.body.shippingCents, t: created.body.taxCents, total: created.body.totalCents }, { s: 2500, h: 500, t: 250, total: 3250 });
  assert.ok(!('shippingAddress' in created.body));
  const row = await orderRow(created.body.id);
  assert.equal(row.subtotalCents! + row.shippingCents + row.taxCents, row.totalCents);
  const holdMs = row.expiresAt!.getTime() - row.createdAt.getTime();
  assert.ok(Math.abs(holdMs - 60 * 60_000) < 5_000, `default hold is 60 minutes (got ${holdMs}ms)`);
  assert.equal(await stockOf(p.id), 8);

  const replay = await post('/orders', orderBody(email, items), { 'idempotency-key': key });
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.body, created.body);
  assert.equal(await stockOf(p.id), 8, 'a replay does not reserve again');
  assert.equal((await ledger(p.id)).length, 1);
});

test('shipping is free above the threshold; quote reports out_of_stock, inactive and unknown_lot and rejects bad input with 400', async () => {
  const rich = await mkProduct('rich', 5, 60_000);
  const free = await post('/orders/quote', { items: [line(rich, 2)] });
  assert.deepEqual({ sub: free.body.subtotalCents, ship: free.body.shippingCents, tax: free.body.taxCents }, { sub: 120_000, ship: 0, tax: 12_000 });
  const low = await mkProduct('low', 1);
  const off = await mkProduct('off', 5, 100, false);
  const quote = await post('/orders/quote', { items: [line(low, 3), line(off), { productId: low.id, lotCode: 'NO-SUCH-LOT', quantity: 1 }] });
  assert.equal(quote.status, 200);
  assert.deepEqual(quote.body.unavailable, [
    { productId: off.id, reason: 'inactive', available: null },
    { productId: low.id, reason: 'unknown_lot', available: null },
    { productId: low.id, reason: 'out_of_stock', available: 1 },
  ]);
  assert.equal(quote.body.lines.length, 1);
  for (const body of [{}, { items: [] }, { items: [{ productId: low.id, lotCode: low.lotCode, quantity: 0 }] }, { items: [{ productId: low.id, lotCode: low.lotCode, quantity: 1001 }] }, { items: 'x' }]) {
    assert.equal((await post('/orders/quote', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await post('/orders/quote', { items: Array.from({ length: 51 }, () => line(low)) })).status, 400);
  const expensive = await mkProduct('pricey', 5, 2_000_000_000);
  assert.equal((await post('/orders/quote', { items: [line(expensive, 2)] })).status, 400, 'total beyond Int32');
});

// ------------------------------------------------------------------------------------------------ reservation

test('CONCURRENCY: 20 parallel orders for a product with stock 5 sell exactly 5 units, never negative, 15 get 409 OUT_OF_STOCK', async () => {
  const p = await mkProduct('hot', 5);
  const results = await Promise.all(Array.from({ length: 20 }, () => placeOrder([line(p)])));
  const created = results.filter((r) => r.status === 201);
  const refused = results.filter((r) => r.status === 409);
  assert.equal(created.length, 5, JSON.stringify(results.map((r) => r.status)));
  assert.equal(refused.length, 15);
  for (const r of refused) {
    assert.equal(r.body.code, 'OUT_OF_STOCK');
    assert.equal(r.body.productId, p.id);
    assert.equal(typeof r.body.available, 'number');
    assert.match(r.body.message, /^Insufficient stock for Product hot\.$/);
  }
  assert.equal(await stockOf(p.id), 0);
  const rows = await ledger(p.id);
  assert.equal(rows.length, 5);
  assert.ok(rows.every((row) => row.kind === 'ORDER_RESERVE' && row.delta === -1 && row.orderId));
  assert.equal(new Set(rows.map((row) => row.orderId)).size, 5);
  assert.equal(await prisma.order.count({ where: { items: { some: { productId: p.id } } } }), 5, 'a refused order leaves no order row behind');
});

test('CONCURRENCY: 20 parallel orders of 2 units against stock 5 sell 4 units (2 orders), 1 unit stays', async () => {
  const p = await mkProduct('pairs', 5);
  const results = await Promise.all(Array.from({ length: 20 }, () => placeOrder([line(p, 2)])));
  assert.equal(results.filter((r) => r.status === 201).length, 2);
  assert.equal(results.filter((r) => r.status === 409).length, 18);
  assert.equal(await stockOf(p.id), 1);
});

test('CONCURRENCY: opposite line order over two products never deadlocks and never half-reserves (40 parallel orders, stock 10 each)', async () => {
  const a = await mkProduct('dl-a', 10);
  const b = await mkProduct('dl-b', 10);
  const results = await Promise.all(Array.from({ length: 40 }, (_, n) => placeOrder(n % 2 ? [line(a), line(b)] : [line(b), line(a)])));
  const statuses = results.map((r) => r.status);
  assert.ok(statuses.every((s) => s === 201 || s === 409), `only 201/409 expected, got ${JSON.stringify(statuses)} ${JSON.stringify(results.find((r) => r.status >= 500)?.body)}`);
  assert.equal(statuses.filter((s) => s === 201).length, 10);
  assert.equal(await stockOf(a.id), 0);
  assert.equal(await stockOf(b.id), 0);
  assert.equal((await ledger(a.id)).length, 10);
  assert.equal((await ledger(b.id)).length, 10);
  // Every order that exists holds BOTH products (no order with a single reservation).
  const orders = await prisma.order.findMany({ where: { items: { some: { productId: a.id } } }, include: { items: true } });
  assert.equal(orders.length, 10);
  assert.ok(orders.every((order) => order.items.length === 2));
});

test('CONCURRENCY: plentiful stock, opposite line order: all 40 succeed and stock is exact', async () => {
  const a = await mkProduct('dl2-a', 100);
  const b = await mkProduct('dl2-b', 100);
  const results = await Promise.all(Array.from({ length: 40 }, (_, n) => placeOrder(n % 2 ? [line(a, 2), line(b)] : [line(b), line(a, 2)])));
  assert.deepEqual([...new Set(results.map((r) => r.status))], [201], JSON.stringify(results.find((r) => r.status !== 201)?.body));
  assert.equal(await stockOf(a.id), 100 - 80);
  assert.equal(await stockOf(b.id), 100 - 40);
});

test('a failing line rolls back every reservation of the order (409 names the failing product)', async () => {
  const plenty = await mkProduct('rb-plenty', 5);
  const short = await mkProduct('rb-short', 1);
  const email = track('rollback');
  const res = await placeOrder([line(plenty, 2), line(short, 2)], { email });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { code: 'OUT_OF_STOCK', message: 'Insufficient stock for Product rb-short.', productId: short.id, available: 1 });
  assert.equal(await stockOf(plenty.id), 5);
  assert.equal(await stockOf(short.id), 1);
  assert.equal((await ledger(plenty.id)).length + (await ledger(short.id)).length, 0);
  assert.equal(await prisma.order.count({ where: { customer: { email } } }), 0);
});

test('two lines of one product (different lots) are one stock pool', async () => {
  const p = await mkProduct('pool', 3);
  const lot2 = `${p.lotCode}-B`;
  await prisma.lot.create({ data: { code: lot2, productId: p.id, coaKey: 'coa/test.pdf', purity: 99 } });
  lotCodes.push(lot2);
  const refused = await placeOrder([line(p, 2), { productId: p.id, lotCode: lot2, quantity: 2 }]);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.available, 3);
  const ok = await placeOrder([line(p, 2), { productId: p.id, lotCode: lot2, quantity: 1 }]);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(await stockOf(p.id), 0);
  const rows = await ledger(p.id);
  assert.deepEqual(rows.map((r) => r.delta), [-3], 'one ledger row per (order, product, kind)');
});

test('parallel IDENTICAL requests (same key) reserve exactly once', async () => {
  const p = await mkProduct('same-key', 10);
  const email = track('samekey');
  const key = next('key');
  const results = await Promise.all(Array.from({ length: 10 }, () => post('/orders', orderBody(email, [line(p, 3)]), { 'idempotency-key': key })));
  assert.deepEqual([...new Set(results.map((r) => r.status))], [201], JSON.stringify(results.find((r) => r.status !== 201)?.body));
  assert.equal(new Set(results.map((r) => r.body.id)).size, 1);
  assert.equal(await stockOf(p.id), 7);
  assert.equal((await ledger(p.id)).length, 1);
});

// ------------------------------------------------------------------------------------------------ identity

test('identity: a development header customer owns the order; a different body email is 400; a body without email is accepted; production-like is 401 without identity', async () => {
  const p = await mkProduct('identity', 20);
  const email = track('identity');
  const headers = { 'x-customer-email': email };
  const owned = await post('/orders', orderBody(undefined, [line(p)]), { 'idempotency-key': next('key'), ...headers });
  assert.equal(owned.status, 201, JSON.stringify(owned.body));
  assert.equal((await prisma.customer.findUniqueOrThrow({ where: { id: owned.body.customerId } })).email, email);
  const other = track('other');
  const mismatch = await post('/orders', orderBody(other, [line(p)]), { 'idempotency-key': next('key'), ...headers });
  assert.equal(mismatch.status, 400);
  assert.equal(await prisma.customer.count({ where: { email: other } }), 0, 'nothing is created for the other email');
  assert.equal(await stockOf(p.id), 19, 'the refused order reserved nothing');
  const matching = await post('/orders', orderBody(` ${email.toUpperCase()} `, [line(p)]), { 'idempotency-key': next('key'), ...headers });
  assert.equal(matching.status, 201);
  // Anonymous in development/test keeps working.
  assert.equal((await placeOrder([line(p)])).status, 201);

  const saved = process.env.NODE_ENV;
  try {
    for (const nodeEnv of ['production', 'staging']) {
      process.env.NODE_ENV = nodeEnv;
      const before = await stockOf(p.id);
      const denied = await placeOrder([line(p)], { headers });
      assert.equal(denied.status, 401, `${nodeEnv}: the dev header and a body email are not an identity: ${JSON.stringify(denied.body)}`);
      assert.equal(await stockOf(p.id), before);
    }
  } finally {
    process.env.NODE_ENV = saved;
  }
});

// ------------------------------------------------------------------------------------------------ sweep

test('sweep: an expired unpaid order is cancelled and its stock returned in one transaction, with a STATUS event; unexpired orders are untouched', async () => {
  const p = await mkProduct('sweep', 10);
  const expired = await createOrderRow(track('exp'), p, 3, past());
  const fresh = await createOrderRow(track('fresh'), p, 2, null);
  assert.equal(await stockOf(p.id), 5);

  const summary = await sweeper.sweep();
  assert.ok(summary.cancelled >= 1);
  const cancelled = await orderRow(expired);
  assert.equal(cancelled.status, 'CANCELLED');
  assert.ok(cancelled.inventoryReleasedAt);
  assert.equal((await orderRow(fresh)).status, 'PENDING_PAYMENT');
  assert.equal(await stockOf(p.id), 8, 'only the expired order\'s 3 units came back');

  const events = await prisma.orderEvent.findMany({ where: { orderId: expired } });
  assert.deepEqual(events.map((e) => ({ kind: e.kind, from: e.fromStatus, to: e.toStatus, note: e.note, adminId: e.adminId })), [
    { kind: 'STATUS', from: 'PENDING_PAYMENT', to: 'CANCELLED', note: 'Expired unpaid', adminId: null },
  ]);
  const rows = (await ledger(p.id)).filter((r) => r.orderId === expired);
  assert.deepEqual(rows.map((r) => [r.kind, r.delta]).sort(), [['ORDER_RELEASE', 3], ['ORDER_RESERVE', -3]]);

  // Running it again (or on another instance) changes nothing.
  await Promise.all([sweeper.sweep(), sweeper.sweep(), sweeper.sweep()]);
  assert.equal(await stockOf(p.id), 8);
  assert.equal((await ledger(p.id)).filter((r) => r.orderId === expired).length, 2);
  assert.equal((await prisma.orderEvent.findMany({ where: { orderId: expired } })).length, 1);
});

test('sweep: 5 instances sweeping one expired order at once cancel and release it exactly once', async () => {
  const p = await mkProduct('multi', 10);
  const id = await createOrderRow(track('multi'), p, 4, past());
  const results = await Promise.all(Array.from({ length: 5 }, () => sweeper.sweepOne(id, new Date())));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await stockOf(p.id), 10);
  assert.equal((await prisma.orderEvent.findMany({ where: { orderId: id } })).length, 1);
  assert.equal((await ledger(p.id)).filter((r) => r.kind === 'ORDER_RELEASE').length, 1);
});

test('sweep SKIPS an order whose purchase is SUBMITTED, CONFIRMED or FINALIZED, or PREPARED with a live reservation (stock stays held)', async () => {
  const p = await mkProduct('inflight', 20);
  const cases: Array<[string, Parameters<typeof mkPurchase>[1], Parameters<typeof mkPurchase>[2]]> = [
    ['SUBMITTED', 'SUBMITTED', 'ACTIVE_LIVE'],
    ['SUBMITTED, reservation already lapsed', 'SUBMITTED', 'ACTIVE_EXPIRED'],
    ['SUBMITTED, no reservation row', 'SUBMITTED', 'NONE'],
    ['CONFIRMED', 'CONFIRMED', 'ACTIVE_LIVE'],
    ['FINALIZED', 'FINALIZED', 'NONE'],
    ['PREPARED with a live reservation', 'PREPARED', 'ACTIVE_LIVE'],
  ];
  for (const [label, status, reservation] of cases) {
    const id = await createOrderRow(track('skip'), p, 1, past());
    const before = await stockOf(p.id);
    const row = await mkPurchase(id, status, reservation);
    assert.equal(await sweeper.sweepOne(id, new Date()), false, label);
    const order = await orderRow(id);
    assert.equal(order.status, 'PENDING_PAYMENT', label);
    assert.equal(order.inventoryReleasedAt, null, label);
    assert.equal(await stockOf(p.id), before, label);
    assert.equal((await prisma.cryptoTransaction.findUniqueOrThrow({ where: { id: row.id } })).status, status, `${label}: the payment row is not touched`);
    assert.equal((await prisma.orderEvent.findMany({ where: { orderId: id } })).length, 0, label);
    if (reservation !== 'NONE') assert.equal((await prisma.creditReservation.findUniqueOrThrow({ where: { orderId: id } })).status, 'ACTIVE', `${label}: reservation untouched`);
  }
  // The whole-sweep entry point skips them too.
  await sweeper.sweep();
  assert.equal(await prisma.order.count({ where: { items: { some: { productId: p.id } }, status: 'CANCELLED' } }), 0);
});

test('sweep cancels when the only purchases are dead: PREPARED with a lapsed reservation, FAILED, EXPIRED; it retires the leftovers', async () => {
  const p = await mkProduct('dead', 20);
  const lapsed = await createOrderRow(track('lapsed'), p, 2, past());
  const prepared = await mkPurchase(lapsed, 'PREPARED', 'ACTIVE_EXPIRED');
  const failed = await createOrderRow(track('failed'), p, 2, past());
  await mkPurchase(failed, 'FAILED', 'NONE');
  const expired = await createOrderRow(track('expired'), p, 2, past());
  await mkPurchase(expired, 'EXPIRED', 'NONE');
  assert.equal(await stockOf(p.id), 14);
  for (const id of [lapsed, failed, expired]) assert.equal(await sweeper.sweepOne(id, new Date()), true);
  assert.equal(await stockOf(p.id), 20);
  assert.equal((await prisma.cryptoTransaction.findUniqueOrThrow({ where: { id: prepared.id } })).status, 'EXPIRED');
  assert.equal((await prisma.creditReservation.findUniqueOrThrow({ where: { orderId: lapsed } })).status, 'RELEASED');
  for (const id of [lapsed, failed, expired]) assert.equal((await orderRow(id)).status, 'CANCELLED');
});

test('RACE settlement vs sweep: a SUBMITTED payment settling while the sweep runs always ends PAID with stock still held (20 rounds)', async () => {
  const p = await mkProduct('settle', 100);
  for (let round = 0; round < 20; round++) {
    const id = await createOrderRow(track('settle'), p, 2, past());
    const row = await mkPurchase(id, 'SUBMITTED', 'ACTIVE_LIVE');
    const [settled, swept] = await Promise.all([verification.verifyAndSettle({ paymentReference: row.reference }), sweeper.sweepOne(id, new Date())]);
    assert.equal(swept, false, `round ${round}`);
    assert.equal(settled.outcome, 'FINALIZED', `round ${round}: ${JSON.stringify(settled)}`);
    const order = await orderRow(id);
    assert.equal(order.status, 'PAID');
    assert.equal(order.inventoryReleasedAt, null, 'a paid order keeps its stock');
    assert.equal((await prisma.cryptoTransaction.findUniqueOrThrow({ where: { id: row.id } })).status, 'FINALIZED');
  }
  assert.equal(await stockOf(p.id), 100 - 40);
});

test('RACE submit-claim vs sweep: either the order is cancelled with the payment row expired, or it stays pending with the payment SUBMITTED; never both (30 rounds)', async () => {
  const p = await mkProduct('claim', 100);
  let cancelled = 0;
  let claimed = 0;
  for (let round = 0; round < 30; round++) {
    const id = await createOrderRow(track('claim'), p, 1, past());
    const row = await mkPurchase(id, 'PREPARED', 'ACTIVE_EXPIRED');
    const [claim, swept] = (await Promise.all([
      // The same compare-and-set CheckoutService.submit uses to claim a prepared payment. The claim starts after a varying delay so
      // that it lands before, inside and after the sweep transaction across rounds.
      new Promise((resolve) => setTimeout(resolve, [0, 2, 4, 6, 8, 12, 20][round % 7])).then(() => prisma.cryptoTransaction.updateMany({ where: { id: row.id, status: 'PREPARED' }, data: { status: 'SUBMITTED', txSignature: `sig-claim-${round}-${tag}` } })),
      sweeper.sweepOne(id, new Date()),
    ])) as [{ count: number }, boolean];
    const order = await orderRow(id);
    const payment = await prisma.cryptoTransaction.findUniqueOrThrow({ where: { id: row.id } });
    if (claim.count === 1) {
      claimed += 1;
      assert.equal(swept, false, `round ${round}: a claimed payment must not be swept`);
      assert.equal(order.status, 'PENDING_PAYMENT');
      assert.equal(payment.status, 'SUBMITTED');
      assert.equal(order.inventoryReleasedAt, null);
    } else {
      cancelled += 1;
      assert.equal(swept, true, `round ${round}`);
      assert.equal(order.status, 'CANCELLED');
      assert.equal(payment.status, 'EXPIRED');
      assert.ok(order.inventoryReleasedAt);
    }
  }
  assert.equal(claimed + cancelled, 30);
  // Remember what actually happened for the report (both outcomes are valid; the invariant above is what matters).
  console.log(`# race submit-claim vs sweep: claimed=${claimed} cancelled=${cancelled}`);
});

// ------------------------------------------------------------------------------------------------ release + admin cancel

test('admin cancel returns the stock in the same transaction; a second cancel and a later sweep release nothing more', async () => {
  const p = await mkProduct('admin-cancel', 10);
  const id = await createOrderRow(track('cancel'), p, 4, null);
  assert.equal(await stockOf(p.id), 6);
  const detail = await adminOrders.cancel(id, 'customer asked', { id: null as never, ip: null });
  assert.equal(detail.status, 'CANCELLED');
  assert.equal(await stockOf(p.id), 10);
  assert.ok((await orderRow(id)).inventoryReleasedAt);
  assert.deepEqual((await ledger(p.id)).map((r) => [r.kind, r.delta]).sort(), [['ORDER_RELEASE', 4], ['ORDER_RESERVE', -4]]);
  await assert.rejects(adminOrders.cancel(id, 'again', { id: null as never, ip: null }), /cannot cancel/);
  await sweeper.sweep();
  assert.equal(await stockOf(p.id), 10);
});

test('admin cancel racing the sweep: exactly one of them cancels, stock is returned exactly once', async () => {
  const p = await mkProduct('cancel-race', 10);
  for (let round = 0; round < 10; round++) {
    const id = await createOrderRow(track('cr'), p, 1, past());
    const results = await Promise.allSettled([adminOrders.cancel(id, 'x', { id: null as never, ip: null }), sweeper.sweepOne(id, new Date())]);
    const adminWon = results[0].status === 'fulfilled';
    const sweepWon = results[1].status === 'fulfilled' && results[1].value === true;
    assert.equal(Number(adminWon) + Number(sweepWon), 1, `round ${round}: ${JSON.stringify(results.map((r) => r.status))}`);
    assert.equal((await orderRow(id)).status, 'CANCELLED');
  }
  assert.equal(await stockOf(p.id), 10);
  assert.equal((await ledger(p.id)).filter((r) => r.kind === 'ORDER_RELEASE').length, 10);
});

test('releaseForOrder is idempotent and safe under 8 concurrent callers; an order with no reservation rows releases nothing', async () => {
  const p = await mkProduct('release', 10);
  const id = await createOrderRow(track('rel'), p, 3, null);
  await Promise.all(Array.from({ length: 8 }, () => prisma.$transaction((tx) => inventory.releaseForOrder(tx, id, 'refund before shipping'))));
  assert.equal(await stockOf(p.id), 10);
  assert.equal((await ledger(p.id)).filter((r) => r.kind === 'ORDER_RELEASE').length, 1);
  assert.equal((await ledger(p.id)).find((r) => r.kind === 'ORDER_RELEASE')!.reason, 'refund before shipping');
  // A legacy order (no ORDER_RESERVE rows) just gets its flag set.
  const email = track('legacy');
  const customer = await prisma.customer.create({ data: { email } });
  const legacy = await prisma.order.create({ data: { customerId: customer.id, totalCents: 100, items: { create: [{ productId: p.id, lotCode: p.lotCode, quantity: 5, unitCents: 20 }] } } });
  await prisma.$transaction((tx) => inventory.releaseForOrder(tx, legacy.id, 'legacy'));
  assert.equal(await stockOf(p.id), 10, 'nothing is invented for an order that never reserved stock');
  assert.ok((await orderRow(legacy.id)).inventoryReleasedAt);
});

test('a rolled-back transaction leaves the release undone (claim and stock move together)', async () => {
  const p = await mkProduct('rollback-release', 10);
  const id = await createOrderRow(track('rr'), p, 3, null);
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      await inventory.releaseForOrder(tx, id, 'x');
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(await stockOf(p.id), 7);
  assert.equal((await orderRow(id)).inventoryReleasedAt, null);
  await prisma.$transaction((tx) => inventory.releaseForOrder(tx, id, 'x'));
  assert.equal(await stockOf(p.id), 10);
});
