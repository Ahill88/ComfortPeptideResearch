import { strict as assert } from 'node:assert';
import { beforeEach, describe, test } from 'node:test';
import { ServiceUnavailableException } from '@nestjs/common';
import type { PreparedMessage } from '../../checkout/ports';
import { PREPARED_MESSAGE_MAX_AGE_MS } from '../../checkout/prepared-message-store';
import { MAX_PREPARED_TTL_MS, PreparedStoreUnavailableError } from '../redis-like';
import { MESSAGE_KEY_PREFIX, RedisPreparedMessageStore, RedisPreparedTransactionStore, TX_KEY_PREFIX } from '../redis-prepared-stores';
import { FakeRedis } from './fake-redis';

const T0 = 1_800_000_000_000;
let clock: { now: number };
let redis: FakeRedis;

beforeEach(() => {
  clock = { now: T0 };
  redis = new FakeRedis(clock);
});

// All 256 byte values: catches any utf8/latin1 mangling.
const allBytes = () => Uint8Array.from({ length: 256 }, (_, i) => i);

describe('RedisPreparedTransactionStore', () => {
  const make = () => new RedisPreparedTransactionStore(redis, () => clock.now);
  const record = () => ({ transactionId: 'tx-1', customerId: 'cust-1', messageBytes: allBytes(), expiresAt: new Date(T0 + 300_000) });

  test('round-trips exact bytes and fields, returning a fresh copy', async () => {
    const store = make();
    const input = record();
    await store.save(input);
    const out = await store.get('tx-1');
    assert.ok(out);
    assert.deepEqual(Array.from(out.messageBytes), Array.from(allBytes()));
    assert.ok(out.messageBytes instanceof Uint8Array);
    assert.equal(out.customerId, 'cust-1');
    assert.equal(out.transactionId, 'tx-1');
    assert.equal(out.expiresAt.getTime(), T0 + 300_000);
    out.messageBytes[0] = 99; // mutating the result must not affect what is stored
    assert.equal((await store.get('tx-1'))!.messageBytes[0], 0);
  });

  test('uses the helix:wallet:prepared: prefix and SET PX with the record own expiry', async () => {
    await make().save(record());
    assert.equal(redis.setCalls.length, 1);
    const call = redis.setCalls[0];
    assert.ok(call.key.startsWith('helix:wallet:prepared:'));
    assert.equal(call.key, `${TX_KEY_PREFIX}tx-1`);
    assert.equal(call.mode, 'PX');
    assert.equal(call.ttlMs, 300_000);
  });

  test('TTL expiry: get returns null once expired (redis side and clock side)', async () => {
    const store = make();
    await store.save(record());
    clock.now = T0 + 299_999;
    assert.ok(await store.get('tx-1'));
    clock.now = T0 + 300_000;
    assert.equal(await store.get('tx-1'), null);
    assert.equal(redis.data.size, 0);
  });

  test('defence in depth: a value Redis failed to expire is still not returned after expiresAt', async () => {
    const store = make();
    await store.save(record());
    redis.data.get(`${TX_KEY_PREFIX}tx-1`)!.expiresAtMs = null; // Redis forgot the TTL
    clock.now = T0 + 300_001;
    assert.equal(await store.get('tx-1'), null);
  });

  test('already-expired records are never persisted and clear any older value', async () => {
    const store = make();
    await store.save(record());
    await store.save({ ...record(), expiresAt: new Date(T0 - 1) });
    assert.equal(redis.data.size, 0);
    assert.equal(redis.setCalls.length, 1);
  });

  test('TTL never exceeds the global ceiling', async () => {
    await make().save({ ...record(), expiresAt: new Date(T0 + 10 * MAX_PREPARED_TTL_MS) });
    assert.equal(redis.setCalls[0].ttlMs, MAX_PREPARED_TTL_MS);
  });

  test('delete removes the record; deleting a missing record is fine; get of missing is null', async () => {
    const store = make();
    await store.save(record());
    await store.delete('tx-1');
    assert.equal(await store.get('tx-1'), null);
    await store.delete('tx-1');
    assert.equal(await store.get('never-saved'), null);
  });

  test('save overwrites (same semantics as the in-memory Map.set)', async () => {
    const store = make();
    await store.save(record());
    await store.save({ ...record(), customerId: 'cust-2', messageBytes: Uint8Array.of(1, 2, 3) });
    const out = await store.get('tx-1');
    assert.equal(out!.customerId, 'cust-2');
    assert.deepEqual(Array.from(out!.messageBytes), [1, 2, 3]);
  });

  test('records are isolated per id', async () => {
    const store = make();
    await store.save(record());
    await store.save({ ...record(), transactionId: 'tx-2', messageBytes: Uint8Array.of(7) });
    assert.deepEqual(Array.from((await store.get('tx-2'))!.messageBytes), [7]);
    assert.equal((await store.get('tx-1'))!.messageBytes.length, 256);
  });

  test('corrupted / foreign / tampered values read as null, never a forged record', async () => {
    const store = make();
    await store.save(record());
    const key = `${TX_KEY_PREFIX}tx-1`;
    const good = JSON.parse(redis.data.get(key)!.value);
    const bad: Array<[string, string]> = [
      ['not json', '{{{nope'],
      ['json null', 'null'],
      ['array', '[]'],
      ['wrong version', JSON.stringify({ ...good, v: 2 })],
      ['wrong kind', JSON.stringify({ ...good, kind: 'msg' })],
      ['non-base64 bytes', JSON.stringify({ ...good, messageBytes: '***not base64***' })],
      ['non-canonical base64', JSON.stringify({ ...good, messageBytes: 'AQI' })],
      ['empty bytes', JSON.stringify({ ...good, messageBytes: '' })],
      ['bytes as array', JSON.stringify({ ...good, messageBytes: [1, 2, 3] })],
      ['missing customer', JSON.stringify({ ...good, customerId: undefined })],
      ['fractional expiry', JSON.stringify({ ...good, expiresAtMs: 1.5 })],
      ['string expiry', JSON.stringify({ ...good, expiresAtMs: String(T0 + 1000) })],
      ['id swapped (value copied from another key)', JSON.stringify({ ...good, transactionId: 'tx-OTHER' })],
      ['truncated', JSON.stringify(good).slice(0, 40)],
    ];
    for (const [name, value] of bad) {
      redis.data.set(key, { value, expiresAtMs: null });
      assert.equal(await store.get('tx-1'), null, `should reject: ${name}`);
    }
  });

  test('redis failures throw a 503-class error on every operation (fail closed)', async () => {
    const store = make();
    await store.save(record());
    redis.failWith = new Error('ECONNREFUSED redis://secret-host:6379');
    for (const op of [() => store.save(record()), () => store.get('tx-1'), () => store.delete('tx-1')]) {
      await assert.rejects(op, (e: unknown) => {
        assert.ok(e instanceof PreparedStoreUnavailableError);
        assert.ok(e instanceof ServiceUnavailableException);
        assert.doesNotMatch(JSON.stringify((e as ServiceUnavailableException).getResponse()), /secret-host|ECONNREFUSED/);
        return true;
      });
    }
  });

  test('refuses to store an empty message', async () => {
    await assert.rejects(make().save({ ...record(), messageBytes: new Uint8Array(0) }), TypeError);
    assert.equal(redis.data.size, 0);
  });

  test('onModuleDestroy quits the client', async () => {
    await make().onModuleDestroy();
    assert.equal(redis.quitCalls, 1);
  });
});

describe('RedisPreparedMessageStore', () => {
  const make = () => new RedisPreparedMessageStore(redis, () => clock.now);
  const entry = (over: Partial<PreparedMessage> = {}): PreparedMessage => ({
    reference: 'ref-1',
    orderId: 'order-1',
    customerId: 'cust-1',
    payer: 'PayerPubkey1111111111111111111111111111111',
    merchant: 'MerchantPubkey11111111111111111111111111',
    mint: 'MintPubkey11111111111111111111111111111111',
    amountAtomic: 18_446_744_073_709_551_615n, // > Number.MAX_SAFE_INTEGER, u64 max
    referenceKey: 'RefKey111111111111111111111111111111111111',
    feeLamports: 5_000n,
    messageBytes: allBytes(),
    createdAtMs: T0,
    ...over,
  });

  test('round-trips bigint exactly (above 2^53) and bytes exactly', async () => {
    const store = make();
    await store.put(entry());
    const out = await store.get('ref-1');
    assert.ok(out);
    assert.equal(typeof out.amountAtomic, 'bigint');
    assert.equal(out.amountAtomic, 18_446_744_073_709_551_615n);
    assert.equal(out.feeLamports, 5_000n);
    assert.deepEqual(out, entry());
    assert.ok(out.messageBytes instanceof Uint8Array);
    assert.deepEqual(Array.from(out.messageBytes), Array.from(allBytes()));
  });

  test('zero bigint values round-trip', async () => {
    const store = make();
    await store.put(entry({ amountAtomic: 0n, feeLamports: 0n }));
    const out = await store.get('ref-1');
    assert.equal(out!.amountAtomic, 0n);
    assert.equal(out!.feeLamports, 0n);
  });

  test('serialized value contains no JSON numbers for bigints / no raw bytes', async () => {
    await make().put(entry());
    const stored = JSON.parse(redis.data.get(`${MESSAGE_KEY_PREFIX}ref-1`)!.value);
    assert.equal(stored.amountAtomic, '18446744073709551615');
    assert.equal(typeof stored.messageBytes, 'string');
  });

  test('key prefix, SET PX, TTL = createdAt + max age - now', async () => {
    clock.now = T0 + 10_000;
    await make().put(entry());
    const call = redis.setCalls[0];
    assert.equal(call.key, 'helix:wallet:prepared:msg:ref-1');
    assert.equal(call.mode, 'PX');
    assert.equal(call.ttlMs, PREPARED_MESSAGE_MAX_AGE_MS - 10_000);
  });

  test('TTL expiry returns null; already-expired entries are not persisted', async () => {
    const store = make();
    await store.put(entry());
    clock.now = T0 + PREPARED_MESSAGE_MAX_AGE_MS - 1;
    assert.ok(await store.get('ref-1'));
    clock.now = T0 + PREPARED_MESSAGE_MAX_AGE_MS;
    assert.equal(await store.get('ref-1'), null);

    await store.put(entry({ reference: 'old', createdAtMs: T0 - PREPARED_MESSAGE_MAX_AGE_MS - 1 }));
    assert.equal(redis.data.has(`${MESSAGE_KEY_PREFIX}old`), false);
  });

  test('delete, missing get, overwrite-by-reference', async () => {
    const store = make();
    assert.equal(await store.get('ref-1'), null);
    await store.put(entry());
    await store.put(entry({ messageBytes: Uint8Array.of(9, 9), createdAtMs: T0 + 1 }));
    assert.deepEqual(Array.from((await store.get('ref-1'))!.messageBytes), [9, 9]);
    await store.delete('ref-1');
    assert.equal(await store.get('ref-1'), null);
    await store.delete('ref-1');
  });

  test('stored bytes are byte-exact: a single flipped byte is detectable by the caller', async () => {
    const store = make();
    const original = entry();
    await store.put(original);
    const out = (await store.get('ref-1'))!;
    assert.equal(Buffer.compare(Buffer.from(out.messageBytes), Buffer.from(original.messageBytes)), 0);
    const flipped = Uint8Array.from(original.messageBytes);
    flipped[100] ^= 1;
    assert.notEqual(Buffer.compare(Buffer.from(out.messageBytes), Buffer.from(flipped)), 0);
  });

  test('corrupted / tampered values read as null, never a forged entry', async () => {
    const store = make();
    await store.put(entry());
    const key = `${MESSAGE_KEY_PREFIX}ref-1`;
    const good = JSON.parse(redis.data.get(key)!.value);
    const bad: Array<[string, string]> = [
      ['not json', 'garbage'],
      ['wrong kind', JSON.stringify({ ...good, kind: 'tx' })],
      ['bigint as number', JSON.stringify({ ...good, amountAtomic: 100 })],
      ['bigint negative', JSON.stringify({ ...good, amountAtomic: '-5' })],
      ['bigint decimal', JSON.stringify({ ...good, feeLamports: '1.5' })],
      ['bigint leading zero', JSON.stringify({ ...good, feeLamports: '007' })],
      ['bigint hex', JSON.stringify({ ...good, amountAtomic: '0x10' })],
      ['bad base64', JSON.stringify({ ...good, messageBytes: '!!!' })],
      ['missing payer', JSON.stringify({ ...good, payer: undefined })],
      ['missing merchant', JSON.stringify({ ...good, merchant: '' })],
      ['createdAt string', JSON.stringify({ ...good, createdAtMs: '1' })],
      ['reference swapped', JSON.stringify({ ...good, reference: 'ref-OTHER' })],
    ];
    for (const [name, value] of bad) {
      redis.data.set(key, { value, expiresAtMs: null });
      assert.equal(await store.get('ref-1'), null, `should reject: ${name}`);
    }
  });

  test('put rejects values that cannot be serialized faithfully (negative bigint, empty bytes)', async () => {
    const store = make();
    await assert.rejects(store.put(entry({ amountAtomic: -1n })), TypeError);
    await assert.rejects(store.put(entry({ messageBytes: new Uint8Array(0) })), TypeError);
    assert.equal(redis.data.size, 0);
  });

  test('redis failures throw (fail closed) for put/get/delete', async () => {
    const store = make();
    redis.failWith = new Error('boom');
    await assert.rejects(store.put(entry()), PreparedStoreUnavailableError);
    await assert.rejects(store.get('ref-1'), PreparedStoreUnavailableError);
    await assert.rejects(store.delete('ref-1'), PreparedStoreUnavailableError);
  });

  test('tx and msg namespaces cannot read each other even with the same id', async () => {
    const tx = new RedisPreparedTransactionStore(redis, () => clock.now);
    const msg = make();
    await tx.save({ transactionId: 'same', customerId: 'c', messageBytes: Uint8Array.of(1), expiresAt: new Date(T0 + 1000) });
    assert.equal(await msg.get('same'), null);
  });
});
