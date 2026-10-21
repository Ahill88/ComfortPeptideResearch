import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isPublishedCoaRequired, lotsWithPublishedCoa } from '../coa-requirement';

test('REQUIRE_PUBLISHED_COA: only the exact string "true" enables the gate; default off', () => {
  assert.equal(isPublishedCoaRequired({}), false);
  assert.equal(isPublishedCoaRequired({ REQUIRE_PUBLISHED_COA: 'true' }), true);
  for (const value of ['false', '', 'TRUE', 'True', '1', 'yes', ' true', 'true ', 'on']) assert.equal(isPublishedCoaRequired({ REQUIRE_PUBLISHED_COA: value }), false, JSON.stringify(value));
});

test('isPublishedCoaRequired reads process.env at call time', () => {
  const previous = process.env.REQUIRE_PUBLISHED_COA;
  try {
    process.env.REQUIRE_PUBLISHED_COA = 'true';
    assert.equal(isPublishedCoaRequired(), true);
    delete process.env.REQUIRE_PUBLISHED_COA;
    assert.equal(isPublishedCoaRequired(), false);
  } finally {
    if (previous !== undefined) process.env.REQUIRE_PUBLISHED_COA = previous;
  }
});

test('lotsWithPublishedCoa: one query for the distinct codes, PUBLISHED only; empty input skips the database', async () => {
  const seen: any[] = [];
  const reader = { lot: { findMany: async (args: any) => (seen.push(args), [{ code: 'A' }]) } };
  const result = await lotsWithPublishedCoa(reader as any, ['A', 'B', 'A']);
  assert.deepEqual([...result], ['A']);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { where: { code: { in: ['A', 'B'] }, coas: { some: { status: 'PUBLISHED' } } }, select: { code: true } });
  assert.equal((await lotsWithPublishedCoa(reader as any, [])).size, 0);
  assert.equal(seen.length, 1, 'no query for an empty list');
});
