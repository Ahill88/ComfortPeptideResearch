import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { InMemoryPreparedMessageStore } from '../../checkout/prepared-message-store';
import { InMemoryPreparedTransactionStore } from '../../transfers/prepared-transaction.store';
import { NODE_ENV_MATRIX, envOf, isAllowed, label } from '../../../config/__tests__/node-env-matrix';
import { createPreparedMessageStore, createPreparedTransactionStore, resolvePreparedStoreMode } from '../prepared-store.factory';
import { RedisPreparedMessageStore, RedisPreparedTransactionStore } from '../redis-prepared-stores';
import { FakeRedis } from './fake-redis';

describe('prepared store: NODE_ENV matrix', () => {
  for (const value of NODE_ENV_MATRIX) {
    test(`NODE_ENV=${label(value)}: ${isAllowed(value) ? 'in-memory store honored (and the default)' : 'in-memory store refused, redis is the default'}`, () => {
      const redis = new FakeRedis({ now: 0 });
      if (isAllowed(value)) {
        for (const WALLET_PREPARED_STORE of [undefined, 'memory', ' MEMORY ']) {
          const env = envOf(value, { WALLET_PREPARED_STORE });
          assert.equal(resolvePreparedStoreMode(env), 'memory');
          assert.ok(createPreparedTransactionStore({ env }) instanceof InMemoryPreparedTransactionStore);
          assert.ok(createPreparedMessageStore({ env }) instanceof InMemoryPreparedMessageStore);
        }
      } else {
        for (const WALLET_PREPARED_STORE of ['memory', 'MEMORY', ' memory ']) {
          const env = envOf(value, { WALLET_PREPARED_STORE });
          assert.throws(() => resolvePreparedStoreMode(env), /only allowed when NODE_ENV is exactly "development" or "test"/);
          assert.throws(() => createPreparedTransactionStore({ env, redis }), /memory/);
          assert.throws(() => createPreparedMessageStore({ env, redis }), /memory/);
        }
        for (const WALLET_PREPARED_STORE of [undefined, '', 'redis']) {
          const env = envOf(value, { WALLET_PREPARED_STORE });
          assert.equal(resolvePreparedStoreMode(env), 'redis');
          assert.ok(createPreparedTransactionStore({ env, redis }) instanceof RedisPreparedTransactionStore);
          assert.ok(createPreparedMessageStore({ env, redis }) instanceof RedisPreparedMessageStore);
        }
      }
    });
  }
});
