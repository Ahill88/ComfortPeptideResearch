import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AdminOrdersService } from '../admin-orders.service';
import { RecordingEmail } from '../../../orders/__tests__/recording-email';
import { createAdminOrdersDouble } from './in-memory-admin-orders';

const actor = { id: 'admin-1', ip: '127.0.0.1' };

function setup(withEmail = true) {
  const double = createAdminOrdersDouble();
  const email = new RecordingEmail();
  const service = withEmail ? new AdminOrdersService(double.prisma as any, double.audit as any, email) : new AdminOrdersService(double.prisma as any, double.audit as any);
  return { ...double, email, service };
}

test('shipping enqueues order_shipped once, to the customer, with the contract data and dedupeKey', async () => {
  const { service, addOrder, email } = setup();
  const order = addOrder({ status: 'PROCESSING' });
  await service.ship(order.id, { carrier: 'UPS', trackingNumber: '1Z999AA10123456784' }, actor);
  assert.equal(email.attempts.length, 1);
  assert.deepEqual(email.sent[0], {
    to: 'buyer@example.test',
    template: 'order_shipped',
    dedupeKey: `order_shipped:${order.id}:1Z999AA10123456784`,
    data: { orderId: order.id, carrier: 'UPS', trackingNumber: '1Z999AA10123456784', trackingUrl: 'https://www.ups.com/track?tracknum=1Z999AA10123456784' },
  });
  assert.deepEqual(Object.keys(email.sent[0].data), ['orderId', 'carrier', 'trackingNumber', 'trackingUrl']);
});

test('trackingUrl is null for OTHER and encoded for numbers with spaces', async () => {
  const a = setup();
  const orderA = a.addOrder({ status: 'PROCESSING' });
  await a.service.ship(orderA.id, { carrier: 'OTHER', trackingNumber: 'LOCAL 1234' }, actor);
  assert.equal((a.email.sent[0].data as any).trackingUrl, null);
  const b = setup();
  const orderB = b.addOrder({ status: 'PROCESSING' });
  await b.service.ship(orderB.id, { carrier: 'USPS', trackingNumber: '9400 1118 9922' }, actor);
  assert.equal((b.email.sent[0].data as any).trackingUrl, 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400%201118%209922');
});

test('once per shipment: a refused ship (wrong status, duplicate tracking) enqueues nothing', async () => {
  const { service, addOrder, email } = setup();
  const paid = addOrder({ status: 'PAID' });
  await assert.rejects(service.ship(paid.id, { carrier: 'UPS', trackingNumber: 'AAAA1111' }, actor), /cannot ship/);
  assert.equal(email.attempts.length, 0);
  const order = addOrder({ status: 'PROCESSING' });
  await service.ship(order.id, { carrier: 'UPS', trackingNumber: 'AAAA1111' }, actor);
  await assert.rejects(service.ship(order.id, { carrier: 'UPS', trackingNumber: 'AAAA1111' }, actor), /cannot ship|already recorded/);
  assert.equal(email.attempts.length, 1);
});

test('10 racing ship calls: one shipment, one email', async () => {
  const { service, addOrder, email, state } = setup();
  const order = addOrder({ status: 'PROCESSING' });
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, n) => service.ship(order.id, { carrier: 'FedEx', trackingNumber: `TRACK-${n}-0000` }, actor)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(state.shipments.length, 1);
  assert.equal(email.attempts.length, 1);
  assert.equal(email.sent[0].dedupeKey, `order_shipped:${order.id}:${state.shipments[0].trackingNumber}`);
});

test('hook failure never fails the ship: rejecting, throwing, and hung ports all leave a SHIPPED order and a normal response', async () => {
  for (const mode of ['reject', 'throw', 'hang'] as const) {
    const { service, addOrder, email, state } = setup();
    if (mode === 'hang') email.hang = true;
    else {
      email.failWith = new Error('outbox unavailable');
      email.sync = mode === 'throw';
    }
    const order = addOrder({ status: 'PROCESSING' });
    const started = Date.now();
    const detail = await service.ship(order.id, { carrier: 'DHL', trackingNumber: 'DHL-0001-AB' }, actor);
    assert.equal(detail.status, 'SHIPPED', mode);
    assert.equal(state.shipments.length, 1, mode);
    assert.equal(state.audits.filter((a) => a.action === 'order.ship').length, 1, mode);
    assert.ok(Date.now() - started < 1500, `${mode} delayed shipping`);
  }
});

test('a failing customer lookup is also fail-soft, and no port bound means no email and no error', async () => {
  const { service, addOrder, email, state, prisma } = setup();
  const order = addOrder({ status: 'PROCESSING' });
  const original = prisma.order.findUnique;
  let calls = 0;
  (prisma.order as any).findUnique = async (args: any) => {
    // The first lookup after the transaction is the hook's; make it fail, let detail() work.
    if (++calls === 1) throw new Error('replica down');
    return original(args);
  };
  const detail = await service.ship(order.id, { carrier: 'UPS', trackingNumber: 'AAAA1111' }, actor);
  assert.equal(detail.status, 'SHIPPED');
  assert.equal(email.attempts.length, 0);
  assert.equal(state.shipments.length, 1);

  const bare = setup(false);
  const o2 = bare.addOrder({ status: 'PROCESSING' });
  assert.equal((await bare.service.ship(o2.id, { carrier: 'UPS', trackingNumber: 'BBBB2222' }, actor)).status, 'SHIPPED');
});
