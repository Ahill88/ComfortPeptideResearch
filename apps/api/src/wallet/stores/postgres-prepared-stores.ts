import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma.service';
import { PREPARED_MESSAGE_MAX_AGE_MS } from '../checkout/prepared-message-store';
import type { PreparedMessage, PreparedMessageStore } from '../checkout/ports';
import type { PreparedTransactionRecord, PreparedTransactionStore } from '../transfers/prepared-transaction.store';
import {
  decodePreparedMessage,
  decodeTransactionRecord,
  encodePreparedMessage,
  encodeTransactionRecord,
} from './codec';
import { PreparedStoreUnavailableError, ttlUntil } from './redis-like';

/** Default for PREPARED_STORE_SWEEP_INTERVAL_MS (0 disables the sweep). */
export const PREPARED_STORE_DEFAULT_SWEEP_INTERVAL_MS = 300_000;
/** Default cap on one encoded payload. A compiled legacy message is at most ~1.2 KB, so this is generous. */
export const PREPARED_STORE_DEFAULT_MAX_PAYLOAD_BYTES = 8 * 1024;
/** Rows removed per DELETE statement during a sweep. */
export const PREPARED_STORE_SWEEP_BATCH = 500;
const MAX_SWEEP_BATCHES = 200;
const MAX_KEY_LENGTH = 256;
const MAX_TIMER_MS = 2_147_483_647;

export const PREPARED_TX_KIND = 'tx';
export const PREPARED_MESSAGE_KIND = 'msg';
export const PREPARED_PG_TX_KEY_PREFIX = `${PREPARED_TX_KIND}:`;
export const PREPARED_PG_MESSAGE_KEY_PREFIX = `${PREPARED_MESSAGE_KIND}:`;

/** The encoded entry exceeds the configured cap. The message never contains the payload. */
export class PreparedPayloadTooLargeError extends Error {
  constructor(readonly size: number, readonly limit: number) {
    super(`Prepared entry is ${size} bytes, over the ${limit} byte limit`);
    this.name = 'PreparedPayloadTooLargeError';
  }
}

function strictNonNegativeInt(raw: string | undefined, name: string, fallback: number, min: number): number {
  const text = raw?.trim();
  if (!text) return fallback;
  if (!/^\d{1,15}$/.test(text) || Number(text) < min) {
    throw new Error(`${name} must be an integer >= ${min}${min === 0 ? ' (0 disables)' : ''}`);
  }
  return Number(text);
}

/** PREPARED_STORE_SWEEP_INTERVAL_MS: unset => 300000, 0 => disabled, anything else not a non-negative integer throws. */
export function parseSweepIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return strictNonNegativeInt(env.PREPARED_STORE_SWEEP_INTERVAL_MS, 'PREPARED_STORE_SWEEP_INTERVAL_MS', PREPARED_STORE_DEFAULT_SWEEP_INTERVAL_MS, 0);
}

/** PREPARED_STORE_MAX_PAYLOAD_BYTES: unset => 8192; must be a positive integer. */
export function parseMaxPayloadBytes(env: NodeJS.ProcessEnv = process.env): number {
  return strictNonNegativeInt(env.PREPARED_STORE_MAX_PAYLOAD_BYTES, 'PREPARED_STORE_MAX_PAYLOAD_BYTES', PREPARED_STORE_DEFAULT_MAX_PAYLOAD_BYTES, 1);
}

export interface PostgresPreparedStoreOptions {
  now?: () => number;
  /** 0 disables the background sweep; `sweepExpired()` can still be called. */
  sweepIntervalMs?: number;
  maxPayloadBytes?: number;
}

/** The slice of PrismaService the stores use (raw SQL only, so the conditional DELETE ... RETURNING is one statement). */
export type PreparedStoreDb = Pick<PrismaService, '$queryRaw' | '$executeRaw'>;

interface Row {
  payload: unknown;
  expiresAtMs: number;
}

/**
 * Epoch milliseconds -> the `timestamp(3)` (UTC wall clock) the column holds. Date parameters are NOT used for the raw
 * statements: the driver would send them as timestamptz and Postgres would cast them with the session TimeZone, shifting
 * every value by the server's UTC offset. This expression is the same under any session TimeZone.
 */
const utcTimestamp = (ms: number) => Prisma.sql`(to_timestamp(${ms}::double precision / 1000.0) AT TIME ZONE 'UTC')`;

/**
 * Shared Postgres plumbing over the PreparedMessage table (key, kind, payload jsonb, expiresAt).
 *  - keys are `<kind>:<id>` and every query also filters on `kind`, so the two stores can never read each other's rows;
 *  - the payload is the codec's JSON document (bytes as base64, bigint as decimal string), so values round-trip exactly;
 *  - TTL is enforced on read (`expiresAt > now`) and by a batched sweep that is safe with several instances running it
 *    (FOR UPDATE SKIP LOCKED, and the expiry predicate is repeated on the DELETE);
 *  - any database failure becomes PreparedStoreUnavailableError (fail closed, generic text); payloads are never logged.
 */
abstract class PostgresPreparedBase<T> implements OnModuleInit, OnModuleDestroy {
  protected readonly logger = new Logger(this.constructor.name);
  protected readonly now: () => number;
  private readonly sweepIntervalMs: number;
  private readonly maxPayloadBytes: number;
  private timer: NodeJS.Timeout | undefined;
  private sweeping = false;

  protected constructor(
    protected readonly db: PreparedStoreDb,
    private readonly kind: string,
    options: PostgresPreparedStoreOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.sweepIntervalMs = options.sweepIntervalMs ?? PREPARED_STORE_DEFAULT_SWEEP_INTERVAL_MS;
    this.maxPayloadBytes = options.maxPayloadBytes ?? PREPARED_STORE_DEFAULT_MAX_PAYLOAD_BYTES;
  }

  protected abstract decode(raw: string, id: string): T | null;

  private keyOf(id: string): string {
    return `${this.kind}:${id}`;
  }

  private checkId(id: string): boolean {
    return typeof id === 'string' && id.length > 0 && this.keyOf(id).length <= MAX_KEY_LENGTH;
  }

  protected async call<R>(operation: string, fn: () => Promise<R>): Promise<R> {
    try {
      return await fn();
    } catch (error) {
      throw new PreparedStoreUnavailableError(operation, error);
    }
  }

  /** Never log the value (it holds payment details). */
  private corrupt(): null {
    this.logger.warn(`Ignoring an unreadable prepared ${this.kind} entry`);
    return null;
  }

  protected async write(id: string, encoded: string, expiresAtMs: number): Promise<void> {
    if (!this.checkId(id)) throw new TypeError('prepared entry id must be 1..250 characters');
    const size = Buffer.byteLength(encoded, 'utf8');
    if (size > this.maxPayloadBytes) throw new PreparedPayloadTooLargeError(size, this.maxPayloadBytes);
    const key = this.keyOf(id);
    const now = this.now();
    const ttl = ttlUntil(expiresAtMs, now);
    if (ttl === null) {
      // Already expired: store nothing and clear any older entry, exactly like the Redis store.
      await this.call('save', () => this.db.$executeRaw`DELETE FROM "PreparedMessage" WHERE "key" = ${key} AND "kind" = ${this.kind}`);
      return;
    }
    const expiresAt = utcTimestamp(now + ttl);
    const createdAt = utcTimestamp(now);
    const payload = JSON.stringify(JSON.parse(encoded));
    // One atomic upsert: re-prepare overwrites the earlier entry (Map.set / SET semantics).
    await this.call('save', () => this.db.$executeRaw`
      INSERT INTO "PreparedMessage" ("key", "kind", "payload", "expiresAt", "createdAt")
      VALUES (${key}, ${this.kind}, ${payload}::jsonb, ${expiresAt}, ${createdAt})
      ON CONFLICT ("key") DO UPDATE
      SET "kind" = EXCLUDED."kind", "payload" = EXCLUDED."payload", "expiresAt" = EXCLUDED."expiresAt", "createdAt" = EXCLUDED."createdAt"`);
  }

  protected async read(id: string): Promise<T | null> {
    if (!this.checkId(id)) return null;
    const key = this.keyOf(id);
    const now = utcTimestamp(this.now());
    const rows = await this.call('get', () => this.db.$queryRaw<Row[]>`
      SELECT "payload", (EXTRACT(EPOCH FROM "expiresAt") * 1000)::float8 AS "expiresAtMs" FROM "PreparedMessage"
      WHERE "key" = ${key} AND "kind" = ${this.kind} AND "expiresAt" > ${now}`);
    return rows.length === 0 ? null : this.decodeRow(rows[0], id);
  }

  /**
   * Atomic get-and-delete: a single `DELETE ... RETURNING`, so of any number of concurrent callers (in this or any
   * other instance) exactly one receives the entry. An expired entry is removed and reported as absent.
   */
  protected async consume(id: string): Promise<T | null> {
    if (!this.checkId(id)) return null;
    const key = this.keyOf(id);
    const rows = await this.call('take', () => this.db.$queryRaw<Row[]>`
      DELETE FROM "PreparedMessage" WHERE "key" = ${key} AND "kind" = ${this.kind}
      RETURNING "payload", (EXTRACT(EPOCH FROM "expiresAt") * 1000)::float8 AS "expiresAtMs"`);
    if (rows.length === 0 || rows[0].expiresAtMs <= this.now()) return null;
    return this.decodeRow(rows[0], id);
  }

  private decodeRow(row: Row, id: string): T | null {
    const decoded = this.decode(JSON.stringify(row.payload), id);
    return decoded === null ? this.corrupt() : decoded;
  }

  protected async remove(id: string): Promise<void> {
    if (!this.checkId(id)) return;
    const key = this.keyOf(id);
    await this.call('delete', () => this.db.$executeRaw`DELETE FROM "PreparedMessage" WHERE "key" = ${key} AND "kind" = ${this.kind}`);
  }

  /**
   * Deletes this store's expired rows in batches and returns how many were removed. Only `kind` rows with
   * `expiresAt <= now` are ever touched. Safe to run from several instances at once.
   */
  async sweepExpired(): Promise<number> {
    const now = utcTimestamp(this.now());
    let total = 0;
    for (let batch = 0; batch < MAX_SWEEP_BATCHES; batch++) {
      const deleted = await this.call('sweep', () => this.db.$executeRaw`
        DELETE FROM "PreparedMessage"
        WHERE "key" IN (
          SELECT "key" FROM "PreparedMessage"
          WHERE "kind" = ${this.kind} AND "expiresAt" <= ${now}
          ORDER BY "expiresAt"
          LIMIT ${PREPARED_STORE_SWEEP_BATCH}
          FOR UPDATE SKIP LOCKED)
        AND "kind" = ${this.kind} AND "expiresAt" <= ${now}`);
      total += Number(deleted);
      if (Number(deleted) < PREPARED_STORE_SWEEP_BATCH) break;
    }
    return total;
  }

  onModuleInit(): void {
    if (this.sweepIntervalMs <= 0 || this.timer) return;
    this.timer = setInterval(() => void this.tick(), Math.min(this.sweepIntervalMs, MAX_TIMER_MS));
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    if (this.sweeping) return; // never overlap runs
    this.sweeping = true;
    try {
      const removed = await this.sweepExpired();
      if (removed > 0) this.logger.log(`swept ${removed} expired prepared ${this.kind} entries`);
    } catch {
      this.logger.warn(`sweep of expired prepared ${this.kind} entries failed; will retry`);
    } finally {
      this.sweeping = false;
    }
  }
}

/** Postgres PreparedTransactionStore (transfers). Expiry is the record's own expiresAt (capped at 24h like Redis). */
export class PostgresPreparedTransactionStore extends PostgresPreparedBase<PreparedTransactionRecord> implements PreparedTransactionStore {
  constructor(db: PreparedStoreDb, options: PostgresPreparedStoreOptions = {}) {
    super(db, PREPARED_TX_KIND, options);
  }

  protected decode(raw: string, id: string): PreparedTransactionRecord | null {
    const record = decodeTransactionRecord(raw);
    // The embedded id must match the key we asked for; otherwise the row was moved/forged.
    return record && record.transactionId === id ? record : null;
  }

  async save(record: PreparedTransactionRecord): Promise<void> {
    await this.write(record.transactionId, encodeTransactionRecord(record), record.expiresAt.getTime());
  }

  async get(transactionId: string): Promise<PreparedTransactionRecord | null> {
    const record = await this.read(transactionId);
    return record && record.expiresAt.getTime() > this.now() ? record : null;
  }

  async delete(transactionId: string): Promise<void> {
    await this.remove(transactionId);
  }

  /** Atomic get-and-delete (not part of the PreparedTransactionStore interface; services use get + delete). */
  async take(transactionId: string): Promise<PreparedTransactionRecord | null> {
    const record = await this.consume(transactionId);
    return record && record.expiresAt.getTime() > this.now() ? record : null;
  }
}

/** Postgres PreparedMessageStore (checkout). Entries live PREPARED_MESSAGE_MAX_AGE_MS from createdAtMs. */
export class PostgresPreparedMessageStore extends PostgresPreparedBase<PreparedMessage> implements PreparedMessageStore {
  constructor(db: PreparedStoreDb, options: PostgresPreparedStoreOptions = {}) {
    super(db, PREPARED_MESSAGE_KIND, options);
  }

  protected decode(raw: string, id: string): PreparedMessage | null {
    const entry = decodePreparedMessage(raw);
    return entry && entry.reference === id ? entry : null;
  }

  async put(entry: PreparedMessage): Promise<void> {
    await this.write(entry.reference, encodePreparedMessage(entry), entry.createdAtMs + PREPARED_MESSAGE_MAX_AGE_MS);
  }

  async get(reference: string): Promise<PreparedMessage | null> {
    const entry = await this.read(reference);
    return entry && entry.createdAtMs + PREPARED_MESSAGE_MAX_AGE_MS > this.now() ? entry : null;
  }

  async delete(reference: string): Promise<void> {
    await this.remove(reference);
  }

  /** Atomic get-and-delete (not part of the PreparedMessageStore interface; checkout uses get + delete). */
  async take(reference: string): Promise<PreparedMessage | null> {
    const entry = await this.consume(reference);
    return entry && entry.createdAtMs + PREPARED_MESSAGE_MAX_AGE_MS > this.now() ? entry : null;
  }
}
