import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { InMemoryPreparedMessageStore } from '../../checkout/prepared-message-store';
import { InMemoryPreparedTransactionStore } from '../../transfers/prepared-transaction.store';
import {
  createPreparedMessageStore,
  createPreparedStoreRedis,
  createPreparedTransactionStore,
  resolvePreparedStoreMode,
} from '../prepared-store.factory';
import { RedisPreparedMessageStore, RedisPreparedTransactionStore } from '../redis-prepared-stores';
import { FakeRedis } from './fake-redis';

const env = (o: Record<string, string | undefined>) => o as NodeJS.ProcessEnv;

describe('resolvePreparedStoreMode', () => {
  test('defaults to memory in test and development only', () => {
    for (const NODE_ENV of ['test', 'development']) {
      assert.equal(resolvePreparedStoreMode(env({ NODE_ENV })), 'memory');
    }
  });

  test('defaults to redis in production', () => {
    assert.equal(resolvePreparedStoreMode(env({ NODE_ENV: 'production' })), 'redis');
    assert.equal(resolvePreparedStoreMode(env({ NODE_ENV: 'production', WALLET_PREPARED_STORE: '  ' })), 'redis');
  });

  test('production refuses memory (any casing/whitespace) by throwing', () => {
    for (const v of ['memory', 'MEMORY', ' memory ']) {
      assert.throws(() => resolvePreparedStoreMode(env({ NODE_ENV: 'production', WALLET_PREPARED_STORE: v })), /only allowed when NODE_ENV is exactly "development" or "test"/);
    }
  });

  test('explicit values are honoured outside production', () => {
    assert.equal(resolvePreparedStoreMode(env({ NODE_ENV: 'development', WALLET_PREPARED_STORE: 'redis' })), 'redis');
    assert.equal(resolvePreparedStoreMode(env({ NODE_ENV: 'test', WALLET_PREPARED_STORE: 'memory' })), 'memory');
    assert.equal(resolvePreparedStoreMode(env({ NODE_ENV: 'production', WALLET_PREPARED_STORE: 'redis' })), 'redis');
  });

  test('unknown values throw instead of silently choosing', () => {
    assert.throws(() => resolvePreparedStoreMode(env({ NODE_ENV: 'test', WALLET_PREPARED_STORE: 'dynamo' })), /must be "redis" or "memory"/);
  });
});

describe('store factories', () => {
  test('memory in test/dev, redis when selected (client injected, no connection made)', () => {
    assert.ok(createPreparedTransactionStore({ env: env({ NODE_ENV: 'test' }) }) instanceof InMemoryPreparedTransactionStore);
    assert.ok(createPreparedMessageStore({ env: env({ NODE_ENV: 'development' }) }) instanceof InMemoryPreparedMessageStore);
    const redis = new FakeRedis({ now: 0 });
    assert.ok(createPreparedTransactionStore({ env: env({ WALLET_PREPARED_STORE: 'redis' }), redis }) instanceof RedisPreparedTransactionStore);
    assert.ok(createPreparedMessageStore({ env: env({ NODE_ENV: 'production' }), redis }) instanceof RedisPreparedMessageStore);
  });

  test('production + memory throws from both factories (startup failure)', () => {
    const e = env({ NODE_ENV: 'production', WALLET_PREPARED_STORE: 'memory' });
    assert.throws(() => createPreparedTransactionStore({ env: e }), /memory/);
    assert.throws(() => createPreparedMessageStore({ env: e }), /memory/);
  });

  test('the real client is lazy: creating it opens no connection and prefers REDIS_URL', async () => {
    const a = createPreparedStoreRedis(env({ REDIS_URL: 'redis://127.0.0.1:1' })) as unknown as { status: string; options: { host: string; port: number }; disconnect(): void };
    const b = createPreparedStoreRedis(env({ REDIS_HOST: 'cache.internal', REDIS_PORT: '6390' })) as unknown as typeof a;
    const c = createPreparedStoreRedis(env({})) as unknown as typeof a;
    try {
      assert.equal(a.status, 'wait'); // lazyConnect: nothing dialled yet
      assert.equal(a.options.port, 1);
      assert.equal(b.options.host, 'cache.internal');
      assert.equal(b.options.port, 6390);
      assert.equal(c.options.host, 'localhost');
      assert.equal(c.options.port, 6379);
    } finally {
      a.disconnect();
      b.disconnect();
      c.disconnect();
    }
  });
});
