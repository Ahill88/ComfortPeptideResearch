import { Injectable } from '@nestjs/common';
import type { PreparedMessage, PreparedMessageStore } from './ports';

/** A prepared message is dropped this long after createdAtMs (also the Redis TTL basis). */
export const PREPARED_MESSAGE_MAX_AGE_MS = 60 * 60_000;
const MAX_AGE_MS = PREPARED_MESSAGE_MAX_AGE_MS;

/**
 * In-memory PreparedMessageStore. NOT durable and NOT shared across processes. Used only for
 * test/development (see stores/prepared-store.factory.ts); production uses RedisPreparedMessageStore
 * and refuses to start with this one.
 */
@Injectable()
export class InMemoryPreparedMessageStore implements PreparedMessageStore {
  private readonly entries = new Map<string, PreparedMessage>();

  async put(entry: PreparedMessage): Promise<void> {
    const now = Date.now();
    for (const [key, value] of this.entries) if (now - value.createdAtMs > MAX_AGE_MS) this.entries.delete(key);
    this.entries.set(entry.reference, entry);
  }

  async get(reference: string): Promise<PreparedMessage | null> {
    return this.entries.get(reference) ?? null;
  }

  async delete(reference: string): Promise<void> {
    this.entries.delete(reference);
  }
}
