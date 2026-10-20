import { ServiceUnavailableException } from '@nestjs/common';

/**
 * The tiny slice of the ioredis client the prepared stores use. A real `ioredis` instance satisfies it;
 * tests inject an in-memory fake through the store constructors so no Redis is needed.
 */
export interface RedisLike {
  /** `SET key value PX ttlMs` (atomic set + expiry; overwrites). */
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  /** Optional graceful close, invoked on module shutdown when present. */
  quit?(): Promise<unknown>;
}

/** Namespace for every key the prepared stores write. */
export const PREPARED_KEY_PREFIX = 'helix:wallet:prepared:';

/** Upper bound for any single TTL we will set, regardless of the entry's own expiry. */
export const MAX_PREPARED_TTL_MS = 24 * 60 * 60_000;

/**
 * Thrown when the shared store cannot be reached or misbehaves. Callers must treat this as
 * "no prepared entry is available" and refuse (fail closed). The message is generic on purpose:
 * connection details and stored values must never leak to API clients or logs.
 */
export class PreparedStoreUnavailableError extends ServiceUnavailableException {
  constructor(operation: string, cause?: unknown) {
    super(`Prepared transaction store is unavailable (${operation}); try again shortly`);
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** TTL in whole ms for an absolute expiry, or null when the entry is already expired (do not store it). */
export function ttlUntil(expiresAtMs: number, nowMs: number): number | null {
  if (!Number.isFinite(expiresAtMs)) return null;
  const remaining = Math.ceil(expiresAtMs - nowMs);
  if (remaining < 1) return null;
  return Math.min(remaining, MAX_PREPARED_TTL_MS);
}
