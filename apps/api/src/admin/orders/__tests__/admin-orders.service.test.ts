import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AdminOrdersService, allowedActionsFor, buildListWhere, decodeCursor, encodeCursor, escapeLike, parseStatusFilter } from '../admin-orders.service';
import { ORDER_STATUSES, PAID_ORDER_CANCEL_MESSAGE } from '../admin-orders.types';
import { createAdminOrdersDouble } from './in-memory-admin-orders';

const actor = { id: 'admin-1', ip: '127.0.0.1' };

function setup() {
  const double = createAdminOrdersDouble();
  // Spy for the stock-release port (the real InventoryService is exercised in the commerce and integration suites).
  const releases: Array<{ tx: unknown; orderId: string; reason: string }> = [];
  const inventory = { failWith: undefined as Error | undefined, releaseForOrder: async (tx: unknown, orderId: string, reason: string) => { if (inventory.failWith) throw inventory.failWith; releases.push({ tx, orderId, reason }); } };
  return { ...double, releases, inventory, service: new AdminOrdersService(double.prisma as any, double.audit as any, undefined, inventory as any) };
}
const ship = (service: AdminOrdersService, id: string, trackingNumber = '9400 1118 9922') => service.ship(id, { carrier: 'USPS', trackingNumber }, actor);
const status = (error: unknown) => (error as { getStatus?: () => number }).getStatus?.();

test('allowedActions follow the state machine and add-note is always present', () => {
  assert.deepEqual(allowedActionsFor('PENDING_PAYMENT'), ['cancel', 'add-note']);
  assert.deepEqual(allowedActionsFor('PAID'), ['start-packing', 'add-note']);
  assert.deepEqual(allowedActionsFor('PROCESSING'), ['ship', 'add-note']);
  assert.deepEqual(allowedActionsFor('SHIPPED'), ['mark-delivered', 'add-note']);
  for (const terminal of ['DELIVERED', 'CANCELLED', 'REFUNDED'] as const) assert.deepEqual(allowedActionsFor(terminal), ['add-note']);
});

test('cursor is opaque base64url, round-trips (millisecond precision), and rejects garbage with 400', () => {
  const createdAt = new Date('2026-10-01T12:00:00.123Z');
  const cursor = encodeCursor(createdAt, 'cabc123');
  assert.match(cursor, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeCursor(cursor), { createdAt, id: 'cabc123' });
  const bad = ['', '!!!', 'not-base64-json', Buffer.from('{"t":"x","i":"a"}').toString('base64url'), Buffer.from('{"t":1,"i":"a b"}').toString('base64url'), Buffer.from('[]').toString('base64url'), 'a'.repeat(300)];
  for (const value of bad) assert.throws(() => decodeCursor(value), BadRequestException, value);
});

test('status filter parses comma lists, de-duplicates, and rejects unknown values', () => {
  assert.equal(parseStatusFilter(undefined), null);
  assert.equal(parseStatusFilter('  '), null);
  assert.deepEqual(parseStatusFilter('PAID, PROCESSING,PAID'), ['PAID', 'PROCESSING']);
  assert.throws(() => parseStatusFilter('PAID,SHIPPING'), BadRequestException);
  assert.throws(() => parseStatusFilter('paid'), BadRequestException);
  assert.throws(() => parseStatusFilter(','), BadRequestException);
});

test('list where-clause: id prefix OR email substring (insensitive), status IN, keyset (createdAt,id) strictly after the cursor', () => {
  assert.deepEqual(buildListWhere({ statuses: null, q: null, cursor: null }), {});
  const createdAt = new Date('2026-10-01T00:00:00.000Z');
  const where = buildListWhere({ statuses: ['PAID'], q: 'Bea', cursor: { createdAt, id: 'c9' } }) as { AND: unknown[] };
  assert.deepEqual(where.AND, [
    { status: { in: ['PAID'] } },
    { OR: [{ id: { startsWith: 'Bea', mode: 'insensitive' } }, { customer: { email: { contains: 'Bea', mode: 'insensitive' } } }] },
    { OR: [{ createdAt: { lt: createdAt } }, { AND: [{ createdAt }, { id: { lt: 'c9' } }] }] },
  ]);
});

test('LIKE wildcards and the escape character are escaped in search text', () => {
  assert.equal(escapeLike('a%b_c\\d'), 'a\\%b\\_c\\\\d');
  assert.equal(escapeLike('plain@example.test'), 'plain@example.test');
  const where = buildListWhere({ statuses: null, q: '50%_off', cursor: null }) as { AND: Array<{ OR: Array<Record<string, any>> }> };
  assert.equal(where.AND[0].OR[0].id.startsWith, '50\\%\\_off');
});

test('full lifecycle PAID -> PROCESSING -> SHIPPED -> DELIVERED writes events, one shipment, and one audit row per action', async () => {
  const { service, addOrder, state } = setup();
  const order = addOrder();

  const packing = await service.startPacking(order.id, actor);
  assert.equal(packing.status, 'PROCESSING');
  assert.deepEqual(packing.allowedActions, ['ship', 'refund', 'add-note']); // PROCESSING with no refund in progress may be refunded (docs/api/admin-refunds.md)

  const shipped = await service.ship(order.id, { carrier: 'UPS', trackingNumber: '1Z 999 AA1', note: 'left with the dog' }, actor);
  assert.equal(shipped.status, 'SHIPPED');
  assert.equal(shipped.hasShipment, true);
  assert.equal(shipped.trackingNumber, '1Z 999 AA1');
  assert.equal(shipped.shipments.length, 1);
  assert.deepEqual({ carrier: shipped.shipments[0].carrier, note: shipped.shipments[0].note, deliveredAt: shipped.shipments[0].deliveredAt }, { carrier: 'UPS', note: 'left with the dog', deliveredAt: null });
  assert.deepEqual(shipped.allowedActions, ['mark-delivered', 'add-note']);

  const delivered = await service.markDelivered(order.id, actor);
  assert.equal(delivered.status, 'DELIVERED');
  assert.ok(delivered.shipments[0].deliveredAt);
  assert.deepEqual(delivered.allowedActions, ['add-note']);

  assert.deepEqual(
    delivered.events.map((event) => [event.kind, event.fromStatus, event.toStatus, event.adminName]),
    [['STATUS', 'PAID', 'PROCESSING', 'Owner One'], ['STATUS', 'PROCESSING', 'SHIPPED', 'Owner One'], ['STATUS', 'SHIPPED', 'DELIVERED', 'Owner One']],
  );
  assert.equal(delivered.events[1].note, 'left with the dog');
  assert.deepEqual(state.audits.map((a) => [a.action, a.targetType, a.targetId, a.adminId, a.ip]), [
    ['order.start-packing', 'order', order.id, 'admin-1', '127.0.0.1'],
    ['order.ship', 'order', order.id, 'admin-1', '127.0.0.1'],
    ['order.mark-delivered', 'order', order.id, 'admin-1', '127.0.0.1'],
  ]);
  assert.deepEqual(state.audits[1].detail, { fromStatus: 'PROCESSING', toStatus: 'SHIPPED', carrier: 'UPS', trackingNumber: '1Z 999 AA1' });
});

test('every illegal transition is a 409 `Order is <STATUS>; cannot <action>.` and changes nothing', async () => {
  const actions: Record<string, { from: string; run: (s: AdminOrdersService, id: string) => Promise<unknown>; label: string }> = {
    'start-packing': { from: 'PAID', label: 'start packing', run: (s, id) => s.startPacking(id, actor) },
    ship: { from: 'PROCESSING', label: 'ship', run: (s, id) => ship(s, id) },
    'mark-delivered': { from: 'SHIPPED', label: 'mark delivered', run: (s, id) => s.markDelivered(id, actor) },
    cancel: { from: 'PENDING_PAYMENT', label: 'cancel', run: (s, id) => s.cancel(id, 'no longer needed', actor) },
  };
  let checked = 0;
  for (const [name, action] of Object.entries(actions)) {
    for (const current of ORDER_STATUSES.filter((value) => value !== action.from)) {
      const { service, addOrder, state } = setup();
      const order = addOrder({ status: current });
      const paidCancel = name === 'cancel' && ['PAID', 'PROCESSING', 'SHIPPED'].includes(current);
      await assert.rejects(action.run(service, order.id), (error: unknown) => {
        assert.ok(error instanceof ConflictException, `${name} from ${current}`);
        assert.equal((error as ConflictException).message, paidCancel ? PAID_ORDER_CANCEL_MESSAGE : `Order is ${current}; cannot ${action.label}.`);
        return true;
      });
      assert.equal(state.orders[0].status, current);
      assert.equal(state.events.length, 0);
      assert.equal(state.shipments.length, 0);
      assert.equal(state.audits.length, 0, 'a refused action is not audited as done');
      checked += 1;
    }
  }
  assert.equal(checked, 4 * 6);
});

test('skipping steps and shipping a PAID order are refused; cancelling a PAID order gives the refunds message', async () => {
  const { service, addOrder } = setup();
  const paid = addOrder();
  await assert.rejects(ship(service, paid.id), /Order is PAID; cannot ship\./);
  await assert.rejects(service.markDelivered(paid.id, actor), /Order is PAID; cannot mark delivered\./);
  await assert.rejects(service.cancel(paid.id, 'oops', actor), (error: unknown) => error instanceof ConflictException && error.message === 'Paid orders are refunded through the refunds process, not cancelled.');
});

test('unknown order id is 404 for detail and every action (including notes)', async () => {
  const { service } = setup();
  for (const run of [
    () => service.detail('nope'),
    () => service.startPacking('nope', actor),
    () => ship(service, 'nope'),
    () => service.markDelivered('nope', actor),
    () => service.cancel('nope', 'x', actor),
    () => service.addNote('nope', 'x', actor),
  ]) {
    await assert.rejects(run(), NotFoundException);
  }
});

test('cancel works only from PENDING_PAYMENT, stores the reason on the event and keeps it out of the audit detail', async () => {
  const { service, addOrder, state } = setup();
  const order = addOrder({ status: 'PENDING_PAYMENT' });
  const detail = await service.cancel(order.id, '  customer asked to cancel  ', actor);
  assert.equal(detail.status, 'CANCELLED');
  assert.equal(detail.events[0].note, 'customer asked to cancel');
  assert.deepEqual(detail.allowedActions, ['add-note']);
  assert.deepEqual(state.audits[0].detail, { fromStatus: 'PENDING_PAYMENT', toStatus: 'CANCELLED' });
  assert.ok(!JSON.stringify(state.audits).includes('customer asked'));
});

test('summary and detail carry subtotalCents (null for legacy orders), shippingCents and taxCents', async () => {
  const { service, addOrder } = setup();
  const legacy = addOrder();
  const legacyDetail = await service.detail(legacy.id);
  assert.deepEqual({ s: legacyDetail.subtotalCents, h: legacyDetail.shippingCents, t: legacyDetail.taxCents }, { s: null, h: 0, t: 0 });
  const priced = addOrder({ totalCents: 2764, subtotalCents: 2000, shippingCents: 599, taxCents: 165 } as any);
  const detail = await service.detail(priced.id);
  assert.deepEqual({ s: detail.subtotalCents, h: detail.shippingCents, t: detail.taxCents, total: detail.totalCents }, { s: 2000, h: 599, t: 165, total: 2764 });
});

test('cancel releases the order stock through the inventory port inside the same transaction as the status flip', async () => {
  const { service, addOrder, releases, state } = setup();
  const order = addOrder({ status: 'PENDING_PAYMENT' });
  await service.cancel(order.id, 'customer asked', actor);
  assert.equal(releases.length, 1);
  assert.equal(releases[0].orderId, order.id);
  assert.equal(releases[0].reason, 'Cancelled by admin');
  assert.notEqual(releases[0].tx, undefined, 'called with the transaction client, not outside a transaction');
  // A second cancel (double click) is a 409 and does not release again.
  await assert.rejects(service.cancel(order.id, 'again', actor), ConflictException);
  assert.equal(releases.length, 1);
  assert.equal(state.events.length, 1);
});

test('if the stock release fails the cancel is rolled back completely (still PENDING_PAYMENT, no event, no audit)', async () => {
  const { service, addOrder, inventory, state } = setup();
  const order = addOrder({ status: 'PENDING_PAYMENT' });
  inventory.failWith = new Error('ledger unavailable');
  await assert.rejects(service.cancel(order.id, 'x', actor), /ledger unavailable/);
  assert.equal(state.orders[0].status, 'PENDING_PAYMENT');
  assert.equal(state.events.length, 0);
  assert.equal(state.audits.length, 0);
});

test('a PAID order cancel attempt never touches stock; money/fulfilment moves do not release stock either', async () => {
  const { service, addOrder, releases } = setup();
  const paid = addOrder({ status: 'PAID' });
  await assert.rejects(service.cancel(paid.id, 'x', actor), ConflictException);
  await service.startPacking(paid.id, actor);
  await ship(service, paid.id);
  assert.equal(releases.length, 0);
});

test('10 parallel ship calls: exactly one succeeds, nine are 409, exactly one shipment, one STATUS event, one audit row', async () => {
  const { service, addOrder, state } = setup();
  const order = addOrder({ status: 'PROCESSING' });
  // Yield inside the winning transaction so the losers genuinely overlap with it.
  state.afterFlip = () => new Promise((resolve) => setTimeout(resolve, 15));
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, n) => ship(service, order.id, `TRACK-${n}-0000`)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  assert.equal(rejected.length, 9);
  for (const r of rejected) {
    assert.equal(status(r.reason), 409);
    assert.match(r.reason.message, /Order is SHIPPED; cannot ship\./);
  }
  assert.equal(state.shipments.length, 1);
  assert.equal(state.events.filter((e) => e.kind === 'STATUS').length, 1);
  assert.equal(state.audits.filter((a) => a.action === 'order.ship').length, 1);
  assert.equal(state.orders[0].status, 'SHIPPED');
});

test('a duplicate tracking number for the order is a 409 and rolls the status flip back completely', async () => {
  const { service, addOrder, state } = setup();
  const order = addOrder({ status: 'PROCESSING' });
  state.shipments.push({ id: 'shp-old', orderId: order.id, carrier: 'UPS', trackingNumber: 'DUP-0001', shippedAt: new Date(), deliveredAt: null, note: null });
  await assert.rejects(ship(service, order.id, 'DUP-0001'), (error: unknown) => error instanceof ConflictException && /already recorded/.test(error.message));
  assert.equal(state.orders[0].status, 'PROCESSING');
  assert.equal(state.events.length, 0);
  assert.equal(state.shipments.length, 1);
  assert.equal(state.audits.length, 0);
  // A different number then works.
  assert.equal((await ship(service, order.id, 'DUP-0002')).status, 'SHIPPED');
});

test('a unique-constraint violation raised by the shipment insert (racing writer after the pre-check) is also a 409 with rollback', async () => {
  const { service, addOrder, state } = setup();
  const order = addOrder({ status: 'PROCESSING' });
  state.shipments.push({ id: 'shp-race', orderId: order.id, carrier: 'UPS', trackingNumber: 'RACE-0001', shippedAt: new Date(), deliveredAt: null, note: null });
  state.blindPrecheck = true;
  await assert.rejects(ship(service, order.id, 'RACE-0001'), (error: unknown) => error instanceof ConflictException && /already recorded/.test(error.message));
  assert.equal(state.orders[0].status, 'PROCESSING');
  assert.equal(state.events.length, 0);
  assert.equal(state.audits.length, 0);
});

test('notes are allowed in any status, are NOTE events with no status change, and audit only the length', async () => {
  const { service, addOrder, state } = setup();
  for (const current of ORDER_STATUSES) {
    const order = addOrder({ status: current });
    const detail = await service.addNote(order.id, `  call buyer about ${current}  `, actor);
    assert.equal(detail.status, current);
    assert.deepEqual([detail.events[0].kind, detail.events[0].fromStatus, detail.events[0].toStatus, detail.events[0].note], ['NOTE', null, null, `call buyer about ${current}`]);
  }
  assert.ok(state.audits.every((a) => a.action === 'order.add-note' && Object.keys(a.detail).join() === 'noteLength'));
});

test('detail: shipping address, items with sku/name, payment summary from the best PURCHASE row, no wallet addresses', async () => {
  const { service, addOrder, state } = setup();
  const order = addOrder();
  state.purchases.push(
    { orderId: order.id, type: 'PURCHASE', status: 'FAILED', amountAtomic: 2_500_000n, txSignature: null, network: 'solana-devnet', finalizedAt: null, createdAt: new Date('2026-10-01T12:05:00Z'), sourceAddress: 'WALLET-SRC', destinationAddress: 'WALLET-DST' },
    { orderId: order.id, type: 'PURCHASE', status: 'FINALIZED', amountAtomic: 2_500_000n, txSignature: 'sig-abc', network: 'solana-devnet', finalizedAt: new Date('2026-10-01T12:10:00Z'), createdAt: new Date('2026-10-01T12:06:00Z'), sourceAddress: 'WALLET-SRC', destinationAddress: 'WALLET-DST' },
  );
  const detail = await service.detail(order.id);
  assert.equal(detail.shippingAddress, '1 Lab Way, Boston, MA');
  assert.deepEqual(detail.items.map((item) => [item.sku, item.name, item.lotCode, item.quantity, item.unitCents]), [['SKU-1', 'Test peptide', 'LOT-1', 2, 1250]]);
  assert.equal(detail.itemCount, 2);
  assert.deepEqual(detail.payment, { status: 'FINALIZED', amountAtomic: '2500000', txSignature: 'sig-abc', network: 'solana-devnet', finalizedAt: '2026-10-01T12:10:00.000Z' });
  assert.deepEqual(detail.customer, { id: 'cust-1', email: 'buyer@example.test', name: 'Bea Buyer' });
  assert.deepEqual(Object.keys(detail).sort(), ['allowedActions', 'createdAt', 'currency', 'customer', 'events', 'hasShipment', 'id', 'itemCount', 'items', 'payment', 'refund', 'shipments', 'shippingAddress', 'shippingCents', 'status', 'subtotalCents', 'taxCents', 'totalCents', 'trackingNumber']);
  assert.ok(!JSON.stringify(detail).includes('WALLET-'));
  assert.equal(detail.hasShipment, false);
  assert.equal(detail.trackingNumber, null);
});

test('an order without a stored address or purchase row still renders (shippingAddress null, payment null)', async () => {
  const { service, addOrder } = setup();
  const order = addOrder({ shippingAddress: null, status: 'PENDING_PAYMENT' });
  const detail = await service.detail(order.id);
  assert.equal(detail.shippingAddress, null);
  assert.equal(detail.payment, null);
});

test('counts are zero-filled for all seven statuses', async () => {
  const { service, addOrder } = setup();
  addOrder({ status: 'PAID' });
  addOrder({ status: 'PAID' });
  addOrder({ status: 'SHIPPED' });
  assert.deepEqual(await service.counts(), { counts: { PENDING_PAYMENT: 0, PAID: 2, PROCESSING: 0, SHIPPED: 1, DELIVERED: 0, CANCELLED: 0, REFUNDED: 0 } });
});

test('a failing audit write never turns a committed action into an error', async () => {
  const { service, addOrder, state } = setup();
  const order = addOrder();
  state.failAuditWrites = true;
  assert.equal((await service.startPacking(order.id, actor)).status, 'PROCESSING');
});

test('list rejects an out-of-range limit, over-long q, bad status and bad cursor before touching the database', async () => {
  const { service } = setup();
  for (const query of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { q: 'x'.repeat(101) }, { status: 'NOPE' }, { cursor: 'garbage!' }]) {
    await assert.rejects(service.list(query), BadRequestException, JSON.stringify(query));
  }
});
