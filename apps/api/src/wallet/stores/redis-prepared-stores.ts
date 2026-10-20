import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { PREPARED_MESSAGE_MAX_AGE_MS } from '../checkout/prepared-message-store';
import type { PreparedMessage, PreparedMessageStore } from '../checkout/ports';
import type { PreparedTransactionRecord, PreparedTransactionStore } from '../transfers/prepared-transaction.store';
import {
  decodePreparedMessage,
  decodeTransactionRecord,
  encodePreparedMessage,
  encodeTransactionRecord,
} from './codec';
import { PREPARED_KEY_PREFIX, PreparedStoreUnavailableError, ttlUntil, type RedisLike } from './redis-like';

export const TX_KEY_PREFIX = `${PREPARED_KEY_PREFIX}tx:`;
export const MESSAGE_KEY_PREFIX = `${PREPARED_KEY_PREFIX}msg:`;

type Clock = () => number;

/** Shared plumbing: every Redis call maps any failure to PreparedStoreUnavailableError (fail closed). */
abstract class RedisPreparedBase implements OnModuleDestroy {
  protected readonly logger = new Logger(this.constructor.name);

  protected constructor(protected readonly redis: RedisLike, protected readonly now: Clock) {}

  protected async call<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw new PreparedStoreUnavailableError(operation, error);
    }
  }

  /** Never log the value (it holds payment details); the key is an opaque id. */
  protected corrupt(key: string): null {
    this.logger.warn(`Ignoring unreadable prepared entry at ${key}`);
    return null;
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit?.();
    } catch {
      /* closing a dead connection is not an error worth surfacing */
    }
  }
}

/**
 * Redis-backed PreparedTransactionStore. `save` is one atomic `SET key value PX ttl` that overwrites,
 * matching the in-memory store (Map.set); the TTL is the record's own expiresAt, so nothing is
 * persisted past expiry. An already-expired record is not stored (and clears any older value).
 */
export class RedisPreparedTransactionStore extends RedisPreparedBase implements PreparedTransactionStore {
  constructor(redis: RedisLike, now: Clock = Date.now) {
    super(redis, now);
  }

  async save(record: PreparedTransactionRecord): Promise<void> {
    const key = TX_KEY_PREFIX + record.transactionId;
    const payload = encodeTransactionRecord(record);
    const ttl = ttlUntil(record.expiresAt.getTime(), this.now());
    if (ttl === null) {
      await this.call('save', () => this.redis.del(key));
      return;
    }
    await this.call('save', () => this.redis.set(key, payload, 'PX', ttl));
  }

  async get(transactionId: string): Promise<PreparedTransactionRecord | null> {
    const key = TX_KEY_PREFIX + transactionId;
    const raw = await this.call('get', () => this.redis.get(key));
    if (raw === null || raw === undefined) return null;
    const record = decodeTransactionRecord(raw);
    // The embedded id must match the key we asked for; otherwise the value was moved/forged.
    if (!record || record.transactionId !== transactionId) return this.corrupt(key);
    if (record.expiresAt.getTime() <= this.now()) return null;
    return record;
  }

  async delete(transactionId: string): Promise<void> {
    await this.call('delete', () => this.redis.del(TX_KEY_PREFIX + transactionId));
  }
}

/**
 * Redis-backed PreparedMessageStore. Entries live PREPARED_MESSAGE_MAX_AGE_MS from createdAtMs
 * (the same horizon the in-memory store prunes at). `put` overwrites by reference, as the in-memory
 * store does: re-prepare with a fresh blockhash intentionally replaces the earlier message.
 */
export class RedisPreparedMessageStore extends RedisPreparedBase implements PreparedMessageStore {
  constructor(redis: RedisLike, now: Clock = Date.now) {
    super(redis, now);
  }

  async put(entry: PreparedMessage): Promise<void> {
    const key = MESSAGE_KEY_PREFIX + entry.reference;
    const payload = encodePreparedMessage(entry);
    const ttl = ttlUntil(entry.createdAtMs + PREPARED_MESSAGE_MAX_AGE_MS, this.now());
    if (ttl === null) {
      await this.call('put', () => this.redis.del(key));
      return;
    }
    await this.call('put', () => this.redis.set(key, payload, 'PX', ttl));
  }

  async get(reference: string): Promise<PreparedMessage | null> {
    const key = MESSAGE_KEY_PREFIX + reference;
    const raw = await this.call('get', () => this.redis.get(key));
    if (raw === null || raw === undefined) return null;
    const entry = decodePreparedMessage(raw);
    if (!entry || entry.reference !== reference) return this.corrupt(key);
    if (entry.createdAtMs + PREPARED_MESSAGE_MAX_AGE_MS <= this.now()) return null;
    return entry;
  }

  async delete(reference: string): Promise<void> {
    await this.call('delete', () => this.redis.del(MESSAGE_KEY_PREFIX + reference));
  }
}
