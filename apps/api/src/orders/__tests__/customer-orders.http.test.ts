import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { Body, Controller, type INestApplication, Post, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma.service';
import { CustomerOrdersController } from '../customer-orders.controller';
import { CustomerOrdersService } from '../customer-orders.service';
import { OrdersModule } from '../orders.module';
import { createCustomerOrdersDouble } from './customer-orders.double';

const NOTE = 'STAFF-NOTE-do-not-show: customer asked twice';
const ADDRESS = '1 Lab Way, Boston, MA 02110';
const double = createCustomerOrdersDouble();
const alice = double.addCustomer('alice@example.test');
const bob = double.addCustomer('bob@example.test');
const product = double.addProduct({ slug: 'bpc-157', name: 'BPC-157 (research use)' });

/** Stand-ins for the OTHER engineer's POST handlers on the same prefix, to prove the paths coexist. */
@Controller('orders')
class StubWriteController {
  @Post() create(@Body() body: unknown) { return { route: 'create', body }; }
  @Post('quote') quote(@Body() body: unknown) { return { route: 'quote', body }; }
}

let app: INestApplication;
let appReversed: INestApplication;
let base = '';
let baseReversed = '';

async function boot(controllers: any[]) {
  const moduleRef = await Test.createTestingModule({
    controllers,
    providers: [CustomerOrdersService, { provide: PrismaService, useValue: double.prisma }],
  }).compile();
  const instance = moduleRef.createNestApplication({ logger: false });
  instance.setGlobalPrefix('v1');
  instance.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await instance.listen(0, '127.0.0.1');
  return { instance, root: (await instance.getUrl()).replace('[::1]', '127.0.0.1') };
}

before(async () => {
  ({ instance: app, root: base } = await boot([StubWriteController, CustomerOrdersController]));
  ({ instance: appReversed, root: baseReversed } = await boot([CustomerOrdersController, StubWriteController]));
});
after(async () => {
  await app?.close();
  await appReversed?.close();
});

async function get(path: string, email: string | null = 'alice@example.test', root = base) {
  const res = await fetch(`${root}/v1/orders${path}`, { headers: email ? { 'x-customer-email': email } : {} });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: (text ? JSON.parse(text) : null) as any };
}

function seedFullOrder() {
  const order = double.addOrder(alice.id, { status: 'SHIPPED', subtotalCents: 2300, shippingCents: 200, taxCents: 0, totalCents: 2500 });
  double.addItem(order.id, product.id, { quantity: 2, unitCents: 1150, lotCode: 'LOT-A' });
  double.addEvent(order.id, { kind: 'STATUS', fromStatus: 'PAID', toStatus: 'PROCESSING', adminId: 'admin-staff-1', note: NOTE, createdAt: new Date('2026-10-02T12:00:00.000Z') });
  double.addEvent(order.id, { kind: 'NOTE', note: NOTE, adminId: 'admin-staff-1', createdAt: new Date('2026-10-02T13:00:00.000Z') });
  double.addEvent(order.id, { kind: 'STATUS', fromStatus: 'PROCESSING', toStatus: 'SHIPPED', adminId: 'admin-staff-1', note: NOTE, createdAt: new Date('2026-10-03T12:00:00.000Z') });
  double.addShipment(order.id, { carrier: 'UPS', trackingNumber: '1Z999AA10123456784', note: NOTE });
  double.state.purchases.push({ orderId: order.id, type: 'PURCHASE', status: 'FINALIZED', finalizedAt: new Date('2026-10-01T12:30:00.000Z') });
  return order;
}

test('GET /v1/orders/:id: exact contract shape, derived timeline, tracking URL, owner-only address', async () => {
  const order = seedFullOrder();
  const res = await get(`/${order.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(res.body), ['id', 'status', 'totalCents', 'subtotalCents', 'shippingCents', 'taxCents', 'currency', 'createdAt', 'shippingAddress', 'items', 'shipments', 'timeline']);
  assert.equal(res.body.shippingAddress, ADDRESS);
  assert.deepEqual(res.body.items, [{ productId: product.id, slug: 'bpc-157', name: 'BPC-157 (research use)', lotCode: 'LOT-A', quantity: 2, unitCents: 1150 }]);
  assert.deepEqual(res.body.shipments, [
    { carrier: 'UPS', trackingNumber: '1Z999AA10123456784', trackingUrl: 'https://www.ups.com/track?tracknum=1Z999AA10123456784', shippedAt: '2026-10-03T12:00:00.000Z', deliveredAt: null },
  ]);
  assert.deepEqual(res.body.timeline, [
    { status: 'PENDING_PAYMENT', at: '2026-10-01T12:00:00.000Z' },
    { status: 'PAID', at: '2026-10-01T12:30:00.000Z' },
    { status: 'PROCESSING', at: '2026-10-02T12:00:00.000Z' },
    { status: 'SHIPPED', at: '2026-10-03T12:00:00.000Z' },
  ]);
  assert.equal(res.body.subtotalCents, 2300);
  assert.equal(res.body.shippingCents, 200);
});

test('no staff note, admin id or shipment note is ever serialised, in list or detail', async () => {
  const order = seedFullOrder();
  for (const path of ['', `/${order.id}`]) {
    const res = await get(path);
    assert.equal(res.status, 200);
    for (const forbidden of ['STAFF-NOTE', 'customer asked twice', 'admin-staff-1', 'adminId', 'createdByAdminId', 'note', 'Note']) {
      assert.ok(!res.text.includes(forbidden), `${path || '/'} leaked ${forbidden}`);
    }
  }
  const staffKeys = /note|adminId|createdByAdminId|walletAddress|sourceAddress|destinationAddress|txSignature|amountAtomic|email/i;
  const selects = JSON.stringify(double.state.selects.filter((select) => select && typeof select === 'object' && !('email' in (select as object) && Object.keys(select as object).length === 1)));
  assert.ok(!staffKeys.test(selects), `a staff/wallet column is selected: ${selects.match(staffKeys)?.[0]}`);
});

test('list: exact contract keys, newest first, itemCount sums quantities, latest shipment advertised', async () => {
  const order = seedFullOrder();
  double.addShipment(order.id, { carrier: 'FedEx', trackingNumber: 'FX123456789', shippedAt: new Date('2026-10-04T12:00:00.000Z') });
  const res = await get('');
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), ['items', 'nextCursor']);
  const row = res.body.items.find((item: any) => item.id === order.id);
  assert.deepEqual(Object.keys(row), ['id', 'status', 'totalCents', 'subtotalCents', 'shippingCents', 'taxCents', 'currency', 'createdAt', 'itemCount', 'carrier', 'trackingNumber']);
  assert.equal(row.itemCount, 2);
  assert.equal(row.carrier, 'FedEx');
  assert.equal(row.trackingNumber, 'FX123456789');
});

test('isolation: another customer’s order is a 404 identical to an unknown id; lists never include it', async () => {
  const bobsOrder = double.addOrder(bob.id, { shippingAddress: '99 Private Rd, Secretville' });
  double.addItem(bobsOrder.id, product.id);
  const alices = await get(`/${bobsOrder.id}`, 'alice@example.test');
  const unknown = await get('/ord_does_not_exist', 'alice@example.test');
  assert.equal(alices.status, 404);
  assert.equal(unknown.status, 404);
  assert.equal(alices.text.replace(bobsOrder.id, 'X'), unknown.text.replace('ord_does_not_exist', 'X'), 'same body, so existence is not revealed');
  assert.ok(!alices.text.includes('Private Rd'));
  assert.equal((await get(`/${bobsOrder.id}`, 'bob@example.test')).status, 200);
  const aliceList = await get('?limit=50', 'alice@example.test');
  assert.ok(!aliceList.body.items.some((item: any) => item.id === bobsOrder.id));
  const bobList = await get('', 'bob@example.test');
  assert.deepEqual(bobList.body.items.map((item: any) => item.id), [bobsOrder.id]);
});

test('404s: malformed ids never reach the database; a customer with no row sees an empty list and 404s, and nothing is created', async () => {
  const before = double.state.customers.length;
  for (const id of ['%20', 'a%2Fb', 'x'.repeat(65), '..', '%00']) assert.equal((await get(`/${id}`)).status, 404, id);
  const ghost = await get('', 'ghost@example.test');
  assert.equal(ghost.status, 200);
  assert.deepEqual(ghost.body, { items: [], nextCursor: null });
  assert.equal((await get('/anything', 'ghost@example.test')).status, 404);
  assert.equal(double.state.customers.length, before, 'read endpoints never create customers');
});

test('identity: no header is 401; the header is ignored (401) in a production-like runtime', async () => {
  assert.equal((await get('', null)).status, 401);
  assert.equal((await get('/anything', null)).status, 401);
  assert.equal((await get('', 'not-an-email')).status, 401);
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.equal((await get('')).status, 401);
  } finally {
    process.env.NODE_ENV = previous;
  }
});

test('pagination: keyset across createdAt ties visits every row exactly once, newest first, with a stable order', async () => {
  const carol = double.addCustomer('carol@example.test');
  const tie = new Date('2026-09-01T00:00:00.000Z');
  const ids: string[] = [];
  for (let i = 0; i < 7; i++) ids.push(double.addOrder(carol.id, { createdAt: tie }).id);
  const newer = double.addOrder(carol.id, { createdAt: new Date('2026-09-02T00:00:00.000Z') }).id;
  const older = double.addOrder(carol.id, { createdAt: new Date('2026-08-01T00:00:00.000Z') }).id;

  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const res: any = await get(`?limit=3${cursor ? `&cursor=${cursor}` : ''}`, 'carol@example.test');
    assert.equal(res.status, 200);
    assert.ok(res.body.items.length <= 3);
    seen.push(...res.body.items.map((item: any) => item.id));
    cursor = res.body.nextCursor;
    pages++;
  } while (cursor && pages < 10);
  assert.equal(pages, 3);
  assert.equal(new Set(seen).size, 9, 'no duplicates');
  assert.deepEqual(seen, [newer, ...[...ids].sort().reverse(), older], 'createdAt desc, then id desc');

  const exact = await get('?limit=9', 'carol@example.test');
  assert.equal(exact.body.nextCursor, null, 'a full last page has no cursor');
});

test('pagination: limit default 20, max 50, invalid values are 400, a bad cursor is 400', async () => {
  const dave = double.addCustomer('dave@example.test');
  for (let i = 0; i < 25; i++) double.addOrder(dave.id, { createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)) });
  const first = await get('', 'dave@example.test');
  assert.equal(first.body.items.length, 20);
  assert.ok(first.body.nextCursor);
  const second = await get(`?cursor=${first.body.nextCursor}`, 'dave@example.test');
  assert.equal(second.body.items.length, 5);
  assert.equal(second.body.nextCursor, null);
  assert.equal((await get('?limit=50', 'dave@example.test')).body.items.length, 25);
  for (const query of ['?limit=0', '?limit=51', '?limit=-1', '?limit=abc', '?limit=1.5', '?cursor=!!!', `?cursor=${'a'.repeat(201)}`, `?cursor=${Buffer.from('{"t":1}').toString('base64url')}`]) {
    assert.equal((await get(query, 'dave@example.test')).status, 400, query);
  }
  // A cursor minted for one customer cannot widen another customer's view: scoping is by customerId, not by cursor.
  const cross = await get(`?cursor=${first.body.nextCursor}`, 'alice@example.test');
  assert.equal(cross.status, 200);
  assert.ok(cross.body.items.every((item: any) => double.state.orders.find((o) => o.id === item.id)?.customerId === alice.id));
});

test('legacy orders: no events, no subtotal, no address, unknown product still render', async () => {
  const erin = double.addCustomer('erin@example.test');
  const legacy = double.addOrder(erin.id, { subtotalCents: null, shippingAddress: null, status: 'PAID' });
  double.addItem(legacy.id, 'prod-deleted', { quantity: 1 });
  const res = await get(`/${legacy.id}`, 'erin@example.test');
  assert.equal(res.status, 200);
  assert.equal(res.body.subtotalCents, null);
  assert.equal(res.body.shippingAddress, null);
  assert.deepEqual(res.body.timeline, [{ status: 'PENDING_PAYMENT', at: '2026-10-01T12:00:00.000Z' }]);
  assert.deepEqual(res.body.shipments, []);
  assert.equal(res.body.items[0].slug, null);
  assert.equal(res.body.items[0].name, 'Unavailable product');
  const list = await get('', 'erin@example.test');
  assert.deepEqual([list.body.items[0].subtotalCents, list.body.items[0].carrier, list.body.items[0].trackingNumber, list.body.items[0].itemCount], [null, null, null, 1]);
});

test('shipments with OTHER carriers and hostile tracking numbers: trackingUrl null / fully encoded', async () => {
  const fay = double.addCustomer('fay@example.test');
  const order = double.addOrder(fay.id, { status: 'SHIPPED' });
  double.addShipment(order.id, { carrier: 'OTHER', trackingNumber: 'LOCAL-1234', shippedAt: new Date('2026-10-03T00:00:00.000Z') });
  double.addShipment(order.id, { carrier: 'USPS', trackingNumber: '9400 1&x=1#y', shippedAt: new Date('2026-10-04T00:00:00.000Z') });
  const res = await get(`/${order.id}`, 'fay@example.test');
  assert.equal(res.body.shipments[0].trackingUrl, null);
  assert.equal(res.body.shipments[1].trackingUrl, 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400%201%26x%3D1%23y');
});

test('route ordering: GET list/detail coexist with POST /orders and POST /orders/quote in either controller order', async () => {
  for (const root of [base, baseReversed]) {
    const post = await fetch(`${root}/v1/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 1 }) });
    assert.deepEqual(await post.json(), { route: 'create', body: { a: 1 } });
    const quote = await fetch(`${root}/v1/orders/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: 1 }) });
    assert.deepEqual(await quote.json(), { route: 'quote', body: { q: 1 } });
    assert.equal(quote.status, 201);
    const list = await get('', 'alice@example.test', root);
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body.items));
    // `quote` is only ever an order id for GET, so it is a 404, never the quote handler and never a 500.
    assert.equal((await get('/quote', 'alice@example.test', root)).status, 404);
    // Other methods on the shared paths are not handled by the read controller.
    assert.equal((await fetch(`${root}/v1/orders/anything`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${root}/v1/orders`, { method: 'DELETE' })).status, 404);
  }
});

test('OrdersModule registers the customer controller and service after the write controller', () => {
  const controllers: Array<{ name: string }> = Reflect.getMetadata('controllers', OrdersModule);
  const names = controllers.map((controller) => controller.name);
  assert.ok(names.includes('CustomerOrdersController'));
  assert.ok(names.indexOf('OrdersController') < names.indexOf('CustomerOrdersController'));
  const providers: Array<{ name: string }> = Reflect.getMetadata('providers', OrdersModule);
  assert.ok(providers.some((provider) => provider === CustomerOrdersService));
});
