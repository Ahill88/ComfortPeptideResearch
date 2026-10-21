import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { computeRequestHash, normalizeEmail, OrdersService, INT32_MAX, MAX_SHIPPING_ADDRESS_LENGTH } from '../orders.service';
import { createInMemoryPrisma, Product } from './in-memory-prisma';

const productA: Product = { id: 'product-a', priceCents: 1250, active: true, lots: [{ code: 'LOT-A' }] };
const productB: Product = { id: 'product-b', priceCents: 400, active: true, lots: [{ code: 'LOT-B1' }, { code: 'LOT-B2' }] };

function setup(products: Product[] = [productA, productB]) {
  const { prisma, state } = createInMemoryPrisma(products);
  return { service: new OrdersService(prisma as any), state };
}

const request = (overrides: Record<string, unknown> = {}) => ({
  email: 'researcher@example.test',
  shippingAddress: '1 Lab Way, Boston, MA',
  researchUseAcknowledged: true as const,
  idempotencyKey: 'order-key-00000001',
  items: [{ productId: 'product-a', lotCode: 'LOT-A', quantity: 2 }],
  ...overrides,
});

test('order id is server-generated and never the client idempotency key', async () => {
  const { service, state } = setup();
  const order = await service.create(request());
  assert.notEqual(order.id, 'order-key-00000001');
  assert.equal(state.orders[0].idempotencyKey, 'order-key-00000001');
  assert.equal(order.totalCents, 2500);
});

test('response keeps the OrderResponse shape and exposes no idempotency bookkeeping', async () => {
  const { service } = setup();
  const order = await service.create(request());
  assert.deepEqual(Object.keys(order).sort(), ['createdAt', 'currency', 'customerId', 'id', 'items', 'researchAcknowledgedAt', 'status', 'totalCents']);
  assert.ok(!('requestHash' in order) && !('idempotencyKey' in order));
  assert.deepEqual(Object.keys(order.items[0]).sort(), ['id', 'lotCode', 'orderId', 'productId', 'quantity', 'unitCents']);
});

test('same customer, same key, same payload returns the original order without creating another', async () => {
  const { service, state } = setup();
  const first = await service.create(request());
  const second = await service.create(request());
  assert.equal(second.id, first.id);
  assert.equal(state.orders.length, 1);
});

test('replay ignores line order, email case/whitespace', async () => {
  const { service, state } = setup();
  const lines = [
    { productId: 'product-b', lotCode: 'LOT-B2', quantity: 1 },
    { productId: 'product-a', lotCode: 'LOT-A', quantity: 2 },
  ];
  const first = await service.create(request({ items: lines }));
  const second = await service.create(request({ email: '  Researcher@Example.TEST ', items: [...lines].reverse() }));
  assert.equal(second.id, first.id);
  assert.equal(state.orders.length, 1);
  assert.equal(state.customers.length, 1);
  assert.equal(state.customers[0].email, 'researcher@example.test');
});

test('same key with a different payload is a 409 and never returns or alters the original order', async () => {
  const { service, state } = setup();
  await service.create(request());
  const variants = [
    { items: [{ productId: 'product-a', lotCode: 'LOT-A', quantity: 3 }] },
    { items: [{ productId: 'product-b', lotCode: 'LOT-B1', quantity: 2 }] },
    { shippingAddress: '2 Other Street' },
  ];
  for (const variant of variants) {
    await assert.rejects(service.create(request(variant)), (error: unknown) => {
      assert.ok(error instanceof ConflictException);
      assert.equal((error as ConflictException).message, 'Idempotency key was already used with a different request');
      return true;
    });
  }
  assert.equal(state.orders.length, 1);
  assert.equal(state.orders[0].totalCents, 2500);
});

test('the same key used by a different customer is a brand-new key: separate order, no disclosure', async () => {
  const { service, state } = setup();
  const victim = await service.create(request({ email: 'victim@example.test' }));
  // Attacker squats the victim's key with a completely different payload: must neither 409 nor return the victim's order.
  const attacker = await service.create(
    request({ email: 'attacker@example.test', shippingAddress: 'attacker address', items: [{ productId: 'product-b', lotCode: 'LOT-B1', quantity: 7 }] }),
  );
  assert.notEqual(attacker.id, victim.id);
  assert.notEqual(attacker.customerId, victim.customerId);
  assert.equal(attacker.totalCents, 2800);
  assert.equal(state.orders.length, 2);
  // The victim's own replay still returns the victim's order, not the attacker's.
  const replay = await service.create(request({ email: 'victim@example.test' }));
  assert.equal(replay.id, victim.id);
  assert.equal(replay.totalCents, 2500);
});

test('a lost race on the unique (customerId, key) re-reads the winner within that scope', async () => {
  const { service, state } = setup();
  let winner: any;
  // Customer exists but has no order yet: first lookup misses, then the winner inserts just before our insert.
  await (service as any).prisma.customer.create({ data: { email: 'researcher@example.test' } });
  state.beforeOrderCreate = () => {
    // Synchronous insert of the winner row, as a concurrent transaction committing first.
    const customer = state.customers[0];
    winner = {
      id: 'order-winner',
      customerId: customer.id,
      idempotencyKey: 'order-key-00000001',
      requestHash: computeRequestHash(request()),
      status: 'PENDING_PAYMENT',
      totalCents: 2500,
      currency: 'USD',
      researchAcknowledgedAt: new Date(),
      createdAt: new Date(),
      items: [{ id: 'item-w', orderId: 'order-winner', productId: 'product-a', lotCode: 'LOT-A', quantity: 2, unitCents: 1250 }],
    };
    state.orders.push(winner);
  };
  const result = await service.create(request());
  assert.equal(result.id, 'order-winner');
  assert.equal(state.orders.length, 1);
});

test('a lost race with a different payload surfaces 409, not the winner order', async () => {
  const { service, state } = setup();
  await (service as any).prisma.customer.create({ data: { email: 'researcher@example.test' } });
  state.beforeOrderCreate = () => {
    state.orders.push({
      id: 'order-winner',
      customerId: state.customers[0].id,
      idempotencyKey: 'order-key-00000001',
      requestHash: computeRequestHash(request({ shippingAddress: 'somewhere else' })),
      items: [],
    });
  };
  await assert.rejects(service.create(request()), ConflictException);
});

test('request hash is stable, order independent and sensitive to every meaningful field', () => {
  const base = request();
  const hash = computeRequestHash(base);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(computeRequestHash({ ...base }), hash);
  assert.equal(computeRequestHash({ ...base, email: 'RESEARCHER@example.test ' }), hash);
  assert.notEqual(computeRequestHash({ ...base, email: 'other@example.test' }), hash);
  assert.notEqual(computeRequestHash({ ...base, shippingAddress: 'x' }), hash);
  assert.notEqual(computeRequestHash({ ...base, items: [{ productId: 'product-a', lotCode: 'LOT-A', quantity: 3 }] }), hash);
  assert.notEqual(computeRequestHash({ ...base, items: [{ productId: 'product-a', lotCode: 'LOT-X', quantity: 2 }] }), hash);
  assert.notEqual(computeRequestHash({ ...base, researchUseAcknowledged: false as never }), hash);
  // Does not depend on which idempotency key was sent.
  assert.equal(computeRequestHash({ ...base, idempotencyKey: 'something-else-entirely' } as never), hash);
});

test('email normalization matches the wallet code (trim + lowercase)', () => {
  assert.equal(normalizeEmail('  MiXed@Example.COM  '), 'mixed@example.com');
});

test('quantity, line count and total are bounded before anything touches the database', async () => {
  const { service, state } = setup();
  for (const quantity of [0, -1, 1001, 2_147_483_647, 3_000_000_000, 1.5, Number.NaN]) {
    await assert.rejects(service.create(request({ items: [{ productId: 'product-a', lotCode: 'LOT-A', quantity }] })), /Quantity must be a whole number between 1 and 1000/, String(quantity));
  }
  const tooMany = Array.from({ length: 51 }, () => ({ productId: 'product-a', lotCode: 'LOT-A', quantity: 1 }));
  await assert.rejects(service.create(request({ items: tooMany })), /at most 50 lines/);
  assert.equal(state.orders.length, 0);
  assert.equal(state.customers.length, 0);
});

test('a total beyond the Int32 cents range is a 400, and the maximum accepted total fits Int32', async () => {
  const expensive: Product = { id: 'product-x', priceCents: INT32_MAX, active: true, lots: [{ code: 'LOT-X' }] };
  const { service, state } = setup([expensive]);
  await assert.rejects(service.create(request({ items: [{ productId: 'product-x', lotCode: 'LOT-X', quantity: 2 }] })), /Order total is too large/);
  assert.equal(state.orders.length, 0);
  const ok = await service.create(request({ idempotencyKey: 'order-key-00000002', items: [{ productId: 'product-x', lotCode: 'LOT-X', quantity: 1 }] }));
  assert.equal(ok.totalCents, INT32_MAX);
});

test('lot validation and acknowledgement are still enforced and create no customer rows', async () => {
  const { service, state } = setup();
  await assert.rejects(service.create(request({ items: [{ productId: 'product-a', lotCode: 'LOT-B1', quantity: 1 }] })), /Invalid lot/);
  await assert.rejects(service.create(request({ items: [{ productId: 'nope', lotCode: 'LOT-A', quantity: 1 }] })), /Unavailable product in order/);
  await assert.rejects(service.create(request({ researchUseAcknowledged: false })), /Research-use acknowledgement is required/);
  await assert.rejects(service.create(request({ idempotencyKey: 'short' })), /Idempotency key must be/);
  assert.equal(state.customers.length, 0);
  assert.equal(state.orders.length, 0);
});

test('two lines for the same product with different lots are accepted', async () => {
  const { service } = setup();
  const order = await service.create(
    request({ items: [{ productId: 'product-b', lotCode: 'LOT-B1', quantity: 1 }, { productId: 'product-b', lotCode: 'LOT-B2', quantity: 2 }] }),
  );
  assert.equal(order.totalCents, 1200);
  assert.equal(order.items.length, 2);
});

test('the shipping address is persisted trimmed, never exposed on the public response, and the hash still uses the address as sent', async () => {
  const { service, state } = setup();
  const sent = '  1 Lab Way,\nBoston, MA 02110  ';
  const order = await service.create(request({ shippingAddress: sent }));
  assert.equal(state.orders[0].shippingAddress, '1 Lab Way,\nBoston, MA 02110');
  assert.ok(!('shippingAddress' in order));
  assert.ok(!JSON.stringify(order).includes('Boston'));
  assert.equal(state.orders[0].requestHash, computeRequestHash({ ...request({ shippingAddress: sent }), email: 'researcher@example.test' } as never));
  // Same bytes replay to the same order; a whitespace-only difference is, as before, a different request.
  assert.equal((await service.create(request({ shippingAddress: sent }))).id, order.id);
  await assert.rejects(service.create(request({ shippingAddress: sent.trim() })), ConflictException);
  assert.equal(state.orders.length, 1);
});

test('a blank, missing, non-string or over-long shipping address is a 400 that creates nothing', async () => {
  const { service, state } = setup();
  for (const shippingAddress of ['', '   \n\t ', undefined, null, 42, {}]) {
    await assert.rejects(service.create(request({ shippingAddress })), /A shipping address is required/, String(shippingAddress));
  }
  await assert.rejects(service.create(request({ shippingAddress: 'x'.repeat(MAX_SHIPPING_ADDRESS_LENGTH + 1) })), /at most 500 characters/);
  // The limit applies to the trimmed text.
  await assert.rejects(service.create(request({ shippingAddress: `${'x'.repeat(MAX_SHIPPING_ADDRESS_LENGTH)}y` })), /at most 500/);
  assert.equal(state.orders.length, 0);
  assert.equal(state.customers.length, 0);
  const exact = await service.create(request({ shippingAddress: `  ${'x'.repeat(MAX_SHIPPING_ADDRESS_LENGTH)}  ` }));
  assert.ok(exact.id);
  assert.equal(state.orders[0].shippingAddress.length, 500);
});
