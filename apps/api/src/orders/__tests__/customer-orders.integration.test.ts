/**
 * Customer order history + order email hooks against REAL PostgreSQL, through HTTP for the read API and with the real
 * AdminOrdersService / VerificationService for the hooks (recording EmailPort double).
 *
 *   TEST_DATABASE_URL=postgresql://helix@127.0.0.1:54329/helix_field?schema=<your own schema> \
 *   NODE_ENV=test pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only src/orders/__tests__/customer-orders.integration.test.ts
 *
 * tests/run-all.mjs reports this file as SKIPPED when TEST_DATABASE_URL is unset. Refuses non-local databases and the
 * `public`/`dev` schemas. Every row is tagged and removed in `after` (no truncation).
 */
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for the integration suite (run tests/run-all.mjs to see it reported as SKIPPED).');
const parsed = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || !/helix|test/i.test(parsed.pathname)) {
  throw new Error(`Refusing to run: ${parsed.hostname}${parsed.pathname} is not a local helix/test database.`);
}
if (['public', 'dev', null].includes(parsed.searchParams.get('schema'))) throw new Error('Refusing to run against the public/dev schema: use your own scratch schema.');
process.env.DATABASE_URL = url;
if (process.env.NODE_ENV === 'production') process.env.NODE_ENV = 'test';

const tag = `co${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const STAFF_NOTE = `STAFF-ONLY-${tag}: customer is difficult`;
const ADMIN_NAME = `Staffer-${tag}`;

let app: import('@nestjs/common').INestApplication;
let prisma: import('../../prisma.service').PrismaService;
let base = '';
let product: { id: string; slug: string; name: string };
let admin: { id: string };
const lotCode = `LOT-${tag}`;
const customerIds: string[] = [];
const orderIds: string[] = [];
const adminIds: string[] = [];
const emailOf = (label: string) => `${tag}-${label}@example.test`;

async function mkCustomer(label: string) {
  const customer = await prisma.customer.create({ data: { email: emailOf(label) } });
  customerIds.push(customer.id);
  return customer;
}
async function mkOrder(customerId: string, over: { status?: any; createdAt?: Date; shippingAddress?: string | null; subtotalCents?: number | null; quantities?: number[] } = {}) {
  const order = await prisma.order.create({
    data: {
      customerId,
      status: over.status ?? 'PENDING_PAYMENT',
      totalCents: 2500,
      subtotalCents: over.subtotalCents === undefined ? 2300 : over.subtotalCents,
      shippingCents: 200,
      taxCents: 0,
      createdAt: over.createdAt,
      shippingAddress: over.shippingAddress === undefined ? `1 Lab Way ${tag}\nBoston, MA 02110` : over.shippingAddress,
      items: { create: (over.quantities ?? [2]).map((quantity) => ({ productId: product.id, lotCode, quantity, unitCents: 1150 })) },
    },
  });
  orderIds.push(order.id);
  return order;
}
async function get(path: string, label: string | null = 'alice') {
  const res = await fetch(`${base}/v1/orders${path}`, { headers: label ? { 'x-customer-email': emailOf(label) } : {} });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers, body: (text ? JSON.parse(text) : null) as any };
}

before(async () => {
  const { Global, Module, ValidationPipe } = await import('@nestjs/common');
  const { Test } = await import('@nestjs/testing');
  const { PrismaService } = await import('../../prisma.service');
  const { CustomerOrdersController } = await import('../customer-orders.controller');
  const { CustomerOrdersService } = await import('../customer-orders.service');
  prisma = new PrismaService();
  await prisma.$connect();
  const real = prisma;
  @Global()
  @Module({ providers: [{ provide: PrismaService, useValue: real }], exports: [PrismaService] })
  class RealPrismaModule {}
  const moduleRef = await Test.createTestingModule({ imports: [RealPrismaModule], controllers: [CustomerOrdersController], providers: [CustomerOrdersService] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');

  product = await prisma.product.create({ data: { sku: `SKU-${tag}`, slug: `slug-${tag}`, name: `Peptide ${tag}`, active: true, priceCents: 1150, inventory: 10 } });
  await prisma.lot.create({ data: { code: lotCode, productId: product.id, coaKey: 'coa/test.pdf', purity: 99 } });
  const created = await prisma.adminUser.create({ data: { email: `${tag}-owner@example.test`, name: ADMIN_NAME, role: 'OWNER', passwordHash: 'x', mfaSeedEnc: 'x' } });
  admin = created;
  adminIds.push(created.id);
});

after(async () => {
  try {
    const orders = { in: orderIds };
    await prisma.orderEvent.deleteMany({ where: { orderId: orders } });
    await prisma.shipment.deleteMany({ where: { orderId: orders } });
    await prisma.cryptoTransaction.deleteMany({ where: { customerId: { in: customerIds } } });
    await prisma.walletAuditEvent.deleteMany({ where: { customerId: { in: customerIds } } });
    await prisma.creditReservation.deleteMany({ where: { orderId: orders } });
    await prisma.orderItem.deleteMany({ where: { orderId: orders } });
    await prisma.order.deleteMany({ where: { id: orders } });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: adminIds } } });
    await prisma.lot.deleteMany({ where: { code: lotCode } });
    await prisma.product.deleteMany({ where: { id: product?.id } });
  } finally {
    await app?.close();
    await prisma?.$disconnect();
  }
});

test('detail: exact keys, product slug/name from Product, owner-only shipping address, statuses from real events, staff data never serialised', async () => {
  const alice = await mkCustomer('alice');
  const order = await mkOrder(alice.id, { status: 'SHIPPED', createdAt: new Date('2026-10-01T10:00:00.000Z') });
  await prisma.orderEvent.createMany({
    data: [
      { orderId: order.id, kind: 'STATUS', fromStatus: 'PAID', toStatus: 'PROCESSING', note: STAFF_NOTE, adminId: admin.id, createdAt: new Date('2026-10-02T10:00:00.000Z') },
      { orderId: order.id, kind: 'NOTE', note: STAFF_NOTE, adminId: admin.id, createdAt: new Date('2026-10-02T11:00:00.000Z') },
      { orderId: order.id, kind: 'STATUS', fromStatus: 'PROCESSING', toStatus: 'SHIPPED', note: STAFF_NOTE, adminId: admin.id, createdAt: new Date('2026-10-03T10:00:00.000Z') },
    ],
  });
  await prisma.shipment.create({ data: { orderId: order.id, carrier: 'UPS', trackingNumber: '1Z999AA10123456784', shippedAt: new Date('2026-10-03T10:00:00.000Z'), note: STAFF_NOTE, createdByAdminId: admin.id } });
  await prisma.cryptoTransaction.create({
    data: { customerId: alice.id, type: 'PURCHASE', status: 'FINALIZED', amountAtomic: 25_000_000n, sourceAddress: `SRC-${tag}`, destinationAddress: `DST-${tag}`, mint: 'mint', network: 'solana-devnet', reference: `ref-${tag}-1`, orderId: order.id, txSignature: `sig-${tag}-1`, finalizedAt: new Date('2026-10-01T10:30:00.000Z') },
  });

  const res = await get(`/${order.id}`);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), ['id', 'status', 'totalCents', 'subtotalCents', 'shippingCents', 'taxCents', 'currency', 'createdAt', 'shippingAddress', 'items', 'shipments', 'timeline']);
  assert.equal(res.body.shippingAddress, `1 Lab Way ${tag}\nBoston, MA 02110`);
  assert.equal(res.body.subtotalCents, 2300);
  assert.equal(res.body.shippingCents, 200);
  assert.deepEqual(res.body.items.map((item: any) => Object.keys(item)), [['productId', 'slug', 'name', 'lotCode', 'quantity', 'unitCents']]);
  assert.equal(res.body.items[0].slug, `slug-${tag}`);
  assert.equal(res.body.items[0].name, `Peptide ${tag}`);
  assert.deepEqual(res.body.shipments, [
    { carrier: 'UPS', trackingNumber: '1Z999AA10123456784', trackingUrl: 'https://www.ups.com/track?tracknum=1Z999AA10123456784', shippedAt: '2026-10-03T10:00:00.000Z', deliveredAt: null },
  ]);
  assert.deepEqual(res.body.timeline, [
    { status: 'PENDING_PAYMENT', at: '2026-10-01T10:00:00.000Z' },
    { status: 'PAID', at: '2026-10-01T10:30:00.000Z' },
    { status: 'PROCESSING', at: '2026-10-02T10:00:00.000Z' },
    { status: 'SHIPPED', at: '2026-10-03T10:00:00.000Z' },
  ]);
  const list = await get('');
  for (const text of [res.text, list.text]) {
    for (const forbidden of [STAFF_NOTE, 'STAFF-ONLY', ADMIN_NAME, admin.id, 'adminId', 'createdByAdminId', `SRC-${tag}`, `DST-${tag}`, `sig-${tag}`]) {
      assert.ok(!text.includes(forbidden), `leaked ${forbidden}`);
    }
  }
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('list: exact keys, newest first, itemCount, carrier and tracking of the latest shipment, legacy order without events', async () => {
  const gail = await mkCustomer('gail');
  const legacy = await mkOrder(gail.id, { status: 'PAID', subtotalCents: null, shippingAddress: null, createdAt: new Date('2026-05-01T00:00:00.000Z'), quantities: [1, 4] });
  const shipped = await mkOrder(gail.id, { status: 'SHIPPED', createdAt: new Date('2026-06-01T00:00:00.000Z') });
  await prisma.shipment.createMany({
    data: [
      { orderId: shipped.id, carrier: 'USPS', trackingNumber: 'OLD-1111', shippedAt: new Date('2026-06-02T00:00:00.000Z') },
      { orderId: shipped.id, carrier: 'FedEx', trackingNumber: 'NEW-2222', shippedAt: new Date('2026-06-03T00:00:00.000Z') },
    ],
  });
  const res = await get('', 'gail');
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), ['items', 'nextCursor']);
  assert.deepEqual(res.body.items.map((item: any) => item.id), [shipped.id, legacy.id]);
  for (const item of res.body.items) assert.deepEqual(Object.keys(item), ['id', 'status', 'totalCents', 'subtotalCents', 'shippingCents', 'taxCents', 'currency', 'createdAt', 'itemCount', 'carrier', 'trackingNumber']);
  assert.deepEqual([res.body.items[0].carrier, res.body.items[0].trackingNumber, res.body.items[0].itemCount], ['FedEx', 'NEW-2222', 2]);
  assert.deepEqual([res.body.items[1].carrier, res.body.items[1].trackingNumber, res.body.items[1].itemCount, res.body.items[1].subtotalCents], [null, null, 5, null]);

  const detail = await get(`/${legacy.id}`, 'gail');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.shippingAddress, null);
  assert.equal(detail.body.subtotalCents, null);
  assert.deepEqual(detail.body.timeline, [{ status: 'PENDING_PAYMENT', at: '2026-05-01T00:00:00.000Z' }]);
  assert.deepEqual(detail.body.shipments, []);
});

test('isolation: another customer gets the same 404 as for an unknown id; neither list contains the other’s orders', async () => {
  const bob = await mkCustomer('bob');
  const carol = await mkCustomer('carol');
  const bobs = await mkOrder(bob.id, { shippingAddress: `99 Private Road ${tag}` });
  const carols = await mkOrder(carol.id);
  const cross = await get(`/${bobs.id}`, 'carol');
  const unknown = await get('/cmunknownorderid00000000', 'carol');
  assert.equal(cross.status, 404);
  assert.equal(unknown.status, 404);
  assert.equal(cross.text, unknown.text);
  assert.ok(!cross.text.includes('Private Road'));
  assert.equal((await get(`/${bobs.id}`, 'bob')).status, 200);
  assert.deepEqual((await get('', 'bob')).body.items.map((i: any) => i.id), [bobs.id]);
  assert.deepEqual((await get('', 'carol')).body.items.map((i: any) => i.id), [carols.id]);
  assert.equal((await get('', 'nobody-here')).status, 200);
  assert.deepEqual((await get('', 'nobody-here')).body, { items: [], nextCursor: null });
  assert.equal((await get('/x', 'nobody-here')).status, 404);
  assert.equal(await prisma.customer.count({ where: { email: emailOf('nobody-here') } }), 0, 'reads never create customers');
  assert.equal((await get('', null)).status, 401);
});

test('pagination across createdAt ties: every order exactly once, createdAt desc then id desc, cursor is opaque', async () => {
  const hank = await mkCustomer('hank');
  const tie = new Date('2026-03-01T00:00:00.000Z');
  const tied: string[] = [];
  for (let i = 0; i < 7; i++) tied.push((await mkOrder(hank.id, { createdAt: tie })).id);
  const newest = (await mkOrder(hank.id, { createdAt: new Date('2026-03-02T00:00:00.000Z') })).id;
  const oldest = (await mkOrder(hank.id, { createdAt: new Date('2026-02-01T00:00:00.000Z') })).id;

  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const res: any = await get(`?limit=2${cursor ? `&cursor=${cursor}` : ''}`, 'hank');
    assert.equal(res.status, 200);
    seen.push(...res.body.items.map((i: any) => i.id));
    cursor = res.body.nextCursor;
    if (cursor) assert.match(cursor, /^[A-Za-z0-9_-]+$/);
    pages++;
  } while (cursor && pages < 20);
  assert.equal(pages, 5);
  assert.deepEqual(seen, [newest, ...[...tied].sort().reverse(), oldest]);
  for (const query of ['?limit=0', '?limit=51', '?limit=x', '?cursor=%21%21', `?cursor=${Buffer.from('{"t":"a","i":"b"}').toString('base64url')}`]) {
    assert.equal((await get(query, 'hank')).status, 400, query);
  }
  assert.equal((await get('?limit=50', 'hank')).status, 200);
});

test('shipments through the real table: OTHER has no URL and hostile numbers are fully encoded', async () => {
  const ivy = await mkCustomer('ivy');
  const order = await mkOrder(ivy.id, { status: 'SHIPPED' });
  await prisma.shipment.createMany({
    data: [
      { orderId: order.id, carrier: 'OTHER', trackingNumber: 'LOCAL-1234', shippedAt: new Date('2026-10-03T00:00:00.000Z') },
      { orderId: order.id, carrier: 'DHL', trackingNumber: '1234 5678&x=1#frag', shippedAt: new Date('2026-10-04T00:00:00.000Z') },
    ],
  });
  const res = await get(`/${order.id}`, 'ivy');
  assert.equal(res.body.shipments[0].trackingUrl, null);
  assert.equal(res.body.shipments[1].trackingUrl, 'https://www.dhl.com/global-en/home/tracking.html?tracking-id=1234%205678%26x%3D1%23frag');
});

test('admin ship through the REAL service: one order_shipped per shipment, and the customer then sees the shipment and timeline', async () => {
  const { AdminOrdersService } = await import('../../admin/orders/admin-orders.service');
  const { RecordingEmail } = await import('./recording-email');
  const jade = await mkCustomer('jade');
  const email = new RecordingEmail();
  const service = new AdminOrdersService(prisma, { record: async () => undefined } as any, email);
  const actor = { id: admin.id, ip: null };
  const order = await mkOrder(jade.id, { status: 'PAID', createdAt: new Date('2026-10-01T00:00:00.000Z') });

  await service.startPacking(order.id, actor);
  assert.equal(email.attempts.length, 0, 'packing sends nothing');
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, n) => service.ship(order.id, { carrier: 'FedEx', trackingNumber: `RACE-${n}-0000`, note: STAFF_NOTE }, actor)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(await prisma.shipment.count({ where: { orderId: order.id } }), 1);
  const shipment = await prisma.shipment.findFirstOrThrow({ where: { orderId: order.id } });
  assert.equal(email.attempts.length, 1, 'exactly one enqueue for the one shipment');
  assert.deepEqual(email.sent[0], {
    to: emailOf('jade'),
    template: 'order_shipped',
    dedupeKey: `order_shipped:${order.id}:${shipment.trackingNumber}`,
    data: { orderId: order.id, carrier: 'FedEx', trackingNumber: shipment.trackingNumber, trackingUrl: `https://www.fedex.com/fedextrack/?trknbr=${shipment.trackingNumber}` },
  });

  const view = await get(`/${order.id}`, 'jade');
  assert.equal(view.status, 200);
  assert.equal(view.body.status, 'SHIPPED');
  assert.deepEqual(view.body.timeline.map((t: any) => t.status), ['PENDING_PAYMENT', 'PROCESSING', 'SHIPPED']);
  assert.equal(view.body.shipments[0].trackingUrl, `https://www.fedex.com/fedextrack/?trknbr=${shipment.trackingNumber}`);
  assert.ok(!view.text.includes(STAFF_NOTE), 'the ship note is staff-only');
  assert.ok(!view.text.includes(ADMIN_NAME));
});

test('admin ship: a failing, throwing or hung email port never fails the shipment', async () => {
  const { AdminOrdersService } = await import('../../admin/orders/admin-orders.service');
  const { RecordingEmail } = await import('./recording-email');
  const kim = await mkCustomer('kim');
  for (const mode of ['reject', 'throw', 'hang'] as const) {
    const email = new RecordingEmail();
    if (mode === 'hang') email.hang = true;
    else {
      email.failWith = new Error('outbox down');
      email.sync = mode === 'throw';
    }
    const service = new AdminOrdersService(prisma, { record: async () => undefined } as any, email);
    const order = await mkOrder(kim.id, { status: 'PROCESSING' });
    const started = Date.now();
    const detail = await service.ship(order.id, { carrier: 'UPS', trackingNumber: `FAIL-${mode}-1234` }, { id: admin.id, ip: null });
    assert.equal(detail.status, 'SHIPPED', mode);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status, 'SHIPPED', mode);
    assert.equal(await prisma.shipment.count({ where: { orderId: order.id } }), 1, mode);
    assert.ok(Date.now() - started < 1500, `${mode} delayed shipping`);
  }
});

test('payment confirmed through the REAL VerificationService: 10 racing verifications give one PAID flip and one order_confirmation', async () => {
  const { VerificationService } = await import('../../wallet/checkout/verification.service');
  const { USDC_DEVNET_MINT, centsToAtomic } = await import('../../wallet/contracts');
  const { referenceKeyFor } = await import('../../wallet/checkout/checkout.util');
  const { RecordingEmail } = await import('./recording-email');

  const lena = await mkCustomer('lena');
  const order = await mkOrder(lena.id, { status: 'PENDING_PAYMENT' });
  const reference = `ref-${tag}-pay`;
  const signature = `sig-${tag}-pay`;
  const source = `SRC-${tag}-pay`;
  const destination = `DST-${tag}-pay`;
  await prisma.cryptoTransaction.create({
    data: { customerId: lena.id, type: 'PURCHASE', status: 'SUBMITTED', amountAtomic: centsToAtomic(order.totalCents), sourceAddress: source, destinationAddress: destination, mint: USDC_DEVNET_MINT, network: 'solana-devnet', reference, orderId: order.id, txSignature: signature },
  });
  const chain: any = {
    network: 'solana-devnet',
    getTransfer: async () => ({ signature, network: 'solana-devnet', finalized: true, succeeded: true, mint: USDC_DEVNET_MINT, sourceOwner: source, destinationOwner: destination, amountAtomic: centsToAtomic(order.totalCents), referenceKeys: [referenceKeyFor(reference).toBase58()] }),
  };
  const email = new RecordingEmail();
  const verification = new VerificationService(prisma, chain, { enableLiveFulfillment: false } as any, { trigger: async () => undefined }, email);

  const results = await Promise.all(Array.from({ length: 10 }, () => verification.verifyAndSettle({ paymentReference: reference })));
  assert.equal(results.filter((r) => r.outcome === 'FINALIZED' && r.settledNow).length, 1);
  assert.ok(results.every((r) => r.outcome === 'FINALIZED' || r.outcome === 'ALREADY_FINALIZED'));
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status, 'PAID');
  assert.equal(email.attempts.length, 1, 'one enqueue attempt, not merely one outbox row');
  assert.deepEqual(email.sent, [{ to: emailOf('lena'), template: 'order_confirmation', dedupeKey: `order_confirmation:${order.id}`, data: { orderId: order.id, totalCents: 2500, currency: 'USD' } }]);
  await verification.verifyAndSettle({ paymentReference: reference });
  assert.equal(email.attempts.length, 1, 'a later duplicate verification enqueues nothing');

  const view = await get(`/${order.id}`, 'lena');
  assert.equal(view.body.status, 'PAID');
  assert.deepEqual(view.body.timeline.map((t: any) => t.status), ['PENDING_PAYMENT', 'PAID'], 'PAID appears via the finalized purchase even though settlement writes no OrderEvent');
});

test('payment confirmed: a failing, throwing or hung email port never fails settlement', async () => {
  const { VerificationService } = await import('../../wallet/checkout/verification.service');
  const { USDC_DEVNET_MINT, centsToAtomic } = await import('../../wallet/contracts');
  const { referenceKeyFor } = await import('../../wallet/checkout/checkout.util');
  const { RecordingEmail } = await import('./recording-email');
  const max = await mkCustomer('max');
  for (const mode of ['reject', 'throw', 'hang'] as const) {
    const order = await mkOrder(max.id, { status: 'PENDING_PAYMENT' });
    const reference = `ref-${tag}-${mode}`;
    const signature = `sig-${tag}-${mode}`;
    await prisma.cryptoTransaction.create({
      data: { customerId: max.id, type: 'PURCHASE', status: 'SUBMITTED', amountAtomic: centsToAtomic(order.totalCents), sourceAddress: `S-${mode}`, destinationAddress: `D-${mode}`, mint: USDC_DEVNET_MINT, network: 'solana-devnet', reference, orderId: order.id, txSignature: signature },
    });
    const chain: any = {
      network: 'solana-devnet',
      getTransfer: async () => ({ signature, network: 'solana-devnet', finalized: true, succeeded: true, mint: USDC_DEVNET_MINT, sourceOwner: `S-${mode}`, destinationOwner: `D-${mode}`, amountAtomic: centsToAtomic(order.totalCents), referenceKeys: [referenceKeyFor(reference).toBase58()] }),
    };
    const email = new RecordingEmail();
    if (mode === 'hang') email.hang = true;
    else {
      email.failWith = new Error('outbox down');
      email.sync = mode === 'throw';
    }
    const verification = new VerificationService(prisma, chain, { enableLiveFulfillment: false } as any, { trigger: async () => undefined }, email);
    const started = Date.now();
    const result = await verification.verifyAndSettle({ paymentReference: reference });
    assert.equal(result.outcome, 'FINALIZED', mode);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status, 'PAID', mode);
    assert.equal((await prisma.cryptoTransaction.findUniqueOrThrow({ where: { reference } })).status, 'FINALIZED', mode);
    assert.ok(Date.now() - started < 1500, `${mode} delayed settlement`);
  }
});
