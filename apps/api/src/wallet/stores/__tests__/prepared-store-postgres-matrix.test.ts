import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { InMemoryPreparedMessageStore } from '../../checkout/prepared-message-store';
import { InMemoryPreparedTransactionStore } from '../../transfers/prepared-transaction.store';
import { NODE_ENV_MATRIX, envOf, isAllowed, label } from '../../../config/__tests__/node-env-matrix';
import { PostgresPreparedMessageStore, PostgresPreparedTransactionStore, type PreparedStoreDb } from '../postgres-prepared-stores';
import { createPreparedMessageStore, createPreparedTransactionStore, preparedStoreDatabaseAvailable, resolvePreparedStoreMode } from '../prepared-store.factory';
import { RedisPreparedMessageStore, RedisPreparedTransactionStore } from '../redis-prepared-stores';
import { FakeRedis } from './fake-redis';

const prisma = {} as PreparedStoreDb; // never queried here: only construction is under test
const DATABASE_URL = 'postgresql://helix@127.0.0.1:54329/helix_field?schema=agent_store';

describe('prepared store selection: NODE_ENV x WALLET_PREPARED_STORE x DATABASE_URL', () => {
  for (const value of NODE_ENV_MATRIX) {
    const productionLike = !isAllowed(value);
    test(`NODE_ENV=${label(value)} (${productionLike ? 'production-like' : 'development/test'})`, () => {
      const redis = new FakeRedis({ now: 0 });
      const build = (WALLET_PREPARED_STORE: string | undefined, withDb: boolean) =>
        envOf(value, { WALLET_PREPARED_STORE, ...(withDb ? { DATABASE_URL } : {}) });

      // 1. A database is available and nothing is requested: Postgres is the default everywhere.
      for (const requested of [undefined, '', '   ']) {
        const env = build(requested, true);
        assert.equal(resolvePreparedStoreMode(env), 'postgres');
        assert.ok(createPreparedMessageStore({ env, prisma }) instanceof PostgresPreparedMessageStore);
        assert.ok(createPreparedTransactionStore({ env, prisma }) instanceof PostgresPreparedTransactionStore);
      }
      // 2. Explicit postgres works in every runtime.
      for (const requested of ['postgres', ' POSTGRES ']) {
        const env = build(requested, true);
        assert.equal(resolvePreparedStoreMode(env), 'postgres');
        assert.ok(createPreparedMessageStore({ env, prisma }) instanceof PostgresPreparedMessageStore);
      }
      // 3. Explicit redis works in every runtime, with or without a database.
      for (const withDb of [true, false]) {
        const env = build('redis', withDb);
        assert.equal(resolvePreparedStoreMode(env), 'redis');
        assert.ok(createPreparedMessageStore({ env, redis }) instanceof RedisPreparedMessageStore);
        assert.ok(createPreparedTransactionStore({ env, redis }) instanceof RedisPreparedTransactionStore);
      }
      // 4. In-memory: only when explicitly requested, and only in development/test.
      for (const withDb of [true, false]) {
        for (const requested of ['memory', 'MEMORY', ' memory ']) {
          const env = build(requested, withDb);
          if (productionLike) {
            assert.throws(() => resolvePreparedStoreMode(env), /only allowed when NODE_ENV is exactly "development" or "test"/);
            assert.throws(() => createPreparedMessageStore({ env, redis, prisma }), /memory/);
            assert.throws(() => createPreparedTransactionStore({ env, redis, prisma }), /memory/);
          } else {
            assert.equal(resolvePreparedStoreMode(env), 'memory');
            assert.ok(createPreparedMessageStore({ env, prisma }) instanceof InMemoryPreparedMessageStore);
            assert.ok(createPreparedTransactionStore({ env, prisma }) instanceof InMemoryPreparedTransactionStore);
          }
        }
      }
      // 5. No database and nothing requested: the legacy defaults (redis when production-like, memory in development/test).
      const none = build(undefined, false);
      assert.equal(resolvePreparedStoreMode(none), productionLike ? 'redis' : 'memory');
    });
  }

  test('a production-like runtime never silently lands on memory, with or without DATABASE_URL, for every unset/blank/garbage switch', () => {
    for (const value of NODE_ENV_MATRIX.filter((v) => !isAllowed(v))) {
      for (const WALLET_PREPARED_STORE of [undefined, '', ' ']) {
        for (const withDb of [true, false]) {
          const mode = resolvePreparedStoreMode(envOf(value, { WALLET_PREPARED_STORE, ...(withDb ? { DATABASE_URL } : {}) }));
          assert.notEqual(mode, 'memory');
        }
      }
    }
  });

  test('unknown values still throw, naming every accepted value', () => {
    assert.throws(() => resolvePreparedStoreMode(envOf('test', { WALLET_PREPARED_STORE: 'dynamo', DATABASE_URL })), /must be "redis" or "memory" or "postgres"/);
    assert.throws(() => resolvePreparedStoreMode(envOf('production', { WALLET_PREPARED_STORE: 'pg' })), /must be/);
  });

  test('"database available" means a non-blank DATABASE_URL', () => {
    assert.equal(preparedStoreDatabaseAvailable(envOf('test', { DATABASE_URL })), true);
    for (const v of [undefined, '', '   ']) assert.equal(preparedStoreDatabaseAvailable(envOf('test', { DATABASE_URL: v })), false);
  });

  test('postgres mode without a database client is a startup error, not a silent fallback', () => {
    const env = envOf('production', { DATABASE_URL });
    assert.throws(() => createPreparedMessageStore({ env }), /needs the database client/);
    assert.throws(() => createPreparedTransactionStore({ env }), /needs the database client/);
  });

  test('bad sweep / size env values stop the postgres factory (misconfiguration is loud)', () => {
    assert.throws(() => createPreparedMessageStore({ env: envOf('test', { DATABASE_URL, PREPARED_STORE_SWEEP_INTERVAL_MS: 'soon' }), prisma }), /PREPARED_STORE_SWEEP_INTERVAL_MS/);
    assert.throws(() => createPreparedTransactionStore({ env: envOf('test', { DATABASE_URL, PREPARED_STORE_MAX_PAYLOAD_BYTES: '0' }), prisma }), /PREPARED_STORE_MAX_PAYLOAD_BYTES/);
  });
});
