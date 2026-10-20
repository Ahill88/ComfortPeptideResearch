import Redis from 'ioredis';
import { describeNodeEnv, isProductionLikeRuntime } from '../../config/runtime';
import { InMemoryPreparedMessageStore } from '../checkout/prepared-message-store';
import type { PreparedMessageStore } from '../checkout/ports';
import { InMemoryPreparedTransactionStore, type PreparedTransactionStore } from '../transfers/prepared-transaction.store';
import { RedisPreparedMessageStore, RedisPreparedTransactionStore } from './redis-prepared-stores';
import type { RedisLike } from './redis-like';

export type PreparedStoreMode = 'redis' | 'memory';

/**
 * WALLET_PREPARED_STORE=redis|memory.
 *  - production-like (everything except exactly NODE_ENV=development|test, so also unset, "staging",
 *    "prod", "Production", "production "): defaults to redis; 'memory' is refused (throws) because it
 *    loses state on restart and is not shared between API instances, which makes every submit fail with 409.
 *  - development and test only: defaults to memory.
 * Any other value throws rather than silently picking one.
 */
export function resolvePreparedStoreMode(env: NodeJS.ProcessEnv = process.env): PreparedStoreMode {
  const productionLike = isProductionLikeRuntime(env);
  const raw = env.WALLET_PREPARED_STORE?.trim().toLowerCase() || undefined;
  if (raw && raw !== 'redis' && raw !== 'memory') {
    throw new Error(`WALLET_PREPARED_STORE must be "redis" or "memory" (got "${raw}")`);
  }
  if (productionLike && raw === 'memory') {
    throw new Error(`WALLET_PREPARED_STORE=memory is only allowed when NODE_ENV is exactly "development" or "test" (NODE_ENV is ${describeNodeEnv(env)}, which is production-like): the in-memory prepared store is lost on restart and not shared across API instances. Use "redis".`);
  }
  return (raw as PreparedStoreMode | undefined) ?? (productionLike ? 'redis' : 'memory');
}

/**
 * Lazy ioredis client: nothing connects until the first command. REDIS_URL wins; otherwise
 * REDIS_HOST (default localhost) / REDIS_PORT (default 6379), the same defaults as BullModule in app.module.ts.
 */
export function createPreparedStoreRedis(env: NodeJS.ProcessEnv = process.env): RedisLike {
  const options = {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    retryStrategy: (attempt: number) => Math.min(attempt * 200, 2_000),
  };
  const url = env.REDIS_URL?.trim();
  const client = url
    ? new Redis(url, options)
    : new Redis({ host: env.REDIS_HOST ?? 'localhost', port: Number(env.REDIS_PORT ?? 6379), ...options });
  // Without a listener ioredis would raise unhandled 'error' events; failures surface per call instead.
  client.on('error', () => undefined);
  return client;
}

export interface PreparedStoreFactoryDeps {
  env?: NodeJS.ProcessEnv;
  /** Test seam: supply the Redis client instead of opening a connection. */
  redis?: RedisLike;
}

export function createPreparedTransactionStore(deps: PreparedStoreFactoryDeps = {}): PreparedTransactionStore {
  const env = deps.env ?? process.env;
  return resolvePreparedStoreMode(env) === 'redis'
    ? new RedisPreparedTransactionStore(deps.redis ?? createPreparedStoreRedis(env))
    : new InMemoryPreparedTransactionStore();
}

export function createPreparedMessageStore(deps: PreparedStoreFactoryDeps = {}): PreparedMessageStore {
  const env = deps.env ?? process.env;
  return resolvePreparedStoreMode(env) === 'redis'
    ? new RedisPreparedMessageStore(deps.redis ?? createPreparedStoreRedis(env))
    : new InMemoryPreparedMessageStore();
}
