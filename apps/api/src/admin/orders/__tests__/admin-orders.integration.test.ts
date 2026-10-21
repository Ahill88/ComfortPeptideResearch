/**
 * Admin fulfillment API against REAL PostgreSQL, through HTTP, with the real AdminAuditService.
 *
 *   TEST_DATABASE_URL=postgresql://helix@127.0.0.1:54329/helix_field?schema=<your own schema> \
 *   NODE_ENV=test pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only src/admin/orders/__tests__/admin-orders.integration.test.ts
 *
 * tests/run-all.mjs reports this file as SKIPPED when TEST_DATABASE_URL is unset. Refuses non-local databases. Every
 * row is tagged and removed in `after` (no truncation). Most tests use a test principal in place of the session guard;
 * one test uses the REAL AdminSessionGuard with an AdminUser + AdminSession row inserted directly.
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

const tag = `adm${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
type OrderStatus = 'PENDING_PAYMENT' | 'PAID' | 'PROCESSING' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' | 'REFUNDED';
const ALL_STATUSES: OrderStatus[] = ['PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'];

let app: import('@nestjs/common').INestApplication;
let realGuardApp: import('@nestjs/common').INestApplication;
let prisma: import('../../../prisma.service').PrismaService;
let base = '';
let realBase = '';
let admin: { id: string; name: string };
let product: { id: string };
const lotCode = `LOT-${tag}`;
const customerIds: string[] = [];
const adminIds: string[] = [];
const orderIds: string[] = [];
const walletAddress = `WALLET-${tag}`;

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = { 'x-test-admin': 'yes' }, root = base) {
  const res = await fetch(`${root}/v1/admin/orders${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

async function mkCustomer(label: string, name: string | null = null) {
  const customer = await prisma.customer.create({ data: { email: `${tag}-${label}@example.test`, name } });
  customerIds.push(customer.id);
  return customer;
}
async function mkOrder(customerId: string, overrides: { status?: OrderStatus; createdAt?: Date; shippingAddress?: string | null; quantities?: number[] } = {}) {
  const order = await prisma.order.create({
    data: {
      customerId,
      status: overrides.status ?? 'PAID',
      totalCents: 2500,
      createdAt: overrides.createdAt,
      shippingAddress: overrides.shippingAddress === undefined ? '1 Lab Way\nBoston, MA 02110' : overrides.shippingAddress,
      items: { create: (overrides.quantities ?? [2]).map((quantity) => ({ productId: product.id, lotCode, quantity, unitCents: 1250 })) },
    },
  });
  orderIds.push(order.id);
  return order;
}
const dbOrder = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });
const events = (id: string) => prisma.orderEvent.findMany({ where: { orderId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
const audits = (id: string) => prisma.adminAuditEvent.findMany({ where: { targetType: 'order', targetId: id }, orderBy: { createdAt: 'asc' } });

before(async () => {
  const { Global, Module, ValidationPipe, UnauthorizedException } = await import('@nestjs/common');
  const { Test } = await import('@nestjs/testing');
  const { PrismaService } = await import('../../../prisma.service');
  const { AdminCoreModule } = await import('../../admin-core.module');
  const { AdminSessionGuard } = await import('../../admin-session.guard');
  const { AdminOrdersModule } = await import('../admin-orders.module');

  prisma = new PrismaService();
  await prisma.$connect();
  const real = prisma;
  @Global()
  @Module({ providers: [{ provide: PrismaService, useValue: real }], exports: [PrismaService] })
  class RealPrismaModule {}

  const created = await prisma.adminUser.create({ data: { email: `${tag}-owner@example.test`, name: 'Owner One', role: 'OWNER', passwordHash: 'x', mfaSeedEnc: 'x' } });
  adminIds.push(created.id);
  admin = { id: created.id, name: created.name };

  const principalGuard = {
    canActivate(context: import('@nestjs/common').ExecutionContext) {
      const request = context.switchToHttp().getRequest();
      if (request.headers['x-test-admin'] !== 'yes') throw new UnauthorizedException('Admin sign-in required.');
      request.admin = { id: admin.id, email: `${tag}-owner@example.test`, name: admin.name, role: 'OWNER' };
      return true;
    },
  };
  const build = async (overrideGuard: boolean) => {
    let builder = Test.createTestingModule({ imports: [RealPrismaModule, AdminCoreModule, AdminOrdersModule] });
    if (overrideGuard) builder = builder.overrideGuard(AdminSessionGuard).useValue(principalGuard);
    const moduleRef = await builder.compile();
    const instance = moduleRef.createNestApplication({ logger: false });
    instance.setGlobalPrefix('v1');
    instance.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await instance.listen(0, '127.0.0.1');
    return { instance, root: (await instance.getUrl()).replace('[::1]', '127.0.0.1') };
  };
  ({ instance: app, root: base } = await build(true));
  ({ instance: realGuardApp, root: realBase } = await build(false));

  product = await prisma.product.create({ data: { sku: `SKU-${tag}`, slug: `slug-${tag}`, name: `Peptide ${tag}`, active: true, priceCents: 1250, inventory: 10 } });
  await prisma.lot.create({ data: { code: lotCode, productId: product.id, coaKey: 'coa/test.pdf', purity: 99 } });
});

after(async () => {
  try {
    const orders = { in: orderIds };
    await prisma.adminAuditEvent.deleteMany({ where: { OR: [{ targetId: orders }, { adminId: { in: adminIds } }] } });
    await prisma.orderEvent.deleteMany({ where: { orderId: orders } });
    await prisma.shipment.deleteMany({ where: { orderId: orders } });
    await prisma.cryptoTransaction.deleteMany({ where: { customerId: { in: customerIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: orders } });
    await prisma.order.deleteMany({ where: { id: orders } });
    await prisma.customerWallet.deleteMany({ where: { customerId: { in: customerIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    await prisma.adminSession.deleteMany({ where: { adminId: { in: adminIds } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: adminIds } } });
    await prisma.lot.deleteMany({ where: { code: lotCode } });
    await prisma.product.deleteMany({ where: { id: product?.id } });
  } finally {
    await app?.close();
    await realGuardApp?.close();
    await prisma?.$disconnect();
  }
});

test('REAL session guard: no token, garbage and unknown/revoked/expired tokens are 401; a valid session is 200', async () => {
  const { hashSessionToken } = await import('../../admin-session.guard');
  const token = randomBytes(32).toString('base64url');
  const session = await prisma.adminSession.create({ data: { adminId: admin.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3_600_000) } });
  const bearer = (value: string) => ({ authorization: `Bearer ${value}` });
  const get = (path: string, headers: Record<string, string>) => call('GET', path, undefined, headers, realBase);
  const order = await mkOrder((await mkCustomer('guard')).id);

  for (const path of ['/counts', '', `/${order.id}`]) {
    assert.equal((await get(path, {})).status, 401, `no token ${path}`);
    assert.equal((await get(path, bearer('garbage'))).status, 401);
    assert.equal((await get(path, { authorization: token })).status, 401, 'missing Bearer prefix');
    assert.equal((await get(path, bearer(randomBytes(32).toString('base64url')))).status, 401, 'well-formed but unknown token');
    assert.equal((await get(path, { 'x-test-admin': 'yes' })).status, 401, 'the test-principal header means nothing to the real guard');
  }
  assert.equal((await call('POST', `/${order.id}/start-packing`, {}, {}, realBase)).status, 401);
  assert.equal((await dbOrder(order.id)).status, 'PAID', 'an unauthenticated action changes nothing');

  const ok = await get('/counts', bearer(token));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(Object.keys(ok.body.counts), ALL_STATUSES);
  assert.equal((await get(`/${order.id}`, bearer(token))).body.id, order.id);
  const acted = await call('POST', `/${order.id}/start-packing`, {}, bearer(token), realBase);
  assert.equal(acted.status, 200, JSON.stringify(acted.body));
  assert.equal(acted.body.events[0].adminName, 'Owner One', 'the real guard principal is attributed');

  await prisma.adminSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
  assert.equal((await get('/counts', bearer(token))).status, 401, 'revoked session');
  await prisma.adminSession.update({ where: { id: session.id }, data: { revokedAt: null, expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await get('/counts', bearer(token))).status, 401, 'expired session');
});

test('full lifecycle PAID -> PROCESSING -> SHIPPED -> DELIVERED: events, shipment, audit rows, address and payment in the detail', async () => {
  const customer = await mkCustomer('life', 'Lena Lifecycle');
  await prisma.customerWallet.create({ data: { customerId: customer.id, address: walletAddress, provider: 'test', network: 'solana-devnet' } });
  const order = await mkOrder(customer.id, { quantities: [2, 3] });
  await prisma.cryptoTransaction.create({
    data: {
      customerId: customer.id, type: 'PURCHASE', status: 'FINALIZED', amountAtomic: 2_500_000n, sourceAddress: walletAddress, destinationAddress: `TREASURY-${tag}`,
      mint: 'MINT', network: 'solana-devnet', reference: `ref-${tag}`, orderId: order.id, txSignature: `sig-${tag}`, finalizedAt: new Date('2026-10-01T12:10:00Z'),
    },
  });

  const first = await call('GET', `/${order.id}`);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.customer, { id: customer.id, email: `${tag}-life@example.test`, name: 'Lena Lifecycle' });
  assert.equal(first.body.shippingAddress, '1 Lab Way\nBoston, MA 02110');
  assert.equal(first.body.itemCount, 5);
  assert.equal(first.body.hasShipment, false);
  assert.equal(first.body.trackingNumber, null);
  assert.equal(first.body.totalCents, 2500);
  assert.equal(first.body.currency, 'USD');
  assert.deepEqual(first.body.payment, { status: 'FINALIZED', amountAtomic: '2500000', txSignature: `sig-${tag}`, network: 'solana-devnet', finalizedAt: '2026-10-01T12:10:00.000Z' });
  assert.equal(first.body.items.length, 2);
  assert.deepEqual(
    { ...first.body.items[0], id: undefined },
    { id: undefined, productId: product.id, sku: `SKU-${tag}`, name: `Peptide ${tag}`, lotCode, quantity: 2, unitCents: 1250 },
  );
  assert.deepEqual(first.body.allowedActions, ['start-packing', 'add-note']);
  assert.ok(!JSON.stringify(first.body).includes(walletAddress), 'wallet addresses are never exposed');
  assert.ok(!JSON.stringify(first.body).includes('TREASURY-'));

  const packing = await call('POST', `/${order.id}/start-packing`, {});
  assert.equal(packing.status, 200, JSON.stringify(packing.body));
  assert.equal(packing.body.status, 'PROCESSING');

  const shipped = await call('POST', `/${order.id}/ship`, { carrier: 'UPS', trackingNumber: '1Z 999 AA1 0123456784', note: 'two boxes' });
  assert.equal(shipped.status, 200, JSON.stringify(shipped.body));
  assert.equal(shipped.body.status, 'SHIPPED');
  assert.equal(shipped.body.hasShipment, true);
  assert.equal(shipped.body.trackingNumber, '1Z 999 AA1 0123456784');
  assert.equal(shipped.body.shipments.length, 1);
  assert.equal(shipped.body.shipments[0].carrier, 'UPS');
  assert.equal(shipped.body.shipments[0].note, 'two boxes');
  assert.equal(shipped.body.shipments[0].deliveredAt, null);
  assert.ok(shipped.body.shipments[0].shippedAt);

  const noted = await call('POST', `/${order.id}/notes`, { note: 'Customer emailed: please leave at front desk' });
  assert.equal(noted.status, 200);
  assert.equal(noted.body.status, 'SHIPPED');

  const delivered = await call('POST', `/${order.id}/mark-delivered`, {});
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
  assert.equal(delivered.body.status, 'DELIVERED');
  assert.ok(delivered.body.shipments[0].deliveredAt);
  assert.deepEqual(delivered.body.allowedActions, ['add-note']);
  assert.deepEqual(
    delivered.body.events.map((e: any) => [e.kind, e.fromStatus, e.toStatus, e.note, e.adminName]),
    [
      ['STATUS', 'PAID', 'PROCESSING', null, 'Owner One'],
      ['STATUS', 'PROCESSING', 'SHIPPED', 'two boxes', 'Owner One'],
      ['NOTE', null, null, 'Customer emailed: please leave at front desk', 'Owner One'],
      ['STATUS', 'SHIPPED', 'DELIVERED', null, 'Owner One'],
    ],
  );

  const rows = await events(order.id);
  assert.deepEqual(rows.map((row) => row.adminId), Array(4).fill(admin.id));
  const shipmentRows = await prisma.shipment.findMany({ where: { orderId: order.id } });
  assert.equal(shipmentRows.length, 1);
  assert.equal(shipmentRows[0].createdByAdminId, admin.id);
  assert.ok(shipmentRows[0].deliveredAt);

  const trail = await audits(order.id);
  assert.deepEqual(trail.map((row) => row.action), ['order.start-packing', 'order.ship', 'order.add-note', 'order.mark-delivered']);
  assert.ok(trail.every((row) => row.adminId === admin.id && row.targetType === 'order' && row.ip));
  assert.deepEqual(trail[1].detail, { fromStatus: 'PROCESSING', toStatus: 'SHIPPED', carrier: 'UPS', trackingNumber: '1Z 999 AA1 0123456784' });
  assert.ok(!JSON.stringify(trail).includes('front desk'), 'note text is not copied to the audit trail');
  assert.ok(!JSON.stringify(trail).includes('Boston') && !JSON.stringify(trail).includes(`${tag}-life@`), 'no customer PII in the audit trail');
});

test('every illegal transition is a 409 with the exact message and leaves the database untouched; unknown order is 404', async () => {
  const customer = await mkCustomer('illegal');
  const actions: Array<{ name: string; path: string; body: unknown; from: OrderStatus; label: string }> = [
    { name: 'start-packing', path: 'start-packing', body: {}, from: 'PAID', label: 'start packing' },
    { name: 'ship', path: 'ship', body: { carrier: 'USPS', trackingNumber: 'ABCD1234' }, from: 'PROCESSING', label: 'ship' },
    { name: 'mark-delivered', path: 'mark-delivered', body: {}, from: 'SHIPPED', label: 'mark delivered' },
    { name: 'cancel', path: 'cancel', body: { reason: 'nope' }, from: 'PENDING_PAYMENT', label: 'cancel' },
  ];
  let refused = 0;
  for (const status of ALL_STATUSES) {
    const order = await mkOrder(customer.id, { status });
    for (const action of actions.filter((candidate) => candidate.from !== status)) {
      const res = await call('POST', `/${order.id}/${action.path}`, action.body);
      assert.equal(res.status, 409, `${action.name} on ${status}: ${JSON.stringify(res.body)}`);
      const paid = action.name === 'cancel' && ['PAID', 'PROCESSING', 'SHIPPED'].includes(status);
      assert.equal(res.body.message, paid ? 'Paid orders are refunded through the refunds process, not cancelled.' : `Order is ${status}; cannot ${action.label}.`);
      refused += 1;
    }
    assert.equal((await dbOrder(order.id)).status, status);
    assert.equal((await events(order.id)).length, 0);
    assert.equal(await prisma.shipment.count({ where: { orderId: order.id } }), 0);
    assert.equal((await audits(order.id)).length, 0);
  }
  assert.equal(refused, 24);
  for (const action of actions) assert.equal((await call('POST', `/${'c'.repeat(25)}/${action.path}`, action.body)).status, 404, action.name);
  assert.equal((await call('POST', `/${'c'.repeat(25)}/notes`, { note: 'x' })).status, 404);
  assert.equal((await call('GET', `/${'c'.repeat(25)}`)).status, 404);
});

test('cancel: PENDING_PAYMENT only; reason stored on the event; a second cancel is 409', async () => {
  const customer = await mkCustomer('cancel');
  const pending = await mkOrder(customer.id, { status: 'PENDING_PAYMENT' });
  const done = await call('POST', `/${pending.id}/cancel`, { reason: 'Customer asked to cancel before paying' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.status, 'CANCELLED');
  assert.equal(done.body.events[0].note, 'Customer asked to cancel before paying');
  assert.deepEqual(done.body.allowedActions, ['add-note']);
  assert.equal((await call('POST', `/${pending.id}/cancel`, { reason: 'again' })).body.message, 'Order is CANCELLED; cannot cancel.');
  assert.equal((await events(pending.id)).length, 1);
  assert.deepEqual((await audits(pending.id)).map((row) => row.action), ['order.cancel']);
});

test('10 parallel ship calls: exactly one 200, nine 409, exactly one Shipment, one STATUS event, one audit row', async () => {
  const customer = await mkCustomer('race-ship');
  const order = await mkOrder(customer.id, { status: 'PROCESSING' });
  const results = await Promise.all(Array.from({ length: 10 }, (_, n) => call('POST', `/${order.id}/ship`, { carrier: 'USPS', trackingNumber: `RACE-${n}-0000` })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, ...Array(9).fill(409)], JSON.stringify(results.map((r) => r.body.message)));
  for (const loser of results.filter((r) => r.status === 409)) assert.equal(loser.body.message, 'Order is SHIPPED; cannot ship.');
  assert.equal(await prisma.shipment.count({ where: { orderId: order.id } }), 1);
  assert.deepEqual((await events(order.id)).map((e) => [e.kind, e.fromStatus, e.toStatus]), [['STATUS', 'PROCESSING', 'SHIPPED']]);
  assert.equal((await audits(order.id)).length, 1);
  assert.equal((await dbOrder(order.id)).status, 'SHIPPED');
});

test('10 parallel identical ship calls (same tracking number, a double-click storm) still create one shipment', async () => {
  const customer = await mkCustomer('race-same');
  const order = await mkOrder(customer.id, { status: 'PROCESSING' });
  const results = await Promise.all(Array.from({ length: 10 }, () => call('POST', `/${order.id}/ship`, { carrier: 'DHL', trackingNumber: 'SAME-1234' })));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 9);
  assert.equal(await prisma.shipment.count({ where: { orderId: order.id } }), 1);
  assert.equal((await events(order.id)).length, 1);
});

test('parallel start-packing and mark-delivered each flip once and write one event', async () => {
  const customer = await mkCustomer('race-other');
  const paid = await mkOrder(customer.id, { status: 'PAID' });
  const packing = await Promise.all(Array.from({ length: 10 }, () => call('POST', `/${paid.id}/start-packing`, {})));
  assert.deepEqual(packing.map((r) => r.status).sort(), [200, ...Array(9).fill(409)]);
  assert.equal((await events(paid.id)).length, 1);
  const shipped = await mkOrder(customer.id, { status: 'SHIPPED' });
  await prisma.shipment.create({ data: { orderId: shipped.id, carrier: 'UPS', trackingNumber: 'DELIV-0001' } });
  const delivered = await Promise.all(Array.from({ length: 10 }, () => call('POST', `/${shipped.id}/mark-delivered`, {})));
  assert.deepEqual(delivered.map((r) => r.status).sort(), [200, ...Array(9).fill(409)]);
  assert.equal((await events(shipped.id)).length, 1);
  assert.equal((await audits(shipped.id)).length, 1);
  assert.ok((await prisma.shipment.findFirstOrThrow({ where: { orderId: shipped.id } })).deliveredAt);
});

test('a duplicate tracking number for the order is a 409 and the order stays PROCESSING with no event, shipment or audit row', async () => {
  const customer = await mkCustomer('dup');
  const order = await mkOrder(customer.id, { status: 'PROCESSING' });
  await prisma.shipment.create({ data: { orderId: order.id, carrier: 'UPS', trackingNumber: 'DUP-0001' } });
  const res = await call('POST', `/${order.id}/ship`, { carrier: 'UPS', trackingNumber: 'DUP-0001' });
  assert.equal(res.status, 409);
  assert.match(res.body.message, /already recorded/);
  assert.equal((await dbOrder(order.id)).status, 'PROCESSING');
  assert.equal((await events(order.id)).length, 0);
  assert.equal(await prisma.shipment.count({ where: { orderId: order.id } }), 1);
  assert.equal((await audits(order.id)).length, 0);
  assert.equal((await call('POST', `/${order.id}/ship`, { carrier: 'UPS', trackingNumber: 'DUP-0002' })).status, 200);
});

test('ship validation over HTTP against the real database creates nothing', async () => {
  const customer = await mkCustomer('validate');
  const order = await mkOrder(customer.id, { status: 'PROCESSING' });
  for (const body of [{ carrier: 'ups', trackingNumber: 'ABCD1234' }, { carrier: 'UPS', trackingNumber: 'AB' }, { carrier: 'UPS', trackingNumber: '-ABCD' }, { carrier: 'UPS', trackingNumber: 'AB;CD1234' }, { carrier: 'UPS', trackingNumber: 'x'.repeat(65) }, { carrier: 'UPS' }, {}]) {
    assert.equal((await call('POST', `/${order.id}/ship`, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await dbOrder(order.id)).status, 'PROCESSING');
  assert.equal(await prisma.shipment.count({ where: { orderId: order.id } }), 0);
});

test('orders created before the shippingAddress column existed (NULL) still render in list and detail', async () => {
  const customer = await mkCustomer('legacy');
  const order = await mkOrder(customer.id, { shippingAddress: null });
  const detail = await call('GET', `/${order.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.shippingAddress, null);
  assert.equal(detail.body.payment, null);
  const list = await call('GET', `?q=${tag}-legacy`);
  assert.deepEqual(list.body.items.map((item: any) => item.id), [order.id]);
});

test('list: summary shape, status filter, email substring and id prefix search (case-insensitive), wildcard characters are literal', async () => {
  const alice = await mkCustomer('alice', 'Alice');
  const bob = await mkCustomer('bob');
  const a1 = await mkOrder(alice.id, { status: 'PAID', quantities: [1, 4] });
  const a2 = await mkOrder(alice.id, { status: 'PROCESSING' });
  const b1 = await mkOrder(bob.id, { status: 'SHIPPED' });
  await prisma.shipment.create({ data: { orderId: b1.id, carrier: 'FedEx', trackingNumber: 'LIST-0001', shippedAt: new Date('2026-10-02T00:00:00Z') } });
  await prisma.shipment.create({ data: { orderId: b1.id, carrier: 'FedEx', trackingNumber: 'LIST-0002', shippedAt: new Date('2026-10-03T00:00:00Z') } });
  const ids = (res: { body: any }) => res.body.items.map((item: any) => item.id).sort();

  const alices = await call('GET', `?q=${tag}-ALICE`);
  assert.deepEqual(ids(alices), [a1.id, a2.id].sort());
  assert.equal(alices.body.nextCursor, null);
  const summary = alices.body.items.find((item: any) => item.id === a1.id);
  assert.deepEqual(summary, {
    id: a1.id, status: 'PAID', totalCents: 2500, currency: 'USD', createdAt: a1.createdAt.toISOString(),
    customer: { id: alice.id, email: `${tag}-alice@example.test`, name: 'Alice' }, itemCount: 5, hasShipment: false, trackingNumber: null,
  });
  assert.ok(!('shippingAddress' in summary));

  assert.deepEqual(ids(await call('GET', `?q=${tag}&status=PAID,PROCESSING`)).filter((id: string) => [a1.id, a2.id, b1.id].includes(id)), [a1.id, a2.id].sort());
  assert.deepEqual(ids(await call('GET', `?q=${tag}-b&status=SHIPPED`)), [b1.id]);
  assert.deepEqual(ids(await call('GET', `?q=${tag}-alice&status=SHIPPED`)), []);
  const shippedRow = (await call('GET', `?q=${tag}-bob`)).body.items[0];
  assert.deepEqual([shippedRow.hasShipment, shippedRow.trackingNumber], [true, 'LIST-0002'], 'the latest shipment tracking number is shown');

  assert.deepEqual(ids(await call('GET', `?q=${a1.id.slice(0, 22)}`)), [a1.id]);
  assert.deepEqual(ids(await call('GET', `?q=${a1.id.slice(0, 22).toUpperCase()}`)), [a1.id]);
  assert.deepEqual(ids(await call('GET', `?q=${a1.id.slice(3, 22)}`)), [], 'id matching is a prefix, not a substring');
  assert.deepEqual(ids(await call('GET', `?q=${encodeURIComponent('%')}`)), []);
  assert.deepEqual(ids(await call('GET', `?q=${encodeURIComponent('_')}`)), []);
  assert.deepEqual(ids(await call('GET', `?q=${encodeURIComponent(`${tag}%bob`)}`)), []);
  const underscored = await mkCustomer('under_score');
  const dotted = await mkCustomer('under.score');
  const u1 = await mkOrder(underscored.id);
  await mkOrder(dotted.id);
  assert.deepEqual(ids(await call('GET', `?q=${encodeURIComponent(`${tag}-under_score`)}`)), [u1.id], 'a literal underscore does not match any character');
});

test('keyset pagination is stable across createdAt ties, new inserts and every page boundary', async () => {
  const customer = await mkCustomer('pages');
  const tie = new Date('2026-09-01T10:00:00.000Z');
  const made = [] as Array<{ id: string; createdAt: Date }>;
  for (const createdAt of [new Date('2026-09-02T00:00:00.000Z'), tie, tie, tie, tie, tie, tie, tie, new Date('2026-08-01T00:00:00.000Z')]) {
    made.push(await mkOrder(customer.id, { createdAt }));
  }
  const expected = [...made].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1)).map((o) => o.id);

  for (const limit of [1, 2, 3, 4, 9, 10]) {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { status: number; body: any } = await call('GET', `?q=${tag}-pages&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
      assert.equal(page.status, 200, JSON.stringify(page.body));
      assert.ok(page.body.items.length <= limit);
      seen.push(...page.body.items.map((item: any) => item.id));
      cursor = page.body.nextCursor;
      if (cursor) assert.match(cursor, /^[A-Za-z0-9_-]+$/);
      pages += 1;
      assert.ok(pages < 20);
    } while (cursor);
    assert.deepEqual(seen, expected, `limit ${limit}`);
  }

  // An order inserted (newest) or removed-from-front between pages does not shift the remaining pages.
  const first = await call('GET', `?q=${tag}-pages&limit=4`);
  await mkOrder(customer.id, { createdAt: new Date('2026-09-05T00:00:00.000Z') });
  const second = await call('GET', `?q=${tag}-pages&limit=4&cursor=${first.body.nextCursor}`);
  assert.deepEqual([...first.body.items, ...second.body.items].map((item: any) => item.id), expected.slice(0, 8));

  // Last page has no cursor; default limit is 25.
  assert.equal((await call('GET', `?q=${tag}-pages&limit=100`)).body.nextCursor, null);
  const defaulted = await call('GET', `?q=${tag}`);
  assert.ok(defaulted.body.items.length <= 25);
  assert.equal((await call('GET', `?q=${tag}-pages&cursor=${Buffer.from('{"t":1,"i":"x y"}').toString('base64url')}`)).status, 400);
});

test('counts report all seven statuses and track real rows', async () => {
  const before = (await call('GET', '/counts')).body.counts;
  assert.deepEqual(Object.keys(before), ALL_STATUSES);
  const customer = await mkCustomer('counts');
  await mkOrder(customer.id, { status: 'PAID' });
  await mkOrder(customer.id, { status: 'PAID' });
  await mkOrder(customer.id, { status: 'REFUNDED' });
  const afterCounts = (await call('GET', '/counts')).body.counts;
  for (const status of ALL_STATUSES) {
    assert.equal(typeof afterCounts[status], 'number');
    assert.equal(afterCounts[status] - before[status], status === 'PAID' ? 2 : status === 'REFUNDED' ? 1 : 0, status);
  }
  const total = await prisma.order.count();
  assert.equal(Object.values(afterCounts).reduce((sum: number, n) => sum + (n as number), 0), total);
});

test('notes: any status, NOTE event only, status untouched, bounds enforced', async () => {
  const customer = await mkCustomer('notes');
  for (const status of ALL_STATUSES) {
    const order = await mkOrder(customer.id, { status });
    const res = await call('POST', `/${order.id}/notes`, { note: `  hello ${status}  ` });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, status);
    assert.equal(res.body.events.at(-1).note, `hello ${status}`);
    assert.equal((await dbOrder(order.id)).status, status);
    assert.equal((await events(order.id)).filter((e) => e.kind === 'NOTE').length, 1);
  }
  const order = await mkOrder(customer.id);
  for (const note of ['', '   ', 'n'.repeat(1001)]) assert.equal((await call('POST', `/${order.id}/notes`, { note })).status, 400);
});

test('admin routes never touch money state: no payment/crypto rows, no refunds, no PAID transition', async () => {
  const customer = await mkCustomer('money');
  const pending = await mkOrder(customer.id, { status: 'PENDING_PAYMENT' });
  const cryptoBefore = await prisma.cryptoTransaction.count();
  const paymentsBefore = await prisma.payment.count();
  await call('POST', `/${pending.id}/start-packing`, {});
  await call('POST', `/${pending.id}/ship`, { carrier: 'UPS', trackingNumber: 'MONEY-0001' });
  await call('POST', `/${pending.id}/mark-delivered`, {});
  await call('POST', `/${pending.id}/notes`, { note: 'still unpaid' });
  assert.equal((await dbOrder(pending.id)).status, 'PENDING_PAYMENT', 'nothing here can mark an order PAID or skip payment');
  assert.equal(await prisma.cryptoTransaction.count(), cryptoBefore);
  assert.equal(await prisma.payment.count(), paymentsBefore);
});
