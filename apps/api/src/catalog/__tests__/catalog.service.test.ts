import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { NotFoundException } from '@nestjs/common';
import { CatalogService } from '../catalog.service';

const lot = (code: string) => ({ id: `id-${code}`, code, productId: 'p1', coaKey: 'PENDING-NO-COA', purity: '0', releasedAt: new Date('2026-01-01T00:00:00Z') });
const product = { id: 'p1', sku: 'S', slug: 'p-1', name: 'P', active: true, priceCents: 100, inventory: 3, lots: [lot('A'), lot('B'), lot('C')] };
const prisma = {
  product: { findMany: async () => [structuredClone(product)], findUnique: async ({ where }: any) => (where.slug === 'p-1' ? structuredClone(product) : null) },
  lot: { findMany: async ({ where }: any) => where.code.in.filter((code: string) => code === 'B').map((code: string) => ({ code })) },
};
const service = new CatalogService(prisma as any);
const previous = process.env.REQUIRE_PUBLISHED_COA;
afterEach(() => {
  if (previous === undefined) delete process.env.REQUIRE_PUBLISHED_COA;
  else process.env.REQUIRE_PUBLISHED_COA = previous;
});

test('default (gate off): every lot is listed and carries coaPublished; other product fields are unchanged', async () => {
  delete process.env.REQUIRE_PUBLISHED_COA;
  const one = await service.one('p-1');
  assert.deepEqual(one.lots.map((l) => [l.code, l.coaPublished]), [['A', false], ['B', true], ['C', false]]);
  assert.deepEqual(Object.keys(one.lots[0]).sort(), ['coaKey', 'coaPublished', 'code', 'id', 'productId', 'purity', 'releasedAt']);
  assert.deepEqual(Object.keys(one).sort(), ['active', 'id', 'inventory', 'lots', 'name', 'priceCents', 'sku', 'slug']);
  const [listed] = await service.list();
  assert.deepEqual(listed.lots.map((l) => l.code), ['A', 'B', 'C']);
});

test('REQUIRE_PUBLISHED_COA=true keeps only lots with a published coa (list and one); other values do not', async () => {
  process.env.REQUIRE_PUBLISHED_COA = 'true';
  assert.deepEqual((await service.one('p-1')).lots.map((l) => l.code), ['B']);
  assert.deepEqual((await service.list())[0].lots.map((l) => l.code), ['B']);
  process.env.REQUIRE_PUBLISHED_COA = 'TRUE';
  assert.equal((await service.one('p-1')).lots.length, 3);
});

test('unknown slug is still 404', async () => {
  await assert.rejects(() => service.one('nope'), NotFoundException);
});
