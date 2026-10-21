import Redis from 'ioredis';
import { describeNodeEnv, isProductionLikeRuntime } from '../../config/runtime';
import { InMemoryPreparedMessageStore } from '../checkout/prepared-message-store';
import type { PreparedMessageStore } from '../checkout/ports';
import { InMemoryPreparedTransactionStore, type PreparedTransactionStore } from '../transfers/prepared-transaction.store';
import { PostgresPreparedMessageStore, PostgresPreparedTransactionStore, parseMaxPayloadBytes, parseSweepIntervalMs, type PreparedStoreDb } from './postgres-prepared-stores';
import { RedisPreparedMessageStore, RedisPreparedTransactionStore } from './redis-prepared-stores';
import type { RedisLike } from './redis-like';

export type PreparedStoreMode = 'postgres' | 'redis' | 'memory';

/** A database is "available" when DATABASE_URL is set (the API cannot run without one). */
export function preparedStoreDatabaseAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.DATABASE_URL?.trim());
}

/**
 * WALLET_PREPARED_STORE=postgres|redis|memory.
 *  - an explicit value always wins, except that 'memory' is refused (throws) in every production-like runtime
 *    (everything except exactly NODE_ENV=development|test, so also unset, "staging", "prod", "Production",
 *    "production "): it loses state on restart and is not shared between API instances, which makes every submit fail.
 *  - unset: postgres when a database is available (DATABASE_URL), so prepared messages survive restarts and are shared
 *    by every instance; otherwise the legacy defaults: redis when production-like, memory in development/test.
 *    In development/test the in-memory store is therefore only used when requested (or when there is no database).
 * Any other value throws rather than silently picking one.
 */
export function resolvePreparedStoreMode(env: NodeJS.ProcessEnv = process.env): PreparedStoreMode {
  const productionLike = isProductionLikeRuntime(env);
  const raw = env.WALLET_PREPARED_STORE?.trim().toLowerCase() || undefined;
  if (raw && raw !== 'redis' && raw !== 'memory' && raw !== 'postgres') {
    throw new Error(`WALLET_PREPARED_STORE must be "redis" or "memory" or "postgres" (got "${raw}")`);
  }
  if (productionLike && raw === 'memory') {
    throw new Error(`WALLET_PREPARED_STORE=memory is only allowed when NODE_ENV is exactly "development" or "test" (NODE_ENV is ${describeNodeEnv(env)}, which is production-like): the in-memory prepared store is lost on restart and not shared across API instances. Use "postgres" or "redis".`);
  }
  if (raw) return raw as PreparedStoreMode;
  if (preparedStoreDatabaseAvailable(env)) return 'postgres';
  return productionLike ? 'redis' : 'memory';
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
  /** Database handle for the postgres mode (PrismaService). Required only when that mode is selected. */
  prisma?: PreparedStoreDb;
  /** Test seam for the postgres stores' clock. */
  now?: () => number;
}

function postgresOptions(deps: PreparedStoreFactoryDeps, env: NodeJS.ProcessEnv) {
  return { now: deps.now, sweepIntervalMs: parseSweepIntervalMs(env), maxPayloadBytes: parseMaxPayloadBytes(env) };
}

function requirePrisma(deps: PreparedStoreFactoryDeps): PreparedStoreDb {
  if (!deps.prisma) throw new Error('The postgres prepared store needs the database client (PrismaService) but none was provided');
  return deps.prisma;
}

export function createPreparedTransactionStore(deps: PreparedStoreFactoryDeps = {}): PreparedTransactionStore {
  const env = deps.env ?? process.env;
  const mode = resolvePreparedStoreMode(env);
  if (mode === 'postgres') return new PostgresPreparedTransactionStore(requirePrisma(deps), postgresOptions(deps, env));
  return mode === 'redis'
    ? new RedisPreparedTransactionStore(deps.redis ?? createPreparedStoreRedis(env))
    : new InMemoryPreparedTransactionStore();
}

export function createPreparedMessageStore(deps: PreparedStoreFactoryDeps = {}): PreparedMessageStore {
  const env = deps.env ?? process.env;
  const mode = resolvePreparedStoreMode(env);
  if (mode === 'postgres') return new PostgresPreparedMessageStore(requirePrisma(deps), postgresOptions(deps, env));
  return mode === 'redis'
    ? new RedisPreparedMessageStore(deps.redis ?? createPreparedStoreRedis(env))
    : new InMemoryPreparedMessageStore();
}
