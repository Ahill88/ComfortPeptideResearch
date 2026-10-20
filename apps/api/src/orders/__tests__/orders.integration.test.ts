/**
 * POST /v1/orders against REAL PostgreSQL (idempotency scoping, races, integer bounds).
 *
 *   TEST_DATABASE_URL=postgresql://helix@127.0.0.1:54329/helix_field \
 *   NODE_ENV=test pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only src/orders/__tests__/orders.integration.test.ts
 *
 * tests/run-all.mjs reports this file as SKIPPED when TEST_DATABASE_URL is unset (the name ends .integration.test.ts).
 * Refuses non-local databases. Unlike the wallet e2e it does NOT truncate: every row it creates is uniquely tagged and
 * removed in `after`.
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

const tag = `ord${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let app: import('@nestjs/common').INestApplication;
let prisma: import('../../prisma.service').PrismaService;
let base = '';
let product: { id: string; priceCents: number };
let lotCode = '';
let expensive: { id: string };
let expensiveLot = '';

const email = (label: string) => `${tag}-${label}@example.test`;
const emails: string[] = [];
const track = (label: string) => {
  const value = email(label);
  emails.push(value);
  return value;
};
const payload = (to: string, overrides: Record<string, unknown> = {}) => ({
  email: to,
  shippingAddress: '1 Lab Way, Boston, MA',
  researchUseAcknowledged: true,
  items: [{ productId: product.id, lotCode, quantity: 2 }],
  ...overrides,
});
async function post(body: unknown, key: string) {
  const res = await fetch(`${base}/v1/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}
const ordersFor = (to: string) => prisma.order.findMany({ where: { customer: { email: to } } });

before(async () => {
  const { Global, Module, ValidationPipe } = await import('@nestjs/common');
  const { Test } = await import('@nestjs/testing');
  const { PrismaService } = await import('../../prisma.service');
  const { OrdersModule } = await import('../orders.module');

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

  product = await prisma.product.create({ data: { sku: `SKU-${tag}`, slug: `slug-${tag}`, name: 'idem', active: true, priceCents: 1250, inventory: 10 } });
  lotCode = `LOT-${tag}`;
  await prisma.lot.create({ data: { code: lotCode, productId: product.id, coaKey: 'coa/test.pdf', purity: 99 } });
  expensive = await prisma.product.create({ data: { sku: `SKU-X-${tag}`, slug: `slug-x-${tag}`, name: 'pricey', active: true, priceCents: 2_000_000_000, inventory: 1 } });
  expensiveLot = `LOT-X-${tag}`;
  await prisma.lot.create({ data: { code: expensiveLot, productId: expensive.id, coaKey: 'coa/test.pdf', purity: 99 } });
});

after(async () => {
  try {
    const customers = await prisma.customer.findMany({ where: { email: { in: emails } }, select: { id: true } });
    const ids = customers.map((customer) => customer.id);
    await prisma.orderItem.deleteMany({ where: { order: { customerId: { in: ids } } } });
    await prisma.order.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
    await prisma.lot.deleteMany({ where: { code: { in: [lotCode, expensiveLot] } } });
    await prisma.product.deleteMany({ where: { id: { in: [product?.id, expensive?.id].filter(Boolean) as string[] } } });
  } finally {
    await app?.close();
    await prisma?.$disconnect();
  }
});

test('creates an order with a server-generated cuid id, not the idempotency key, and no bookkeeping in the response', async () => {
  const to = track('create');
  const key = `${tag}-create-key`;
  const res = await post(payload(to), key);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.notEqual(res.body.id, key);
  assert.match(res.body.id, /^c[a-z0-9]{20,}$/);
  assert.equal(res.body.totalCents, 2500);
  assert.equal(res.body.currency, 'USD');
  assert.equal(res.body.status, 'PENDING_PAYMENT');
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].unitCents, 1250);
  assert.ok(res.body.researchAcknowledgedAt);
  assert.ok(!('requestHash' in res.body) && !('idempotencyKey' in res.body));
  const row = await prisma.order.findUniqueOrThrow({ where: { id: res.body.id } });
  assert.equal(row.idempotencyKey, key);
  assert.match(row.requestHash ?? '', /^[0-9a-f]{64}$/);
});

test('replay with the same key and payload returns the original order and creates no second row', async () => {
  const to = track('replay');
  const key = `${tag}-replay-key`;
  const first = await post(payload(to), key);
  const second = await post(payload(to), key);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.deepEqual(second.body, first.body);
  // Cosmetic differences (email case/whitespace, line order of a single line) do not make a different request.
  const third = await post(payload(`  ${to.toUpperCase()} `), key);
  assert.equal(third.body.id, first.body.id);
  assert.equal((await ordersFor(to)).length, 1);
});

test('same key with a different payload is 409 and leaves the original untouched', async () => {
  const to = track('conflict');
  const key = `${tag}-conflict-key`;
  const first = await post(payload(to), key);
  const changedQty = await post(payload(to, { items: [{ productId: product.id, lotCode, quantity: 3 }] }), key);
  assert.equal(changedQty.status, 409);
  assert.equal(changedQty.body.message, 'Idempotency key was already used with a different request');
  const changedAddress = await post(payload(to, { shippingAddress: 'elsewhere' }), key);
  assert.equal(changedAddress.status, 409);
  const rows = await ordersFor(to);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, first.body.id);
  assert.equal(rows[0].totalCents, 2500);
});

test('two customers using the same key get two separate orders and nothing about the other leaks', async () => {
  const victim = track('victim');
  const attacker = track('attacker');
  const key = `${tag}-shared-key`;
  const victimOrder = await post(payload(victim, { shippingAddress: 'victim secret street 1' }), key);
  assert.equal(victimOrder.status, 201);
  // Squat attempt: same key, entirely different payload.
  const attackerOrder = await post(payload(attacker, { shippingAddress: 'attacker street 9', items: [{ productId: product.id, lotCode, quantity: 7 }] }), key);
  assert.equal(attackerOrder.status, 201, JSON.stringify(attackerOrder.body));
  assert.notEqual(attackerOrder.body.id, victimOrder.body.id);
  assert.notEqual(attackerOrder.body.customerId, victimOrder.body.customerId);
  assert.equal(attackerOrder.body.totalCents, 8750);
  const attackerJson = JSON.stringify(attackerOrder.body);
  assert.ok(!attackerJson.includes(victimOrder.body.id));
  assert.ok(!attackerJson.includes(victimOrder.body.customerId));
  assert.ok(!attackerJson.toLowerCase().includes(victim));
  // The attacker re-sending with the victim's payload under the victim's email would still be scoped to the victim.
  const victimReplay = await post(payload(victim, { shippingAddress: 'victim secret street 1' }), key);
  assert.equal(victimReplay.body.id, victimOrder.body.id);
  assert.equal(victimReplay.body.totalCents, 2500);
  assert.equal((await ordersFor(victim)).length, 1);
  assert.equal((await ordersFor(attacker)).length, 1);
});

test('10 parallel identical creates for a brand-new customer produce exactly one order row', async () => {
  const to = track('parallel-new');
  const key = `${tag}-parallel-new`;
  const results = await Promise.all(Array.from({ length: 10 }, () => post(payload(to), key)));
  assert.deepEqual(results.map((r) => r.status), Array(10).fill(201), JSON.stringify(results.filter((r) => r.status !== 201).map((r) => r.body)));
  assert.equal(new Set(results.map((r) => r.body.id)).size, 1);
  assert.equal((await ordersFor(to)).length, 1);
  assert.equal(await prisma.customer.count({ where: { email: to } }), 1);
  assert.equal(await prisma.orderItem.count({ where: { orderId: results[0].body.id } }), 1);
});

test('10 parallel identical creates for an existing customer produce exactly one order row', async () => {
  const to = track('parallel-existing');
  await post(payload(to), `${tag}-parallel-warmup`); // customer now exists
  const key = `${tag}-parallel-existing`;
  const results = await Promise.all(Array.from({ length: 10 }, () => post(payload(to), key)));
  assert.deepEqual(results.map((r) => r.status), Array(10).fill(201));
  assert.equal(new Set(results.map((r) => r.body.id)).size, 1);
  assert.equal((await ordersFor(to)).length, 2); // warmup order + the one raced order
});

test('parallel requests with the same key but different payloads yield one order and 409s for the losers', async () => {
  const to = track('parallel-mixed');
  const key = `${tag}-parallel-mixed`;
  const results = await Promise.all(
    [1, 2, 3, 4, 5, 6].map((quantity) => post(payload(to, { items: [{ productId: product.id, lotCode, quantity }] }), key)),
  );
  assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results.map((r) => r.status)));
  assert.equal(results.filter((r) => r.status === 409).length, 5);
  assert.equal((await ordersFor(to)).length, 1);
});

test('oversized quantity is 400 (never a 500 integer overflow) and creates nothing', async () => {
  const to = track('oversize');
  let n = 0;
  for (const quantity of [1001, 2_147_483_647, 3_000_000_000, 0, -5, 1.5]) {
    const res = await post(payload(to, { items: [{ productId: product.id, lotCode, quantity }] }), `${tag}-oversize-${n++}`);
    assert.equal(res.status, 400, `quantity ${quantity}: ${JSON.stringify(res.body)}`);
  }
  const maxOk = await post(payload(to, { items: [{ productId: product.id, lotCode, quantity: 1000 }] }), `${tag}-oversize-max`);
  assert.equal(maxOk.status, 201);
  assert.equal(maxOk.body.totalCents, 1_250_000);
  assert.equal((await ordersFor(to)).length, 1);
});

test('a total beyond the Int32 cents range is 400, and more than 50 lines is 400', async () => {
  const to = track('bounds');
  const huge = await post(payload(to, { items: [{ productId: expensive.id, lotCode: expensiveLot, quantity: 2 }] }), `${tag}-bounds-total`);
  assert.equal(huge.status, 400, JSON.stringify(huge.body));
  const lines = Array.from({ length: 51 }, () => ({ productId: product.id, lotCode, quantity: 1 }));
  const tooMany = await post(payload(to, { items: lines }), `${tag}-bounds-lines`);
  assert.equal(tooMany.status, 400);
  const fifty = await post(payload(to, { items: lines.slice(0, 50) }), `${tag}-bounds-fifty`);
  assert.equal(fifty.status, 201, JSON.stringify(fifty.body));
  assert.equal(fifty.body.totalCents, 50 * 1250);
});

test('lot validation, acknowledgement and key format are still enforced', async () => {
  const to = track('validation');
  assert.equal((await post(payload(to, { items: [{ productId: product.id, lotCode: 'LOT-NOPE', quantity: 1 }] }), `${tag}-val-lot`)).status, 400);
  assert.equal((await post(payload(to, { researchUseAcknowledged: false }), `${tag}-val-ack`)).status, 400);
  assert.equal((await post(payload(to), 'short')).status, 400);
  assert.equal((await ordersFor(to)).length, 0);
});

test('email is normalized consistently: differently-cased emails are one customer', async () => {
  const to = track('mixedcase');
  const first = await post(payload(to.toUpperCase()), `${tag}-case-1`);
  const second = await post(payload(`  ${to}  `), `${tag}-case-2`);
  assert.equal(first.status, 201);
  assert.equal(first.body.customerId, second.body.customerId);
  assert.equal(await prisma.customer.count({ where: { email: to } }), 1);
});
