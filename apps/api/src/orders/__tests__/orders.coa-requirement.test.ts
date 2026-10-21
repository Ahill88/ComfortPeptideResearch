import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { OrdersService } from '../orders.service';
import { createInMemoryPrisma } from './in-memory-prisma';

const previous = process.env.REQUIRE_PUBLISHED_COA;
afterEach(() => {
  if (previous === undefined) delete process.env.REQUIRE_PUBLISHED_COA;
  else process.env.REQUIRE_PUBLISHED_COA = previous;
});

function setup(publishedCodes: string[]) {
  const { prisma, state } = createInMemoryPrisma([{ id: 'product-a', priceCents: 1000, active: true, lots: [{ code: 'LOT-A' }, { code: 'LOT-NOCOA' }] }]);
  let coaQueries = 0;
  const withLots = { ...prisma, lot: { findMany: async ({ where }: any) => (coaQueries += 1, where.code.in.filter((code: string) => publishedCodes.includes(code)).map((code: string) => ({ code }))) } };
  return { service: new OrdersService(withLots as any), state, publishedCodes, coaQueries: () => coaQueries };
}
const request = (lotCode: string, extra: any[] = []) => ({
  email: 'r@example.test', shippingAddress: '1 Lab Way', researchUseAcknowledged: true as const, idempotencyKey: `key-${lotCode}-${extra.length}-0001`,
  items: [{ productId: 'product-a', lotCode, quantity: 1 }, ...extra],
});

test('gate off (default): lots without a COA are orderable and no COA query is made', async () => {
  delete process.env.REQUIRE_PUBLISHED_COA;
  const { service, coaQueries } = setup([]);
  assert.equal((await service.create(request('LOT-NOCOA'))).totalCents, 1000);
  assert.equal(coaQueries(), 0);
  process.env.REQUIRE_PUBLISHED_COA = 'TRUE';
  assert.ok(await service.create(request('LOT-NOCOA', [{ productId: 'product-a', lotCode: 'LOT-A', quantity: 1 }])), 'only the exact string true enables the gate');
});

test('gate on: a line whose lot has no published coa is 400 "Unavailable product in order" and nothing is created', async () => {
  process.env.REQUIRE_PUBLISHED_COA = 'true';
  const { service, state } = setup(['LOT-A']);
  await assert.rejects(() => service.create(request('LOT-NOCOA')), (error: unknown) => error instanceof BadRequestException && error.message === 'Unavailable product in order');
  await assert.rejects(() => service.create(request('LOT-A', [{ productId: 'product-a', lotCode: 'LOT-NOCOA', quantity: 1 }])), /Unavailable product in order/);
  assert.equal(state.orders.length, 0);
  const ok = await service.create(request('LOT-A'));
  assert.equal(ok.totalCents, 1000);
  assert.equal(state.orders.length, 1);
});

test('gate on: the existing "Invalid lot" check still wins for a lot that is not the product\'s', async () => {
  process.env.REQUIRE_PUBLISHED_COA = 'true';
  const { service } = setup(['LOT-A']);
  await assert.rejects(() => service.create(request('OTHER')), /Invalid lot/);
});

test('gate on: a replay of an already-created order is not re-checked (idempotency unchanged)', async () => {
  process.env.REQUIRE_PUBLISHED_COA = 'true';
  const { service, publishedCodes } = setup(['LOT-A']);
  const first = await service.create(request('LOT-A'));
  publishedCodes.length = 0; // the COA is revoked afterwards
  const again = await service.create(request('LOT-A'));
  assert.equal(again.id, first.id, 'the same request returns the original order');
  await assert.rejects(() => service.create({ ...request('LOT-A'), idempotencyKey: 'a-brand-new-key-0002' }), /Unavailable product in order/);
});
