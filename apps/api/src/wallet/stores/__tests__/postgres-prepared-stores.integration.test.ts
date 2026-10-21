/**
 * Postgres prepared stores against a REAL database (your own scratch schema; never public/dev):
 *   export DATABASE_URL="postgresql://helix@127.0.0.1:54329/helix_field?schema=agent_store"
 *   pnpm --filter @helix-field/api exec prisma migrate deploy
 *   TEST_DATABASE_URL=$DATABASE_URL node tests/run-all.mjs stores
 */
import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Keypair, Transaction } from '@solana/web3.js';
import { PrismaService } from '../../../prisma.service';
import { AllowAllComplianceScreen } from '../../transfers/compliance-screen';
import { TransfersService } from '../../transfers/transfers.service';
import { CheckoutService } from '../../checkout/checkout.service';
import { PREPARED_MESSAGE_MAX_AGE_MS } from '../../checkout/prepared-message-store';
import { CUSTOMER_ID, ORDER_ID, makeHarness, signAs } from '../../checkout/__tests__/harness';
import { linkCustomer, makeHarness as makeWalletHarness } from '../../__tests__/helpers';
import type { PreparedMessage } from '../../checkout/ports';
import { PreparedStoreUnavailableError } from '../redis-like';
import {
  PreparedPayloadTooLargeError,
  PostgresPreparedMessageStore,
  PostgresPreparedTransactionStore,
} from '../postgres-prepared-stores';
import { createPreparedMessageStore, createPreparedTransactionStore } from '../prepared-store.factory';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required (tests/run-all.mjs reports this file as SKIPPED without it).');
const schema = new URL(url).searchParams.get('schema');
if (!schema || ['public', 'dev'].includes(schema)) throw new Error(`Refusing to run against schema "${schema}": use your own scratch schema (agent_<name>).`);
process.env.DATABASE_URL = url;

const T0 = 1_800_000_000_000;
const clock = { now: T0 };
const tick = () => clock.now;
let prisma: PrismaService;

const rows = () => prisma.$queryRaw<Array<{ key: string; kind: string; payload: unknown; expiresAt: Date }>>`SELECT "key", "kind", "payload", "expiresAt" FROM "PreparedMessage" ORDER BY "key"`;
const msgStore = (opts: ConstructorParameters<typeof PostgresPreparedMessageStore>[1] = {}) => new PostgresPreparedMessageStore(prisma, { now: tick, sweepIntervalMs: 0, ...opts });
const txStore = (opts: ConstructorParameters<typeof PostgresPreparedTransactionStore>[1] = {}) => new PostgresPreparedTransactionStore(prisma, { now: tick, sweepIntervalMs: 0, ...opts });

const allBytes = (): Uint8Array => Uint8Array.from({ length: 256 }, (_, i) => i);
const message = (over: Partial<PreparedMessage> = {}): PreparedMessage => ({
  reference: 'ref-1',
  orderId: 'order-1',
  customerId: 'cust-1',
  payer: 'PayerPubkey1111111111111111111111111111111',
  merchant: 'MerchantPubkey11111111111111111111111111',
  mint: 'MintPubkey11111111111111111111111111111111',
  amountAtomic: 18_446_744_073_709_551_615n, // u64 max, beyond Number.MAX_SAFE_INTEGER
  referenceKey: 'RefKey111111111111111111111111111111111111',
  feeLamports: 5_000n,
  messageBytes: allBytes(),
  createdAtMs: T0,
  ...over,
});
const record = (over: Partial<{ transactionId: string; customerId: string; messageBytes: Uint8Array; expiresAt: Date }> = {}) => ({
  transactionId: 'tx-1',
  customerId: 'cust-1',
  messageBytes: allBytes(),
  expiresAt: new Date(T0 + 15 * 60_000),
  ...over,
});

before(async () => {
  prisma = new PrismaService();
  await prisma.$connect();
  const [{ current_schema }] = await prisma.$queryRaw<Array<{ current_schema: string }>>`SELECT current_schema()`;
  assert.equal(current_schema, schema, 'the Prisma connection must be on the scratch schema');
});
beforeEach(async () => {
  clock.now = T0;
  await prisma.$executeRaw`DELETE FROM "PreparedMessage"`;
});
after(async () => {
  if (prisma) {
    await prisma.$executeRaw`DELETE FROM "PreparedMessage"`;
    await prisma.$disconnect();
  }
});

describe('PostgresPreparedMessageStore', () => {
  test('round-trips a message exactly: all 256 byte values, u64 max / zero bigints, timestamps; fresh buffers each read', async () => {
    const store = msgStore();
    await store.put(message());
    const out = await store.get('ref-1');
    assert.ok(out);
    assert.deepEqual(out, message());
    assert.equal(typeof out.amountAtomic, 'bigint');
    assert.equal(out.amountAtomic, 18_446_744_073_709_551_615n);
    assert.ok(out.messageBytes instanceof Uint8Array);
    assert.deepEqual(Array.from(out.messageBytes), Array.from(allBytes()));
    out.messageBytes[0] = 99; // mutating a result must not affect the next read
    assert.equal((await store.get('ref-1'))!.messageBytes[0], 0);

    await store.put(message({ reference: 'ref-zero', amountAtomic: 0n, feeLamports: 0n }));
    const zero = await store.get('ref-zero');
    assert.equal(zero!.amountAtomic, 0n);
    assert.equal(zero!.feeLamports, 0n);
  });

  test('stores a kind=msg row keyed msg:<reference> whose payload is JSON with no raw bigint numbers; expiry = createdAt + max age', async () => {
    await msgStore().put(message());
    const [row] = await rows();
    assert.equal(row.key, 'msg:ref-1');
    assert.equal(row.kind, 'msg');
    assert.equal(row.expiresAt.getTime(), T0 + PREPARED_MESSAGE_MAX_AGE_MS);
    const payload = row.payload as Record<string, unknown>;
    assert.equal(payload.amountAtomic, '18446744073709551615');
    assert.equal(payload.feeLamports, '5000');
    assert.equal(typeof payload.messageBytes, 'string');
  });

  test('put overwrites by reference; delete is idempotent; unknown reference is null', async () => {
    const store = msgStore();
    await store.put(message({ orderId: 'first' }));
    await store.put(message({ orderId: 'second' }));
    assert.equal((await store.get('ref-1'))!.orderId, 'second');
    assert.equal((await rows()).length, 1);
    await store.delete('ref-1');
    await store.delete('ref-1');
    assert.equal(await store.get('ref-1'), null);
    assert.equal(await store.get('never-stored'), null);
  });

  test('TTL is enforced on read (and an expired row is not returned even though it is still in the table)', async () => {
    const store = msgStore();
    await store.put(message());
    clock.now = T0 + PREPARED_MESSAGE_MAX_AGE_MS - 1;
    assert.ok(await store.get('ref-1'));
    clock.now = T0 + PREPARED_MESSAGE_MAX_AGE_MS;
    assert.equal(await store.get('ref-1'), null);
    assert.equal((await rows()).length, 1, 'read does not delete; the sweep does');
  });

  test('an already-expired entry is not stored and clears an older one', async () => {
    const store = msgStore();
    await store.put(message());
    clock.now = T0 + 2 * PREPARED_MESSAGE_MAX_AGE_MS;
    await store.put(message({ createdAtMs: T0 }));
    assert.equal((await rows()).length, 0);
  });

  test('size cap: an oversized entry is refused, nothing is written, and the error never carries the payload', async () => {
    const store = msgStore({ maxPayloadBytes: 1_000 });
    await assert.rejects(store.put(message({ messageBytes: new Uint8Array(2_000).fill(7) })), (e: unknown) => {
      assert.ok(e instanceof PreparedPayloadTooLargeError);
      assert.doesNotMatch(String((e as Error).message), /BwcH|PayerPubkey/);
      return true;
    });
    assert.equal((await rows()).length, 0);
    await store.put(message({ messageBytes: new Uint8Array(200).fill(7) })); // under the cap is fine
    assert.equal((await rows()).length, 1);
  });

  test('take is an atomic get-and-delete: 20 parallel takers, exactly one wins; the row is gone', async () => {
    await msgStore().put(message());
    const takers = Array.from({ length: 20 }, (_, i) => (i % 2 ? msgStore() : msgStore()));
    const results = await Promise.all(takers.map((s) => s.take('ref-1')));
    const winners = results.filter((r) => r !== null);
    assert.equal(winners.length, 1);
    assert.deepEqual(winners[0], message());
    assert.equal((await rows()).length, 0);
    assert.equal(await msgStore().take('ref-1'), null);
  });

  test('take of an expired entry returns null but still removes it', async () => {
    await msgStore().put(message());
    clock.now = T0 + PREPARED_MESSAGE_MAX_AGE_MS + 1;
    assert.equal(await msgStore().take('ref-1'), null);
    assert.equal((await rows()).length, 0);
  });

  test('two store instances over one database behave as one store', async () => {
    const a = msgStore();
    const b = msgStore();
    await a.put(message());
    assert.deepEqual(await b.get('ref-1'), message());
    await b.put(message({ orderId: 'from-b' }));
    assert.equal((await a.get('ref-1'))!.orderId, 'from-b');
    await a.delete('ref-1');
    assert.equal(await b.get('ref-1'), null);
  });

  test('a row whose payload id does not match its key, or that is malformed, reads as absent (no forged entry)', async () => {
    const store = msgStore();
    await store.put(message({ reference: 'real' }));
    const [row] = await rows();
    await prisma.$executeRaw`UPDATE "PreparedMessage" SET "key" = 'msg:other' WHERE "key" = ${row.key}`;
    assert.equal(await store.get('other'), null, 'embedded reference must match the key');
    await prisma.$executeRaw`UPDATE "PreparedMessage" SET "payload" = '{"v":1,"kind":"msg"}'::jsonb WHERE "key" = 'msg:other'`;
    assert.equal(await store.get('other'), null);
    assert.equal(await store.take('other'), null);
  });
});

describe('PostgresPreparedTransactionStore', () => {
  test('round-trips a record exactly (bytes + expiresAt) under key tx:<id>, kind tx', async () => {
    const store = txStore();
    await store.save(record());
    const out = await store.get('tx-1');
    assert.ok(out);
    assert.deepEqual(out, record());
    assert.ok(out.expiresAt instanceof Date);
    assert.equal(out.expiresAt.getTime(), T0 + 15 * 60_000);
    assert.deepEqual(Array.from(out.messageBytes), Array.from(allBytes()));
    const [row] = await rows();
    assert.equal(row.key, 'tx:tx-1');
    assert.equal(row.kind, 'tx');
  });

  test('save overwrites, delete is idempotent, TTL enforced on read, expired save stores nothing', async () => {
    const store = txStore();
    await store.save(record({ customerId: 'a' }));
    await store.save(record({ customerId: 'b' }));
    assert.equal((await store.get('tx-1'))!.customerId, 'b');
    clock.now = T0 + 15 * 60_000;
    assert.equal(await store.get('tx-1'), null);
    await store.save(record({ expiresAt: new Date(T0) })); // already expired: clears the older row
    assert.equal((await rows()).length, 0);
    clock.now = T0;
    await store.save(record());
    await store.delete('tx-1');
    await store.delete('tx-1');
    assert.equal(await store.get('tx-1'), null);
  });

  test('size cap refuses an oversized record and writes nothing', async () => {
    const store = txStore({ maxPayloadBytes: 600 });
    await assert.rejects(store.save(record({ messageBytes: new Uint8Array(1_200).fill(1) })), PreparedPayloadTooLargeError);
    assert.equal((await rows()).length, 0);
  });

  test('take: 20 parallel takers across separate instances, exactly one wins', async () => {
    await txStore().save(record());
    const results = await Promise.all(Array.from({ length: 20 }, () => txStore().take('tx-1')));
    assert.equal(results.filter((r) => r !== null).length, 1);
    assert.equal((await rows()).length, 0);
  });

  test('two instances share one database', async () => {
    const a = txStore();
    const b = txStore();
    await a.save(record());
    assert.deepEqual(await b.get('tx-1'), record());
    await b.delete('tx-1');
    assert.equal(await a.get('tx-1'), null);
  });
});

describe('namespacing and the sweep', () => {
  test('the two stores never see each other\'s rows, even for the same id', async () => {
    await msgStore().put(message({ reference: 'same' }));
    await txStore().save(record({ transactionId: 'same' }));
    assert.equal((await rows()).length, 2);
    assert.equal((await msgStore().get('same'))!.reference, 'same');
    assert.equal((await txStore().get('same'))!.transactionId, 'same');
    // A row that claims another kind under this store's key prefix is invisible.
    await prisma.$executeRaw`UPDATE "PreparedMessage" SET "kind" = 'msg' WHERE "key" = 'tx:same'`;
    assert.equal(await txStore().get('same'), null);
    assert.equal(await txStore().take('same'), null);
    await txStore().delete('same');
    assert.equal((await rows()).length, 2, 'delete is also kind-scoped');
  });

  test('sweepExpired deletes only this kind\'s expired rows; live rows and the other kind are untouched', async () => {
    const m = msgStore();
    const t = txStore();
    await m.put(message({ reference: 'm-old', createdAtMs: T0 - 59 * 60_000 })); // expires in 1 minute
    await m.put(message({ reference: 'm-live' }));
    await t.save(record({ transactionId: 't-old', expiresAt: new Date(T0 + 30_000) }));
    await t.save(record({ transactionId: 't-live' }));
    clock.now = T0 + 5 * 60_000;
    assert.equal(await m.sweepExpired(), 1);
    assert.deepEqual((await rows()).map((r) => r.key), ['msg:m-live', 'tx:t-live', 'tx:t-old']);
    assert.equal(await t.sweepExpired(), 1);
    assert.deepEqual((await rows()).map((r) => r.key), ['msg:m-live', 'tx:t-live']);
    assert.equal(await m.sweepExpired(), 0);
    assert.equal(await t.sweepExpired(), 0);
  });

  test('sweeps larger than one batch complete, and concurrent sweeps from several instances delete each row exactly once', async () => {
    const total = 1_200;
    await prisma.$executeRaw`
      INSERT INTO "PreparedMessage" ("key", "kind", "payload", "expiresAt")
      SELECT 'msg:bulk-' || g, 'msg', '{}'::jsonb, (to_timestamp(${(T0 - 1_000) / 1000}::double precision) AT TIME ZONE 'UTC') FROM generate_series(1, ${total}) AS g`;
    await prisma.$executeRaw`
      INSERT INTO "PreparedMessage" ("key", "kind", "payload", "expiresAt") VALUES ('msg:keep', 'msg', '{}'::jsonb, (to_timestamp(${(T0 + 60_000) / 1000}::double precision) AT TIME ZONE 'UTC'))`;
    const counts = await Promise.all([msgStore().sweepExpired(), msgStore().sweepExpired(), msgStore().sweepExpired()]);
    assert.equal(counts.reduce((a, b) => a + b, 0), total);
    assert.deepEqual((await rows()).map((r) => r.key), ['msg:keep']);
  });

  test('the background timer sweeps on its interval and stops on destroy', async () => {
    const store = msgStore({ sweepIntervalMs: 25 });
    await store.put(message({ createdAtMs: T0 - PREPARED_MESSAGE_MAX_AGE_MS + 10 })); // expires at T0 + 10
    clock.now = T0 + 1_000;
    store.onModuleInit();
    try {
      for (let i = 0; i < 100 && (await rows()).length > 0; i++) await new Promise((r) => setTimeout(r, 25));
      assert.equal((await rows()).length, 0);
    } finally {
      store.onModuleDestroy();
    }
  });
});

describe('failure behaviour', () => {
  test('a database failure fails closed with the generic unavailable error and leaks no connection detail', async () => {
    const broken = new PrismaService({ datasources: { db: { url: 'postgresql://nobody:hunter2@127.0.0.1:1/none?connect_timeout=1' } } });
    const store = new PostgresPreparedMessageStore(broken, { now: tick, sweepIntervalMs: 0 });
    try {
      for (const op of [() => store.get('x'), () => store.put(message()), () => store.delete('x'), () => store.take('x'), () => store.sweepExpired()]) {
        await assert.rejects(op(), (e: unknown) => {
          assert.ok(e instanceof PreparedStoreUnavailableError);
          assert.doesNotMatch(JSON.stringify((e as PreparedStoreUnavailableError).getResponse()), /hunter2|127\.0\.0\.1/);
          return true;
        });
      }
    } finally {
      await broken.$disconnect();
    }
  });

  test('the factory builds Postgres stores over the real client when a database is configured', async () => {
    const env = { NODE_ENV: 'test', DATABASE_URL: url } as NodeJS.ProcessEnv;
    const m = createPreparedMessageStore({ env, prisma, now: tick });
    const t = createPreparedTransactionStore({ env, prisma, now: tick });
    assert.ok(m instanceof PostgresPreparedMessageStore);
    assert.ok(t instanceof PostgresPreparedTransactionStore);
    await m.put(message());
    assert.ok(await m.get('ref-1'));
  });
});

/** Replaces the (private) prepared-message store of an existing service, as a fresh process would be wired. */
const withStore = <T extends object>(service: T, store: unknown): T => {
  (service as unknown as { store: unknown }).store = store;
  return service;
};

describe('restart safety with the real checkout and transfers services', () => {
  test('checkout: prepare on one service + store, "restart" (new service, new store instance), then submit finds the prepared message', async () => {
    const h = makeHarness({ pullSettlement: true });
    const before = withStore(h.makeCheckout(), new PostgresPreparedMessageStore(prisma, { sweepIntervalMs: 0 }));
    const prepared = await before.prepare(CUSTOMER_ID, ORDER_ID);
    assert.equal((await rows()).length, 1);

    // The message really round-trips: what the second instance reads is byte-identical to what was compiled.
    const store2 = new PostgresPreparedMessageStore(prisma, { sweepIntervalMs: 0 });
    const stored = await store2.get(prepared.paymentReference);
    assert.ok(stored);
    assert.equal(typeof stored.amountAtomic, 'bigint');
    assert.equal(stored.amountAtomic, BigInt(prepared.amountAtomic));
    assert.equal(stored.orderId, ORDER_ID);
    assert.equal(stored.customerId, CUSTOMER_ID);
    assert.ok(stored.messageBytes instanceof Uint8Array);
    assert.deepEqual(Buffer.from(stored.messageBytes), Transaction.from(Buffer.from(prepared.unsignedTransactionBase64, 'base64')).serializeMessage());

    // control: a restarted process on the default in-memory store has lost the message (the bug this fixes)
    await assert.rejects(h.makeCheckout().submit(CUSTOMER_ID, ORDER_ID, signAs(prepared.unsignedTransactionBase64, h.customer)), (e: any) => e.getStatus?.() === 409);
    assert.equal(h.chain.broadcasts.length, 0);

    const after = withStore(h.makeCheckout(), store2); // new service instance, new store instance: the old ones are gone
    const submitted = await after.submit(CUSTOMER_ID, ORDER_ID, signAs(prepared.unsignedTransactionBase64, h.customer));
    assert.equal(submitted.status, 'SUBMITTED');
    assert.equal(h.chain.broadcasts.length, 1);
  });

  test('checkout (sponsored fee payer): the compiled message round-trips so the fee-payer decision survives a restart', async () => {
    const h = makeHarness({ sponsorship: true, customerSol: 0n });
    const first = withStore(h.makeCheckout(), new PostgresPreparedMessageStore(prisma, { sweepIntervalMs: 0 }));
    const prepared = await first.prepare(CUSTOMER_ID, ORDER_ID);
    const stored = await new PostgresPreparedMessageStore(prisma, { sweepIntervalMs: 0 }).get(prepared.paymentReference);
    assert.ok(stored);
    const compiled = Transaction.from(Buffer.from(prepared.unsignedTransactionBase64, 'base64'));
    assert.equal(compiled.feePayer!.toBase58(), h.signer.publicKey, 'sponsored: the platform signer pays the fee');
    assert.deepEqual(Buffer.from(stored.messageBytes), compiled.serializeMessage());
    assert.equal(stored.payer, h.customer.publicKey.toBase58());
  });

  test('transfers: prepare, "restart" the service and store, submit still finds the prepared message and consumes it', async () => {
    const h = makeWalletHarness();
    const who = await linkCustomer(h);
    h.chain.creditUsdc(who.address, 100_000_000n);
    const destination = Keypair.generate().publicKey.toBase58();
    const first = new TransfersService(h.db, h.credits, h.wallets, h.chain, new PostgresPreparedTransactionStore(prisma, { sweepIntervalMs: 0 }), new AllowAllComplianceScreen());
    const prepared = await first.prepare(who.customer.id, { destination, amountAtomic: '2500000' });
    const [row] = await rows();
    assert.equal(row.kind, 'tx');

    const store2 = new PostgresPreparedTransactionStore(prisma, { sweepIntervalMs: 0 });
    const stored = await store2.get(prepared.transactionId);
    assert.ok(stored);
    assert.deepEqual(Buffer.from(stored.messageBytes), Transaction.from(Buffer.from(prepared.unsignedTransaction, 'base64')).serializeMessage());
    assert.ok(stored.expiresAt instanceof Date);

    const second = new TransfersService(h.db, h.credits, h.wallets, h.chain, store2, new AllowAllComplianceScreen());
    const tx = Transaction.from(Buffer.from(prepared.unsignedTransaction, 'base64'));
    tx.partialSign(who.keypair);
    const sent = await second.submit(who.customer.id, prepared.transactionId, tx.serialize().toString('base64'));
    assert.ok(sent.txSignature);
    assert.equal(await store2.get(prepared.transactionId), null, 'submit consumed the prepared record');
    assert.equal((await rows()).length, 0);
  });

  test('CheckoutService is the real class (guards the withStore helper against a renamed field)', () => {
    const h = makeHarness();
    assert.ok(h.checkout instanceof CheckoutService);
    assert.ok('store' in (h.checkout as object));
  });
});
