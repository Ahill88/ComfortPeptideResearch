import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { type CanActivate, type ExecutionContext, type INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../../prisma.service';
import { AdminAuditService } from '../../admin-audit.service';
import { AdminSessionGuard } from '../../admin-session.guard';
import { AdminOrdersController } from '../admin-orders.controller';
import { AdminOrdersService } from '../admin-orders.service';
import { createAdminOrdersDouble } from './in-memory-admin-orders';

/** Test principal: any request carrying `x-test-admin` is OWNER admin-1; everything else is the guard's 401. */
class TestGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    if (request.headers['x-test-admin'] !== 'yes') throw new UnauthorizedException('Admin sign-in required.');
    request.admin = { id: 'admin-1', email: 'owner@example.test', name: 'Owner One', role: 'OWNER' };
    return true;
  }
}

const double = createAdminOrdersDouble();
let app: INestApplication;
let base = '';

async function call(method: string, path: string, body?: unknown, auth = true) {
  const res = await fetch(`${base}/v1/admin/orders${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? { 'x-test-admin': 'yes' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: (await res.json().catch(() => null)) as any };
}

before(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [AdminOrdersController],
    providers: [AdminOrdersService, { provide: PrismaService, useValue: double.prisma }, { provide: AdminAuditService, useValue: double.audit }],
  })
    .overrideGuard(AdminSessionGuard)
    .useClass(TestGuard)
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
});
after(async () => {
  await app?.close();
});

test('every route is guarded: without a session each of the eight routes is 401 and nothing changes', async () => {
  const order = double.addOrder({ status: 'PROCESSING' });
  const routes: Array<[string, string, unknown?]> = [
    ['GET', '/counts'],
    ['GET', ''],
    ['GET', `/${order.id}`],
    ['POST', `/${order.id}/start-packing`, {}],
    ['POST', `/${order.id}/ship`, { carrier: 'UPS', trackingNumber: '1Z999AA1' }],
    ['POST', `/${order.id}/mark-delivered`, {}],
    ['POST', `/${order.id}/cancel`, { reason: 'x' }],
    ['POST', `/${order.id}/notes`, { note: 'x' }],
  ];
  for (const [method, path, body] of routes) {
    const res = await call(method, path, body, false);
    assert.equal(res.status, 401, `${method} ${path}`);
  }
  assert.equal(double.state.orders.find((o) => o.id === order.id)?.status, 'PROCESSING');
  assert.equal(double.state.events.length, 0);
});

test('/counts is not swallowed by /:id and responses are no-store', async () => {
  const res = await call('GET', '/counts');
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), ['counts']);
  assert.deepEqual(Object.keys(res.body.counts), ['PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED']);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('actions return 200 with the updated detail, attribute the admin, and unknown ids are 404', async () => {
  const order = double.addOrder({ status: 'PAID' });
  const packing = await call('POST', `/${order.id}/start-packing`, {});
  assert.equal(packing.status, 200, JSON.stringify(packing.body));
  assert.equal(packing.body.status, 'PROCESSING');
  const shipped = await call('POST', `/${order.id}/ship`, { carrier: 'FedEx', trackingNumber: '  7777 8888 9999  ', note: ' fragile ' });
  assert.equal(shipped.status, 200, JSON.stringify(shipped.body));
  assert.equal(shipped.body.trackingNumber, '7777 8888 9999');
  assert.equal(shipped.body.shipments[0].note, 'fragile');
  const delivered = await call('POST', `/${order.id}/mark-delivered`);
  assert.equal(delivered.status, 200);
  assert.equal(delivered.body.status, 'DELIVERED');
  assert.ok(double.state.audits.every((audit) => audit.adminId === 'admin-1'));
  assert.equal((await call('GET', '/nope')).status, 404);
  assert.equal((await call('POST', '/nope/start-packing', {})).status, 404);
});

test('illegal transitions are 409 with the contract message over HTTP', async () => {
  const paid = double.addOrder({ status: 'PAID' });
  const ship = await call('POST', `/${paid.id}/ship`, { carrier: 'USPS', trackingNumber: 'ABCD1234' });
  assert.equal(ship.status, 409);
  assert.equal(ship.body.message, 'Order is PAID; cannot ship.');
  const cancel = await call('POST', `/${paid.id}/cancel`, { reason: 'changed my mind' });
  assert.equal(cancel.status, 409);
  assert.equal(cancel.body.message, 'Paid orders are refunded through the refunds process, not cancelled.');
  const delivered = await call('POST', `/${paid.id}/mark-delivered`, {});
  assert.equal(delivered.body.message, 'Order is PAID; cannot mark delivered.');
});

test('ship validation: carrier enum and tracking number rules (4-64 chars, alphanumeric start, letters/digits/space/hyphen)', async () => {
  const order = double.addOrder({ status: 'PROCESSING' });
  const url = `/${order.id}/ship`;
  const valid = { carrier: 'USPS', trackingNumber: 'ABCD1234' };
  const bad: Array<Record<string, unknown>> = [
    { ...valid, carrier: 'usps' },
    { ...valid, carrier: 'Fedex' },
    { ...valid, carrier: 'PIGEON' },
    { trackingNumber: valid.trackingNumber },
    { carrier: 'UPS' },
    { ...valid, trackingNumber: 'abc' },
    { ...valid, trackingNumber: '   abc   ' },
    { ...valid, trackingNumber: 'a'.repeat(65) },
    { ...valid, trackingNumber: '-ABCD1234' },
    { ...valid, trackingNumber: 'ABCD_1234' },
    { ...valid, trackingNumber: 'ABCD#1234' },
    { ...valid, trackingNumber: 'ABCD\n1234' },
    { ...valid, trackingNumber: 12345678 },
    { ...valid, note: 'n'.repeat(501) },
    { ...valid, note: 5 },
  ];
  for (const body of bad) {
    const res = await call('POST', url, body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal(double.state.orders.find((o) => o.id === order.id)?.status, 'PROCESSING', 'invalid input never changes the order');
  for (const carrier of ['USPS', 'UPS', 'FedEx', 'DHL', 'OTHER']) {
    const fresh = double.addOrder({ status: 'PROCESSING' });
    const res = await call('POST', `/${fresh.id}/ship`, { carrier, trackingNumber: 'a'.repeat(4) });
    assert.equal(res.status, 200, carrier);
  }
  const longest = double.addOrder({ status: 'PROCESSING' });
  assert.equal((await call('POST', `/${longest.id}/ship`, { carrier: 'DHL', trackingNumber: 'z'.repeat(64), note: 'n'.repeat(500) })).status, 200);
});

test('cancel reason and note bounds', async () => {
  const pending = double.addOrder({ status: 'PENDING_PAYMENT' });
  for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 'r'.repeat(501) }, { reason: 7 }]) {
    assert.equal((await call('POST', `/${pending.id}/cancel`, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await call('POST', `/${pending.id}/cancel`, { reason: 'r'.repeat(500) })).status, 200);
  for (const body of [{}, { note: '' }, { note: '  ' }, { note: 'n'.repeat(1001) }, { note: [] }]) {
    assert.equal((await call('POST', `/${pending.id}/notes`, body)).status, 400, JSON.stringify(body));
  }
  const ok = await call('POST', `/${pending.id}/notes`, { note: 'n'.repeat(1000) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.events.at(-1).kind, 'NOTE');
});

test('list query validation: limit 1-100, status values, cursor', async () => {
  for (const query of ['limit=0', 'limit=101', 'limit=abc', 'limit=1.5', 'status=BOGUS', 'status=PAID,BOGUS', 'cursor=!!!', `q=${'x'.repeat(101)}`]) {
    assert.equal((await call('GET', `?${query}`)).status, 400, query);
  }
});
