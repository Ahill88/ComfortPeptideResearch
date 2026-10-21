import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { ConsoleLogger, Logger } from '@nestjs/common';
import type { PreparedMessage } from '../../checkout/ports';
import {
  PREPARED_STORE_DEFAULT_MAX_PAYLOAD_BYTES,
  PREPARED_STORE_DEFAULT_SWEEP_INTERVAL_MS,
  PreparedPayloadTooLargeError,
  PostgresPreparedMessageStore,
  PostgresPreparedTransactionStore,
  parseMaxPayloadBytes,
  parseSweepIntervalMs,
  type PreparedStoreDb,
} from '../postgres-prepared-stores';
import { PreparedStoreUnavailableError } from '../redis-like';

/** Records every statement; no database. Real SQL behaviour is covered by postgres-prepared-stores.integration.test.ts. */
class RecordingDb implements PreparedStoreDb {
  calls: Array<{ sql: string; values: unknown[] }> = [];
  queryResult: unknown[] = [];
  execResult = 0;
  failWith: Error | null = null;
  private record(strings: TemplateStringsArray, values: unknown[]) {
    if (this.failWith) throw this.failWith;
    this.calls.push({ sql: strings.join('?'), values });
  }
  $queryRaw = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    this.record(strings, values);
    return this.queryResult;
  }) as unknown as PreparedStoreDb['$queryRaw'];
  $executeRaw = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    this.record(strings, values);
    return this.execResult;
  }) as unknown as PreparedStoreDb['$executeRaw'];
}

const T0 = 1_800_000_000_000;
const message = (over: Partial<PreparedMessage> = {}): PreparedMessage => ({
  reference: 'ref-1',
  orderId: 'order-1',
  customerId: 'cust-1',
  payer: 'PayerPubkey1111111111111111111111111111111',
  merchant: 'MerchantPubkey11111111111111111111111111',
  mint: 'MintPubkey11111111111111111111111111111111',
  amountAtomic: 1_000_000n,
  referenceKey: 'RefKey111111111111111111111111111111111111',
  feeLamports: 5_000n,
  messageBytes: new Uint8Array([1, 2, 3, 4]),
  createdAtMs: T0,
  ...over,
});
const env = (o: Record<string, string | undefined>) => o as NodeJS.ProcessEnv;

describe('env parsing', () => {
  test('PREPARED_STORE_SWEEP_INTERVAL_MS: default 300000, 0 disables, garbage throws', () => {
    assert.equal(PREPARED_STORE_DEFAULT_SWEEP_INTERVAL_MS, 300_000);
    assert.equal(parseSweepIntervalMs(env({})), 300_000);
    assert.equal(parseSweepIntervalMs(env({ PREPARED_STORE_SWEEP_INTERVAL_MS: '  ' })), 300_000);
    assert.equal(parseSweepIntervalMs(env({ PREPARED_STORE_SWEEP_INTERVAL_MS: '0' })), 0);
    assert.equal(parseSweepIntervalMs(env({ PREPARED_STORE_SWEEP_INTERVAL_MS: '1500' })), 1500);
    for (const bad of ['-1', '1.5', 'abc', '1e3', '0x10']) {
      assert.throws(() => parseSweepIntervalMs(env({ PREPARED_STORE_SWEEP_INTERVAL_MS: bad })), /PREPARED_STORE_SWEEP_INTERVAL_MS/);
    }
  });

  test('PREPARED_STORE_MAX_PAYLOAD_BYTES: default 8192, must be a positive integer', () => {
    assert.equal(parseMaxPayloadBytes(env({})), PREPARED_STORE_DEFAULT_MAX_PAYLOAD_BYTES);
    assert.equal(parseMaxPayloadBytes(env({ PREPARED_STORE_MAX_PAYLOAD_BYTES: '4096' })), 4096);
    for (const bad of ['0', '-5', 'x', '2.5']) assert.throws(() => parseMaxPayloadBytes(env({ PREPARED_STORE_MAX_PAYLOAD_BYTES: bad })), /PREPARED_STORE_MAX_PAYLOAD_BYTES/);
  });
});

describe('size cap', () => {
  test('refused before any SQL runs; the error carries sizes only, never the payload', async () => {
    const db = new RecordingDb();
    const store = new PostgresPreparedMessageStore(db, { now: () => T0, sweepIntervalMs: 0, maxPayloadBytes: 300 });
    await assert.rejects(store.put(message({ messageBytes: new Uint8Array(500).fill(9) })), (e: unknown) => {
      assert.ok(e instanceof PreparedPayloadTooLargeError);
      assert.match((e as Error).message, /bytes, over the 300 byte limit/);
      assert.doesNotMatch((e as Error).message, /PayerPubkey|CQkJ/);
      return true;
    });
    assert.equal(db.calls.length, 0);
  });

  test('the default cap leaves room for a real compiled message (<= 1232 bytes) and still stops a runaway one', async () => {
    const db = new RecordingDb();
    const store = new PostgresPreparedMessageStore(db, { now: () => T0, sweepIntervalMs: 0 });
    await store.put(message({ messageBytes: new Uint8Array(1_232).fill(1) }));
    assert.equal(db.calls.length, 1);
    await assert.rejects(store.put(message({ messageBytes: new Uint8Array(20_000).fill(1) })), PreparedPayloadTooLargeError);
    assert.equal(db.calls.length, 1);
  });
});

describe('keys are namespaced per kind and always filtered by kind', () => {
  test('message store uses msg:<reference>; transaction store uses tx:<id>', async () => {
    const db = new RecordingDb();
    const m = new PostgresPreparedMessageStore(db, { now: () => T0, sweepIntervalMs: 0 });
    const t = new PostgresPreparedTransactionStore(db, { now: () => T0, sweepIntervalMs: 0 });
    await m.put(message());
    await m.get('abc');
    await m.delete('abc');
    await m.take('abc');
    await t.get('abc');
    await t.delete('abc');
    await t.take('abc');
    await t.save({ transactionId: 'abc', customerId: 'c', messageBytes: new Uint8Array([1]), expiresAt: new Date(T0 + 60_000) });
    const mCalls = db.calls.slice(0, 4);
    const tCalls = db.calls.slice(4);
    for (const c of mCalls) assert.ok(c.values.includes('msg:ref-1') || c.values.includes('msg:abc'), c.sql);
    for (const c of tCalls) assert.ok(c.values.includes('tx:abc'), c.sql);
    for (const c of db.calls) {
      assert.match(c.sql, /"kind" = \?|"kind", /, `every statement is kind-scoped: ${c.sql}`);
    }
  });

  test('take is a single DELETE ... RETURNING statement (atomic get-and-delete)', async () => {
    const db = new RecordingDb();
    await new PostgresPreparedMessageStore(db, { sweepIntervalMs: 0 }).take('r');
    assert.equal(db.calls.length, 1);
    assert.match(db.calls[0].sql, /DELETE FROM "PreparedMessage"[\s\S]*RETURNING/);
  });

  test('empty or oversized ids never reach the database', async () => {
    const db = new RecordingDb();
    const m = new PostgresPreparedMessageStore(db, { sweepIntervalMs: 0 });
    assert.equal(await m.get(''), null);
    assert.equal(await m.take('x'.repeat(300)), null);
    await m.delete('');
    await assert.rejects(m.put(message({ reference: '' })), TypeError);
    assert.equal(db.calls.length, 0);
  });
});

describe('failures', () => {
  test('every operation maps a database error to the generic unavailable error (no detail leaks)', async () => {
    const db = new RecordingDb();
    db.failWith = new Error('connect ECONNREFUSED postgresql://user:hunter2@db.internal:5432/x');
    const m = new PostgresPreparedMessageStore(db, { now: () => T0, sweepIntervalMs: 0 });
    const t = new PostgresPreparedTransactionStore(db, { now: () => T0, sweepIntervalMs: 0 });
    const ops = [
      () => m.put(message()), () => m.get('a'), () => m.delete('a'), () => m.take('a'), () => m.sweepExpired(),
      () => t.get('a'), () => t.delete('a'), () => t.take('a'),
      () => t.save({ transactionId: 'a', customerId: 'c', messageBytes: new Uint8Array([1]), expiresAt: new Date(T0 + 60_000) }),
    ];
    for (const op of ops) {
      await assert.rejects(op(), (e: unknown) => {
        assert.ok(e instanceof PreparedStoreUnavailableError);
        assert.doesNotMatch(JSON.stringify((e as PreparedStoreUnavailableError).getResponse()), /hunter2|db\.internal|ECONNREFUSED/);
        return true;
      });
    }
  });

  test('an unreadable row is logged without its contents and reads as absent', async () => {
    const lines: string[] = [];
    class Capture extends ConsoleLogger {
      override warn(message: unknown) { lines.push(String(message)); }
      override log(message: unknown) { lines.push(String(message)); }
      override error(message: unknown) { lines.push(String(message)); }
    }
    Logger.overrideLogger(new Capture());
    try {
      const db = new RecordingDb();
      db.queryResult = [{ payload: { v: 1, kind: 'msg', reference: 'ref-1', payer: 'SENSITIVE-PAYER-VALUE' }, expiresAtMs: T0 + 60_000 }];
      const store = new PostgresPreparedMessageStore(db, { now: () => T0, sweepIntervalMs: 0 });
      assert.equal(await store.get('ref-1'), null);
      assert.ok(lines.length > 0);
      assert.doesNotMatch(lines.join('\n'), /SENSITIVE-PAYER-VALUE|ref-1/);
    } finally {
      Logger.overrideLogger(new ConsoleLogger());
    }
  });
});

describe('sweep scheduling', () => {
  test('PREPARED_STORE_SWEEP_INTERVAL_MS=0 never schedules a timer or touches the database', async () => {
    const db = new RecordingDb();
    const store = new PostgresPreparedMessageStore(db, { sweepIntervalMs: 0 });
    store.onModuleInit();
    await new Promise((r) => setTimeout(r, 60));
    store.onModuleDestroy();
    assert.equal(db.calls.length, 0);
  });

  test('a positive interval sweeps repeatedly, never overlaps itself, survives errors, and stops on destroy', async () => {
    const db = new RecordingDb();
    let inFlight = 0;
    let maxInFlight = 0;
    let runs = 0;
    db.$executeRaw = (async () => {
      runs += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30)); // slower than the interval
      inFlight -= 1;
      if (runs === 2) throw new Error('boom postgresql://user:hunter2@host/db');
      return 0;
    }) as unknown as PreparedStoreDb['$executeRaw'];
    const store = new PostgresPreparedMessageStore(db, { sweepIntervalMs: 10 });
    store.onModuleInit();
    store.onModuleInit(); // idempotent
    await new Promise((r) => setTimeout(r, 200));
    store.onModuleDestroy();
    const after = runs;
    assert.ok(after >= 3, `expected several sweeps, saw ${after}`);
    assert.equal(maxInFlight, 1);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(runs, after, 'no sweeps after destroy');
  });

  test('sweepExpired loops until a short batch and sums the deletions', async () => {
    const db = new RecordingDb();
    const results = [500, 500, 37];
    db.$executeRaw = (async () => results.shift() ?? 0) as unknown as PreparedStoreDb['$executeRaw'];
    const store = new PostgresPreparedMessageStore(db, { sweepIntervalMs: 0 });
    assert.equal(await store.sweepExpired(), 1_037);
  });
});
