/**
 * Admin inventory API against REAL PostgreSQL with the REAL admin session guard (OWNER and STAFF sessions).
 *
 *   TEST_DATABASE_URL=postgresql://helix@127.0.0.1:54329/helix_field?schema=agent_<name> NODE_ENV=test \
 *   pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only src/admin/inventory/__tests__/admin-inventory.integration.test.ts
 *
 * Refuses non-local databases; every row is tagged and removed in `after`.
 */
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for the integration suite (run tests/run-all.mjs to see it reported as SKIPPED).');
const parsed = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || !/helix|test/i.test(parsed.pathname)) {
  throw new Error(`Refusing to run: ${parsed.hostname}${parsed.pathname} is not a local helix/test database.`);
}
process.env.DATABASE_URL = url;
if (process.env.NODE_ENV === 'production') process.env.NODE_ENV = 'test';

const tag = `inv${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let app: import('@nestjs/common').INestApplication;
let prisma: import('../../../prisma.service').PrismaService;
let base = '';
let owner: { id: string; token: string };
let staff: { id: string; token: string };
const productIds: string[] = [];
const customerIds: string[] = [];
const orderIds: string[] = [];
const adminIds: string[] = [];
let n = 0;

async function call(method: string, path: string, body?: unknown, token: string | null = owner.token) {
  const res = await fetch(`${base}/v1/admin/inventory${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: (await res.json().catch(() => null)) as any };
}
async function mkProduct(label: string, inventory: number, extra: { active?: boolean; lowStockThreshold?: number | null; name?: string } = {}) {
  const sku = `${tag}-${label}-${++n}`.toUpperCase();
  const product = await prisma.product.create({
    data: { sku, slug: sku.toLowerCase(), name: extra.name ?? `Peptide ${label}`, active: extra.active ?? true, priceCents: 1000, inventory, lowStockThreshold: extra.lowStockThreshold ?? null },
  });
  productIds.push(product.id);
  return product;
}
async function mkAdmin(role: 'OWNER' | 'STAFF') {
  const { hashSessionToken } = await import('../../admin-session.guard');
  const user = await prisma.adminUser.create({ data: { email: `${tag}-${role.toLowerCase()}@example.test`, name: `${role} Person`, role, passwordHash: 'x', mfaSeedEnc: 'x' } });
  adminIds.push(user.id);
  const token = randomBytes(32).toString('base64url');
  await prisma.adminSession.create({ data: { adminId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3_600_000) } });
  return { id: user.id, token };
}
async function mkOrder(productId: string, quantity: number, over: { status?: 'PENDING_PAYMENT' | 'PAID'; expiresAt?: Date | null; released?: boolean }) {
  const customer = await prisma.customer.create({ data: { email: `${tag}-c${++n}@example.test` } });
  customerIds.push(customer.id);
  const order = await prisma.order.create({
    data: {
      customerId: customer.id, totalCents: 1000 * quantity, status: over.status ?? 'PENDING_PAYMENT', expiresAt: over.expiresAt === undefined ? new Date(Date.now() + 3_600_000) : over.expiresAt,
      inventoryReleasedAt: over.released ? new Date() : null, items: { create: [{ productId, lotCode: `LOT-${tag}`, quantity, unitCents: 1000 }] },
    },
  });
  orderIds.push(order.id);
  return order;
}

before(async () => {
  const { Global, Module, ValidationPipe } = await import('@nestjs/common');
  const { Test } = await import('@nestjs/testing');
  const { PrismaService } = await import('../../../prisma.service');
  const { AdminCoreModule } = await import('../../admin-core.module');
  const { AdminInventoryModule } = await import('../admin-inventory.module');
  prisma = new PrismaService();
  await prisma.$connect();
  const real = prisma;
  @Global()
  @Module({ providers: [{ provide: PrismaService, useValue: real }], exports: [PrismaService] })
  class RealPrismaModule {}
  const moduleRef = await Test.createTestingModule({ imports: [RealPrismaModule, AdminCoreModule, AdminInventoryModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  owner = await mkAdmin('OWNER');
  staff = await mkAdmin('STAFF');
});

after(async () => {
  try {
    await prisma.adminAuditEvent.deleteMany({ where: { OR: [{ targetId: { in: productIds } }, { adminId: { in: adminIds } }] } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    await prisma.inventoryAdjustment.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.adminSession.deleteMany({ where: { adminId: { in: adminIds } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: adminIds } } });
  } finally {
    await app?.close();
    await prisma?.$disconnect();
  }
});

test('every route needs a valid admin session; the threshold needs OWNER (STAFF is 403) and nothing changes without it', async () => {
  const p = await mkProduct('guard', 5);
  const routes: Array<[string, string, unknown?]> = [
    ['GET', ''],
    ['POST', `/${p.id}/adjust`, { delta: 1, reason: 'x' }],
    ['GET', `/${p.id}/ledger`],
    ['POST', `/${p.id}/threshold`, { lowStockThreshold: 3 }],
  ];
  for (const [method, path, body] of routes) {
    assert.equal((await call(method, path, body, null)).status, 401, `${method} ${path} without a token`);
    assert.equal((await call(method, path, body, randomBytes(32).toString('base64url'))).status, 401, `${method} ${path} unknown token`);
  }
  assert.equal((await call('POST', `/${p.id}/threshold`, { lowStockThreshold: 3 }, staff.token)).status, 403);
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).lowStockThreshold, null);
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).inventory, 5);
  // STAFF may list, adjust and read the ledger.
  assert.equal((await call('GET', `?q=${tag}`, undefined, staff.token)).status, 200);
  assert.equal((await call('POST', `/${p.id}/adjust`, { delta: 1, reason: 'staff ok' }, staff.token)).status, 200);
  assert.equal((await call('GET', `/${p.id}/ledger`, undefined, staff.token)).status, 200);
  assert.equal((await call('POST', `/${p.id}/threshold`, { lowStockThreshold: 3 })).status, 200);
});

test('list: item shape, onHand, reserved (unpaid + unexpired + unreleased only), lowStock boundary, search, no-store', async () => {
  const p = await mkProduct('shape', 20, { lowStockThreshold: 20, name: 'Shape Peptide' });
  await mkOrder(p.id, 3, {}); // held
  await mkOrder(p.id, 4, {}); // held
  await mkOrder(p.id, 100, { expiresAt: new Date(Date.now() - 1000) }); // hold ran out
  await mkOrder(p.id, 100, { status: 'PAID' }); // paid: no longer a hold
  await mkOrder(p.id, 100, { released: true }); // already released
  await mkOrder(p.id, 100, { expiresAt: null }); // legacy order without a hold
  const res = await call('GET', `?q=${encodeURIComponent(p.sku.toLowerCase())}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(res.body, {
    items: [{ productId: p.id, sku: p.sku, name: 'Shape Peptide', active: true, onHand: 20, reserved: 7, lowStockThreshold: 20, lowStock: true }],
    nextCursor: null,
  });
  // lowStock: at the threshold is low, one above is not, no threshold is never low.
  await prisma.product.update({ where: { id: p.id }, data: { lowStockThreshold: 19 } });
  assert.equal((await call('GET', `?q=${p.sku}`)).body.items[0].lowStock, false);
  await prisma.product.update({ where: { id: p.id }, data: { lowStockThreshold: null } });
  assert.equal((await call('GET', `?q=${p.sku}`)).body.items[0].lowStock, false);
  // Name search is case-insensitive; LIKE wildcards are literal.
  assert.equal((await call('GET', `?q=${encodeURIComponent('shape pept')}`)).body.items.some((i: any) => i.productId === p.id), true);
  assert.deepEqual((await call('GET', `?q=${encodeURIComponent('%')}`)).body.items.filter((i: any) => i.sku.startsWith(tag.toUpperCase())), []);
});

test('list: lowStockOnly, keyset pagination by SKU with no gaps or repeats, and input validation', async () => {
  const low = await mkProduct('pg-low', 2, { lowStockThreshold: 5 });
  await mkProduct('pg-ok', 50, { lowStockThreshold: 5 });
  await mkProduct('pg-none', 0);
  const edge = await mkProduct('pg-edge', 5, { lowStockThreshold: 5 });
  const only = await call('GET', `?q=${tag}-pg&lowStockOnly=true`);
  assert.deepEqual(only.body.items.map((i: any) => i.productId).sort(), [low.id, edge.id].sort());
  assert.ok(only.body.items.every((i: any) => i.lowStock === true));
  assert.equal((await call('GET', `?q=${tag}-pg&lowStockOnly=false`)).body.items.length, 4);

  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: { status: number; body: any } = await call('GET', `?q=${tag}-pg&limit=3${cursor ? `&cursor=${cursor}` : ''}`);
    assert.equal(page.status, 200);
    seen.push(...page.body.items.map((i: any) => i.sku));
    cursor = page.body.nextCursor;
    pages += 1;
  } while (cursor && pages < 10);
  assert.equal(pages, 2);
  assert.equal(seen.length, 4);
  assert.equal(new Set(seen).size, 4);
  assert.deepEqual(seen, [...seen].sort());

  for (const bad of ['?limit=0', '?limit=101', '?limit=x', '?cursor=!!!', `?cursor=${Buffer.from('{"s":5}').toString('base64url')}`, '?lowStockOnly=maybe', `?q=${'a'.repeat(101)}`]) {
    assert.equal((await call('GET', bad)).status, 400, bad);
  }
});

test('adjust: adds and removes stock, writes one ledger row (with the admin) and one audit event, returns the item', async () => {
  const p = await mkProduct('adjust', 10);
  const up = await call('POST', `/${p.id}/adjust`, { delta: 5, reason: '  Received restock  ' });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.deepEqual(up.body, { productId: p.id, sku: p.sku, name: p.name, active: true, onHand: 15, reserved: 0, lowStockThreshold: null, lowStock: false });
  const down = await call('POST', `/${p.id}/adjust`, { delta: -15, reason: 'Count correction' });
  assert.equal(down.status, 200);
  assert.equal(down.body.onHand, 0, 'exactly zero is allowed');
  const rows = await prisma.inventoryAdjustment.findMany({ where: { productId: p.id }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(rows.map((r) => [r.kind, r.delta, r.reason, r.adminId, r.orderId]), [
    ['ADMIN_ADJUST', 5, 'Received restock', owner.id, null],
    ['ADMIN_ADJUST', -15, 'Count correction', owner.id, null],
  ]);
  const audits = await prisma.adminAuditEvent.findMany({ where: { targetType: 'product', targetId: p.id, action: 'inventory.adjust' }, orderBy: { createdAt: 'asc' } });
  assert.equal(audits.length, 2);
  assert.deepEqual(audits[0].detail, { delta: 5, onHandAfter: 15, reasonLength: 'Received restock'.length });
  assert.equal(audits[0].adminId, owner.id);
});

test('adjust cannot go below zero: 409, stock and ledger unchanged; validation 400s and 404 for an unknown product', async () => {
  const p = await mkProduct('floor', 3);
  const refused = await call('POST', `/${p.id}/adjust`, { delta: -4, reason: 'too much' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.message, 'Adjustment would take stock below zero.');
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).inventory, 3);
  assert.equal(await prisma.inventoryAdjustment.count({ where: { productId: p.id } }), 0);
  assert.equal(await prisma.adminAuditEvent.count({ where: { targetId: p.id } }), 0, 'a refused adjustment is not audited as a change');
  for (const body of [
    { delta: 0, reason: 'x' }, { delta: 100_001, reason: 'x' }, { delta: -100_001, reason: 'x' }, { delta: 1.5, reason: 'x' }, { delta: '2', reason: 'x' }, { delta: null, reason: 'x' },
    { reason: 'x' }, { delta: 1 }, { delta: 1, reason: '' }, { delta: 1, reason: '   ' }, { delta: 1, reason: 'r'.repeat(201) }, { delta: 1, reason: 42 },
  ]) {
    assert.equal((await call('POST', `/${p.id}/adjust`, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await call('POST', `/${p.id}/adjust`, { delta: 100_000, reason: 'r'.repeat(200) })).status, 200, 'both bounds are inclusive');
  assert.equal((await call('POST', '/no-such-product/adjust', { delta: 1, reason: 'x' })).status, 404);
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).inventory, 100_003);
});

test('CONCURRENCY: 12 parallel -1 adjustments on stock 5 succeed exactly 5 times and never go negative', async () => {
  const p = await mkProduct('adjrace', 5);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => call('POST', `/${p.id}/adjust`, { delta: -1, reason: `race ${i}` })));
  assert.equal(results.filter((r) => r.status === 200).length, 5);
  assert.equal(results.filter((r) => r.status === 409).length, 7);
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).inventory, 0);
  assert.equal(await prisma.inventoryAdjustment.count({ where: { productId: p.id } }), 5);
});

test('an adjustment cannot overflow the Int32 stock column', async () => {
  const p = await mkProduct('overflow', 2_147_483_600);
  const refused = await call('POST', `/${p.id}/adjust`, { delta: 100, reason: 'too many' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.message, 'Adjustment would exceed the maximum stock count.');
  assert.equal((await call('POST', `/${p.id}/adjust`, { delta: 47, reason: 'to the max' })).body.onHand, 2_147_483_647);
});

test('ledger: newest first, keyset pagination without gaps across createdAt ties, shows order rows and the admin name', async () => {
  const p = await mkProduct('ledger', 100);
  const customer = await prisma.customer.create({ data: { email: `${tag}-ledger@example.test` } });
  customerIds.push(customer.id);
  const order = await prisma.order.create({ data: { customerId: customer.id, totalCents: 1 } });
  orderIds.push(order.id);
  const tie = new Date('2026-10-01T12:00:00.000Z');
  await prisma.inventoryAdjustment.createMany({
    data: [
      { productId: p.id, delta: -2, kind: 'ORDER_RESERVE', orderId: order.id, createdAt: tie },
      { productId: p.id, delta: 2, kind: 'ORDER_RELEASE', orderId: order.id, reason: 'Order expired unpaid', createdAt: new Date(tie.getTime() + 1000) },
      { productId: p.id, delta: 7, kind: 'ADMIN_ADJUST', reason: 'tie a', adminId: owner.id, createdAt: new Date(tie.getTime() - 1000) },
      { productId: p.id, delta: 8, kind: 'ADMIN_ADJUST', reason: 'tie b', adminId: owner.id, createdAt: new Date(tie.getTime() - 1000) },
      { productId: p.id, delta: 9, kind: 'ADMIN_ADJUST', reason: 'tie c', adminId: owner.id, createdAt: new Date(tie.getTime() - 1000) },
    ],
  });
  const all = await call('GET', `/${p.id}/ledger`);
  assert.equal(all.status, 200);
  assert.equal(all.headers.get('cache-control'), 'no-store');
  assert.equal(all.body.items.length, 5);
  assert.equal(all.body.nextCursor, null);
  assert.deepEqual(all.body.items[0], { id: all.body.items[0].id, delta: 2, kind: 'ORDER_RELEASE', reason: 'Order expired unpaid', orderId: order.id, adminName: null, createdAt: '2026-10-01T12:00:01.000Z' });
  assert.deepEqual(all.body.items.map((i: any) => i.reason ?? i.kind), ['Order expired unpaid', 'ORDER_RESERVE', ...all.body.items.slice(2).map((i: any) => i.reason)]);
  assert.ok(all.body.items.slice(2).every((i: any) => i.adminName === 'OWNER Person' && i.orderId === null));

  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: { status: number; body: any } = await call('GET', `/${p.id}/ledger?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
    assert.equal(page.status, 200);
    seen.push(...page.body.items.map((i: any) => i.id));
    cursor = page.body.nextCursor;
    pages += 1;
  } while (cursor && pages < 10);
  assert.equal(pages, 3);
  assert.deepEqual(seen, all.body.items.map((i: any) => i.id), 'paging yields the same order with no repeat and no gap');

  for (const bad of ['?limit=0', '?limit=101', '?cursor=zzz', `?cursor=${Buffer.from('{"t":"x","i":"a"}').toString('base64url')}`]) assert.equal((await call('GET', `/${p.id}/ledger${bad}`)).status, 400, bad);
  assert.equal((await call('GET', '/no-such-product/ledger')).status, 404);
});

test('threshold (OWNER): set, change, clear with null; validation; audit rows; lowStock follows', async () => {
  const p = await mkProduct('threshold', 4);
  const set = await call('POST', `/${p.id}/threshold`, { lowStockThreshold: 4 });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.deepEqual([set.body.lowStockThreshold, set.body.lowStock], [4, true]);
  assert.deepEqual([(await call('POST', `/${p.id}/threshold`, { lowStockThreshold: 3 })).body.lowStock], [false]);
  assert.equal((await call('POST', `/${p.id}/threshold`, { lowStockThreshold: 0 })).body.lowStockThreshold, 0);
  const cleared = await call('POST', `/${p.id}/threshold`, { lowStockThreshold: null });
  assert.deepEqual([cleared.body.lowStockThreshold, cleared.body.lowStock], [null, false]);
  for (const body of [{}, { lowStockThreshold: -1 }, { lowStockThreshold: 1.5 }, { lowStockThreshold: '5' }, { lowStockThreshold: 2_147_483_648 }, { lowStockThreshold: true }]) {
    assert.equal((await call('POST', `/${p.id}/threshold`, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await call('POST', '/no-such-product/threshold', { lowStockThreshold: 1 })).status, 404);
  const audits = await prisma.adminAuditEvent.findMany({ where: { targetType: 'product', targetId: p.id, action: 'inventory.threshold' }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(audits.map((a) => a.detail), [{ from: null, to: 4 }, { from: 4, to: 3 }, { from: 3, to: 0 }, { from: 0, to: null }]);
  assert.ok(audits.every((a) => a.adminId === owner.id));
  assert.equal(await prisma.inventoryAdjustment.count({ where: { productId: p.id } }), 0, 'a threshold change is not a stock movement');
});
