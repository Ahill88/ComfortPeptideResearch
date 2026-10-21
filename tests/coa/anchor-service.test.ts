/** AnchorService against a fake chain and an in-memory Prisma double: request, idempotency, concurrency, outcomes, verification, retry, sweep. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Logger } from '@nestjs/common';
import { Keypair, Message, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { AnchorService, CoaAnchorRefusedError, ANCHOR_MAX_ATTEMPTS } from '../../apps/api/src/coa/anchor/anchor.service';
import { buildMemoTransaction } from '../../apps/api/src/coa/anchor/coa-anchor-message';
import { buildCoaMemo } from '../../apps/api/src/coa/coa.types';
import { InMemoryPublisherSigner, MEMO_PROGRAM_ID, SHA_A, SHA_B, ago, makeConfig, makeHarness } from './_anchor-helpers';

Logger.overrideLogger(false); // expected failures are logged by the service; keep the test output readable

type Harness = ReturnType<typeof makeHarness>;
const STALE = 11 * 60_000;
const BLOCKHASH = new PublicKey(Buffer.alloc(32, 7)).toBase58();

const request = (h: Harness, kind: 'PUBLISH' | 'REVOKE' = 'PUBLISH') => h.service.requestAnchor({ coaId: h.coa.id, kind });
const only = (h: Harness) => {
  assert.equal(h.prisma.anchors().length, 1, 'exactly one anchor row');
  return h.prisma.anchors()[0];
};
const refusal = async (promise: Promise<unknown>): Promise<CoaAnchorRefusedError> => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CoaAnchorRefusedError, `expected a CoaAnchorRefusedError, got ${error}`);
    return error;
  }
  throw new Error('expected a refusal');
};
/** A transaction signed by `signer` with arbitrary instructions, to be "landed" under the row's signature. */
function tx(signer: Keypair, instructions: TransactionInstruction[]): Transaction {
  const built = new Transaction({ feePayer: signer.publicKey, recentBlockhash: BLOCKHASH });
  built.add(...instructions);
  return built;
}
const memoInstruction = (pubkey: PublicKey, text: string) => new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM_ID), keys: [{ pubkey, isSigner: true, isWritable: false }], data: Buffer.from(text, 'utf8') });

/** Requests the anchor, then makes the cluster hold `landed` (or the broadcast bytes) as finalized under the row's signature. */
async function pendingWithSignature(h: Harness) {
  await request(h);
  return only(h).txSignature as string;
}

/* ------------------------------------ happy path ------------------------------------ */

test('request: PENDING row with the memo, ONE legacy memo transaction signed by the publisher, signature stored before confirmation', async () => {
  const h = makeHarness();
  await request(h);
  const row = only(h);
  assert.equal(row.status, 'PENDING');
  assert.equal(row.memo, h.memo);
  assert.equal(row.network, 'solana-devnet');
  assert.equal(row.attempts, 1);
  assert.equal(h.chain.sent.length, 1);
  const sent = h.chain.sent[0];
  assert.equal(row.txSignature, sent.signature);
  assert.equal(sent.tx.feePayer?.toBase58(), h.signer!.publicKey);
  assert.equal(sent.tx.instructions.length, 1);
  assert.equal(sent.tx.instructions[0].programId.toBase58(), MEMO_PROGRAM_ID);
  assert.deepEqual(sent.tx.instructions[0].keys.map((k) => [k.pubkey.toBase58(), k.isSigner]), [[h.signer!.publicKey, true]]); // (writable once decoded: it is also the fee payer)
  assert.equal(Buffer.from(sent.tx.instructions[0].data).toString('utf8'), h.memo);
  assert.ok(sent.tx.verifySignatures(), 'the broadcast transaction carries a valid publisher signature');
  assert.ok(Buffer.from(sent.bytes).equals(sent.tx.serialize()), 'canonical bytes');
  assert.equal(h.signer!.signCalls, 1);
});

test('verification: the exact finalized transaction confirms, recording slot and blockTime; the explorer link is devnet-flavoured', async () => {
  const h = makeHarness();
  const signature = await pendingWithSignature(h);
  h.chain.land(signature, { slot: 4242, blockTime: 1_800_000_123 });
  const snapshot = await h.service.verifyAnchor(only(h).id);
  assert.equal(snapshot?.status, 'CONFIRMED');
  const row = only(h);
  assert.equal(row.status, 'CONFIRMED');
  assert.equal(row.slot, 4242n);
  assert.equal((row.blockTime as Date).toISOString(), new Date(1_800_000_123_000).toISOString());
  assert.equal(row.error, null);
  assert.equal(snapshot?.explorerUrl, `https://explorer.solana.com/tx/${signature}?cluster=devnet`);
  // a CONFIRMED anchor is never touched again, not by request, sweep or retry
  await request(h);
  await h.service.reconcile();
  assert.equal(h.chain.sent.length, 1);
  assert.equal((await refusal(h.service.retry(h.coa.id, 'PUBLISH'))).reason, 'ALREADY_CONFIRMED');
});

test('the scheduled sweep confirms landed anchors and reports counts', async () => {
  const h = makeHarness();
  h.chain.land(await pendingWithSignature(h));
  assert.deepEqual(await h.service.reconcile(), { checked: 1, confirmed: 1, failed: 0, rebroadcast: 0, unavailable: 0 });
  assert.deepEqual(await h.service.reconcile(), { checked: 0, confirmed: 0, failed: 0, rebroadcast: 0, unavailable: 0 });
});

/* --------------------------------- eligibility / disabled --------------------------------- */

test('disabled (default): nothing is created, signed or sent', async () => {
  const h = makeHarness({ config: { enabled: false } });
  await request(h);
  assert.equal(h.prisma.anchors().length, 0);
  assert.equal(h.signer!.signCalls, 0);
  assert.equal(h.chain.sent.length, 0);
});

test('eligibility: PUBLISH for a published/superseded/revoked-after-publish coa; REVOKE only for a REVOKED coa; never drafts', async () => {
  const h = makeHarness();
  const lot = h.lot;
  const add = (over: Record<string, unknown>) => h.prisma.addCoa(lot.id, over);
  const draft = add({ version: 2, status: 'DRAFT', publishedAt: null });
  const superseded = add({ version: 3, status: 'SUPERSEDED' });
  const revoked = add({ version: 4, status: 'REVOKED' });
  const revokedNeverPublished = add({ version: 5, status: 'REVOKED', publishedAt: null });
  const kinds = async (coaId: string) => {
    for (const kind of ['PUBLISH', 'REVOKE'] as const) await h.service.requestAnchor({ coaId, kind });
    return h.prisma.anchors().filter((a) => a.coaId === coaId).map((a) => a.kind).sort();
  };
  assert.deepEqual(await kinds(draft.id), []);
  assert.deepEqual(await kinds(h.coa.id), ['PUBLISH']); // PUBLISHED: publish only
  assert.deepEqual(await kinds(superseded.id), ['PUBLISH']);
  assert.deepEqual(await kinds(revoked.id), ['PUBLISH', 'REVOKE']);
  assert.deepEqual(await kinds(revokedNeverPublished.id), ['REVOKE']);
  await h.service.requestAnchor({ coaId: 'does-not-exist', kind: 'PUBLISH' }); // never throws
  const revokeRow = h.prisma.anchors().find((a) => a.coaId === revoked.id && a.kind === 'REVOKE')!;
  assert.equal(revokeRow.memo, `helix-coa:v1:revoke:LOT-001:4:${SHA_A}`);
});

test('a lot code or hash that cannot form a valid memo is never anchored (no row, nothing signed)', async () => {
  const h = makeHarness();
  h.lot.code = 'bad:code';
  await request(h);
  assert.equal(h.prisma.anchors().length, 0);
  h.lot.code = 'LOT-001';
  h.coa.fileSha256 = 'A'.repeat(64); // upper-case is not the stored contract
  await request(h);
  assert.equal(h.prisma.anchors().length, 0);
  assert.equal(h.signer!.signCalls, 0);
});

/* -------------------------------- idempotency / concurrency -------------------------------- */

test('idempotent: repeated requests make one row and one transaction', async () => {
  const h = makeHarness();
  await request(h);
  await request(h);
  await request(h);
  assert.equal(h.prisma.anchors().length, 1);
  assert.equal(h.chain.sent.length, 1);
  assert.equal(h.signer!.signCalls, 1);
});

test('10 parallel requests => one row, one signature request, one transaction', async () => {
  const h = makeHarness();
  h.chain.broadcastDelayMs = 20;
  await Promise.all(Array.from({ length: 10 }, () => request(h)));
  assert.equal(h.prisma.anchors().length, 1);
  assert.equal(h.chain.sent.length, 1);
  assert.equal(h.signer!.signCalls, 1);
  assert.equal(only(h).attempts, 1);
});

test('10 parallel requests split over two service instances ("two API processes") still make one transaction (P2002 + compare-and-set)', async () => {
  const h = makeHarness();
  const other = new AnchorService(h.prisma as never, h.config, h.chain, h.signer);
  h.chain.broadcastDelayMs = 10;
  await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? h.service : other).requestAnchor({ coaId: h.coa.id, kind: 'PUBLISH' })));
  assert.equal(h.prisma.anchors().length, 1);
  assert.equal(h.chain.sent.length, 1);
});

test('parallel requests for DIFFERENT (coa, kind) keys are independent', async () => {
  const h = makeHarness();
  const revoked = h.prisma.addCoa(h.lot.id, { version: 2, status: 'REVOKED' });
  await Promise.all([request(h), h.service.requestAnchor({ coaId: revoked.id, kind: 'PUBLISH' }), h.service.requestAnchor({ coaId: revoked.id, kind: 'REVOKE' })]);
  assert.equal(h.prisma.anchors().length, 3);
  assert.equal(h.chain.sent.length, 3);
  assert.equal(new Set(h.chain.sent.map((s) => s.signature)).size, 3);
});

/* ------------------------------------- outcomes ------------------------------------- */

test('unknown broadcast outcome keeps the row PENDING WITH the signature (never failed, never re-sent by request)', async () => {
  const h = makeHarness();
  h.chain.broadcastMode = 'unknown';
  await request(h);
  const row = only(h);
  assert.equal(row.status, 'PENDING');
  assert.equal(row.txSignature, h.chain.sent[0].signature);
  assert.match(row.error, /outcome unknown/);
  await request(h);
  assert.equal(h.chain.sent.length, 1, 'a second request must not send a second transaction');
  // the reconciler decides: it landed after all
  h.chain.land(row.txSignature);
  await h.service.reconcile();
  assert.equal(only(h).status, 'CONFIRMED');
});

test('unknown outcome and never landed: young => untouched; stale and not found => re-sent as a NEW transaction, old signature not reused', async () => {
  const h = makeHarness();
  h.chain.broadcastMode = 'unknown';
  await request(h);
  const first = only(h).txSignature;
  assert.deepEqual(await h.service.reconcile(), { checked: 1, confirmed: 0, failed: 0, rebroadcast: 0, unavailable: 0 });
  assert.equal(h.chain.sent.length, 1);
  assert.equal(only(h).txSignature, first);

  only(h).updatedAt = ago(STALE);
  h.chain.lookupFails = true; // the lookup itself failing is NOT "not found"
  const unavailable = await h.service.reconcile();
  assert.equal(unavailable.unavailable, 1);
  assert.equal(h.chain.sent.length, 1);
  assert.equal(only(h).txSignature, first);

  h.chain.lookupFails = false;
  h.chain.broadcastMode = 'ok';
  const swept = await h.service.reconcile();
  assert.equal(swept.rebroadcast, 1);
  assert.equal(h.chain.sent.length, 2);
  assert.notEqual(only(h).txSignature, first);
  assert.equal(only(h).attempts, 2);
  assert.equal(h.prisma.anchors().length, 1);
});

test('a stale signature that the chain DOES know is verified, never re-sent', async () => {
  const h = makeHarness();
  h.chain.broadcastMode = 'unknown';
  await request(h);
  const row = only(h);
  row.updatedAt = ago(STALE);
  h.chain.land(row.txSignature);
  await h.service.reconcile();
  assert.equal(h.chain.sent.length, 1);
  assert.equal(only(h).status, 'CONFIRMED');
});

test('definitive rejection marks FAILED with a short error and no signature; request does not retry on its own', async () => {
  const h = makeHarness();
  h.chain.broadcastMode = 'reject';
  await request(h);
  const row = only(h);
  assert.equal(row.status, 'FAILED');
  assert.equal(row.txSignature, null);
  assert.match(row.error, /^Rejected by the cluster: /);
  assert.ok(row.error.length < 300);
  await request(h);
  assert.equal(h.chain.sent.length, 1);
});

test('errors never leak endpoint URLs (an RPC URL can carry an API key)', async () => {
  const h = makeHarness();
  h.chain.getLatestBlockhash = async () => {
    throw new Error('request to https://rpc.example.org/v1/?api-key=SECRETLOOKING failed');
  };
  await request(h);
  assert.ok(!/api-key|rpc\.example/.test(only(h).error), only(h).error);
  assert.match(only(h).error, /\[url\]/);
});

test('RPC down before signing: PENDING with an error, the attempt is counted, nothing signed or sent; the sweep retries after 10 minutes', async () => {
  const h = makeHarness();
  h.chain.blockhashFails = true;
  await request(h);
  assert.equal(only(h).status, 'PENDING');
  assert.match(only(h).error, /RPC unavailable/);
  assert.equal(only(h).attempts, 1);
  assert.equal(h.signer!.signCalls, 0);
  h.chain.blockhashFails = false;
  await h.service.reconcile(); // young: untouched
  assert.equal(h.chain.sent.length, 0);
  only(h).updatedAt = ago(STALE);
  await h.service.reconcile();
  assert.equal(h.chain.sent.length, 1);
  assert.equal(only(h).attempts, 2);
});

test('no signer bound: PENDING with a clear error, nothing signed, nothing broadcast, no chain call, no crash', async () => {
  const h = makeHarness({ signer: null });
  let chainCalls = 0;
  h.chain.getLatestBlockhash = async () => {
    chainCalls++;
    throw new Error('should not be called');
  };
  await request(h);
  const row = only(h);
  assert.equal(row.status, 'PENDING');
  assert.match(row.error, /no publisher signer is bound/);
  assert.equal(row.attempts, 0);
  assert.equal(chainCalls + h.chain.sent.length, 0);
  assert.deepEqual(await h.service.reconcile(), { checked: 1, confirmed: 0, failed: 0, rebroadcast: 0, unavailable: 0 });
  assert.equal(only(h).status, 'PENDING');
  assert.equal((await refusal(h.service.retry(h.coa.id, 'PUBLISH'))).reason, 'NO_SIGNER');
});

test('a misbehaving signer abandons the attempt before anything is broadcast (throws / short / signature from another key)', async () => {
  for (const mode of ['throw', 'short', 'wrong-key'] as const) {
    const signer = new InMemoryPublisherSigner();
    signer.mode = mode;
    const h = makeHarness({ signer });
    await request(h);
    assert.equal(h.chain.sent.length, 0, mode);
    assert.equal(only(h).status, 'PENDING', mode);
    assert.equal(only(h).txSignature, null, mode);
    assert.match(only(h).error, /Signing failed, nothing was sent/, mode);
  }
});

test('the signer is only asked to sign the memo-only message: a corrupted builder is stopped before the signer sees it', async () => {
  const h = makeHarness();
  const seen: Uint8Array[] = [];
  const original = h.signer!.signMessage.bind(h.signer);
  h.signer!.signMessage = async (message) => {
    seen.push(message);
    return original(message);
  };
  await request(h);
  assert.equal(seen.length, 1);
  const message = Message.from(Buffer.from(seen[0]));
  assert.equal(message.instructions.length, 1);
  assert.deepEqual(message.accountKeys.map((k) => k.toBase58()), [h.signer!.publicKey, MEMO_PROGRAM_ID]);
});

test('the service never throws to the caller, whatever the database does', async () => {
  const h = makeHarness();
  h.prisma.coa.findUnique = async () => {
    throw new Error('connection lost');
  };
  await request(h); // resolves
  assert.equal(h.chain.sent.length, 0);
  assert.deepEqual(await h.service.verifyAnchor('x'), null);
});

/* ------------------------------------ verification ------------------------------------ */

type Deviation = { name: string; build: (h: Harness, memo: string) => Transaction; reason: RegExp; options?: { succeeded?: boolean; innerInstructions?: number } };
const deviations: Deviation[] = [
  { name: 'wrong memo (another lot)', build: (h) => tx(h.signer!.keypair, [memoInstruction(h.signer!.keypair.publicKey, buildCoaMemo('PUBLISH', 'LOT-002', 1, SHA_A))]), reason: /memo does not equal/ },
  { name: 'wrong memo (another version)', build: (h) => tx(h.signer!.keypair, [memoInstruction(h.signer!.keypair.publicKey, buildCoaMemo('PUBLISH', 'LOT-001', 2, SHA_A))]), reason: /memo does not equal/ },
  { name: 'wrong memo (another hash)', build: (h) => tx(h.signer!.keypair, [memoInstruction(h.signer!.keypair.publicKey, buildCoaMemo('PUBLISH', 'LOT-001', 1, SHA_B))]), reason: /memo does not equal/ },
  { name: 'wrong memo (another kind)', build: (h) => tx(h.signer!.keypair, [memoInstruction(h.signer!.keypair.publicKey, buildCoaMemo('REVOKE', 'LOT-001', 1, SHA_A))]), reason: /memo does not equal/ },
  { name: 'extra instruction', build: (h, memo) => tx(h.signer!.keypair, [memoInstruction(h.signer!.keypair.publicKey, memo), SystemProgram.transfer({ fromPubkey: h.signer!.keypair.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })]), reason: /exactly one instruction/ },
  { name: 'two memo instructions', build: (h, memo) => tx(h.signer!.keypair, [memoInstruction(h.signer!.keypair.publicKey, memo), memoInstruction(h.signer!.keypair.publicKey, memo)]), reason: /exactly one instruction/ },
  { name: 'wrong signer / fee payer', build: (_h, memo) => { const other = Keypair.generate(); return tx(other, [memoInstruction(other.publicKey, memo)]); }, reason: /fee payer is not the configured publisher/ },
  { name: 'no signer attribution on the memo', build: (h, memo) => tx(h.signer!.keypair, [new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM_ID), keys: [], data: Buffer.from(memo) })]), reason: /signed by the publisher/ },
  { name: 'failed transaction', build: (h, memo) => buildMemoTransaction(h.signer!.keypair.publicKey, memo, BLOCKHASH), reason: /failed on chain/, options: { succeeded: false } },
  { name: 'inner instructions', build: (h, memo) => buildMemoTransaction(h.signer!.keypair.publicKey, memo, BLOCKHASH), reason: /inner instructions/, options: { innerInstructions: 1 } },
];

for (const deviation of deviations) {
  test(`verification REJECTS: ${deviation.name}`, async () => {
    const h = makeHarness();
    const signature = await pendingWithSignature(h);
    h.chain.land(signature, { tx: deviation.build(h, h.memo), ...deviation.options });
    const snapshot = await h.service.verifyAnchor(only(h).id);
    assert.equal(snapshot?.status, 'FAILED');
    assert.equal(only(h).status, 'FAILED');
    assert.match(only(h).error, deviation.reason);
    assert.equal(only(h).slot, null);
  });
}

test('verification: not finalized stays PENDING (even when it looks successful or failed) until finalized', async () => {
  const h = makeHarness();
  const signature = await pendingWithSignature(h);
  h.chain.land(signature, { finalized: false });
  assert.equal((await h.service.verifyAnchor(only(h).id))?.status, 'PENDING');
  h.chain.land(signature, { finalized: false, succeeded: false });
  assert.equal((await h.service.verifyAnchor(only(h).id))?.status, 'PENDING');
  assert.equal(only(h).slot, null);
  h.chain.land(signature, { finalized: true });
  assert.equal((await h.service.verifyAnchor(only(h).id))?.status, 'CONFIRMED');
});

test('verification: signer must be the CONFIGURED publisher (key rotation: an anchor signed by the old key does not confirm under the new one)', async () => {
  const h = makeHarness();
  const signature = await pendingWithSignature(h);
  h.chain.land(signature);
  const rotated = new AnchorService(h.prisma as never, h.config, h.chain, new InMemoryPublisherSigner());
  assert.equal((await rotated.verifyAnchor(only(h).id))?.status, 'FAILED');
  assert.match(only(h).error, /fee payer/);
});

test('verification: the expected memo is rebuilt from the COA record; a tampered row memo or a changed record fails', async () => {
  const tampered = makeHarness();
  let signature = await pendingWithSignature(tampered);
  tampered.chain.land(signature);
  only(tampered).memo = buildCoaMemo('PUBLISH', 'LOT-001', 1, SHA_B);
  assert.equal((await tampered.service.verifyAnchor(only(tampered).id))?.status, 'FAILED');
  const changed = makeHarness();
  signature = await pendingWithSignature(changed);
  changed.chain.land(signature);
  changed.coa.fileSha256 = SHA_B;
  assert.equal((await changed.service.verifyAnchor(only(changed).id))?.status, 'FAILED');
});

test('verification: a row created for another network than the configured one is failed, not verified against the wrong cluster', async () => {
  const h = makeHarness();
  const signature = await pendingWithSignature(h);
  h.chain.land(signature);
  const mainnet = new AnchorService(h.prisma as never, makeConfig({ network: 'solana-mainnet' }), h.chain, h.signer);
  assert.equal((await mainnet.verifyAnchor(only(h).id))?.status, 'FAILED');
  assert.match(only(h).error, /anchored on solana-devnet/);
});

test('verification without a signer (publisher unknown) confirms nothing', async () => {
  const h = makeHarness();
  const signature = await pendingWithSignature(h);
  h.chain.land(signature);
  const keyless = new AnchorService(h.prisma as never, h.config, h.chain, undefined);
  assert.equal((await keyless.verifyAnchor(only(h).id))?.status, 'PENDING');
});

test('verification: chain unavailable leaves the row untouched', async () => {
  const h = makeHarness();
  const signature = await pendingWithSignature(h);
  h.chain.land(signature);
  h.chain.lookupFails = true;
  assert.equal((await h.service.verifyAnchor(only(h).id))?.status, 'PENDING');
  assert.equal(only(h).txSignature, signature);
});

/* ------------------------------------- sweep rules ------------------------------------- */

test('sweep: PENDING without a signature is retried only after 10 minutes, at most 5 attempts, then FAILED "gave up"', async () => {
  const h = makeHarness();
  h.chain.blockhashFails = true;
  await request(h);
  for (let attempt = 2; attempt <= ANCHOR_MAX_ATTEMPTS; attempt++) {
    await h.service.reconcile();
    assert.equal(only(h).attempts, attempt - 1, 'not stale yet: untouched');
    only(h).updatedAt = ago(STALE);
    await h.service.reconcile();
    assert.equal(only(h).attempts, attempt);
    assert.equal(only(h).status, 'PENDING');
  }
  only(h).updatedAt = ago(STALE);
  const summary = await h.service.reconcile();
  assert.equal(summary.failed, 1);
  assert.equal(only(h).status, 'FAILED');
  assert.match(only(h).error, /gave up after 5 attempts/);
  assert.equal(h.chain.sent.length, 0);
});

test('sweep: an unknown signature past its attempts is FAILED "gave up" (never an endless resend loop)', async () => {
  const h = makeHarness();
  h.chain.broadcastMode = 'unknown';
  await request(h);
  only(h).attempts = ANCHOR_MAX_ATTEMPTS;
  only(h).updatedAt = ago(STALE);
  await h.service.reconcile();
  assert.equal(only(h).status, 'FAILED');
  assert.match(only(h).error, /gave up/);
  assert.equal(h.chain.sent.length, 1);
});

test('sweep with anchoring switched off confirms what landed but never broadcasts', async () => {
  const h = makeHarness();
  h.chain.blockhashFails = true;
  await request(h);
  h.chain.blockhashFails = false;
  only(h).updatedAt = ago(STALE);
  const off = new AnchorService(h.prisma as never, makeConfig({ enabled: false }), h.chain, h.signer);
  await off.reconcile();
  assert.equal(h.chain.sent.length, 0);
});

/* ---------------------------------------- retry ---------------------------------------- */

test('retry: FAILED (rejected) is reset and attempted again with fresh attempt count', async () => {
  const h = makeHarness();
  h.chain.broadcastMode = 'reject';
  await request(h);
  h.chain.broadcastMode = 'ok';
  const snapshot = await h.service.retry(h.coa.id, 'PUBLISH');
  assert.equal(snapshot.status, 'PENDING');
  assert.equal(snapshot.attempts, 1);
  assert.ok(snapshot.txSignature);
  assert.equal(h.chain.sent.length, 2);
  h.chain.land(snapshot.txSignature!);
  await h.service.reconcile();
  assert.equal(only(h).status, 'CONFIRMED');
});

test('retry: with no row yet (anchoring was off at publish time) it creates and sends the anchor', async () => {
  const h = makeHarness({ config: { enabled: false } });
  await request(h);
  assert.equal(h.prisma.anchors().length, 0);
  const enabled = new AnchorService(h.prisma as never, makeConfig(), h.chain, h.signer);
  assert.equal((await enabled.retry(h.coa.id, 'PUBLISH')).status, 'PENDING');
  assert.equal(h.chain.sent.length, 1);
  assert.equal((await refusal(h.service.retry(h.coa.id, 'PUBLISH'))).reason, 'DISABLED');
});

test('retry refuses: CONFIRMED, in flight (young signature), on chain but not finalized, chain unavailable, unknown / ineligible coa', async () => {
  const h = makeHarness();
  h.chain.broadcastMode = 'unknown';
  await request(h);
  const sig = only(h).txSignature;
  assert.equal((await refusal(h.service.retry(h.coa.id, 'PUBLISH'))).reason, 'IN_FLIGHT');
  only(h).updatedAt = ago(STALE);
  h.chain.land(sig, { finalized: false });
  assert.equal((await refusal(h.service.retry(h.coa.id, 'PUBLISH'))).reason, 'IN_FLIGHT');
  h.chain.lookupFails = true;
  assert.equal((await refusal(h.service.retry(h.coa.id, 'PUBLISH'))).reason, 'CHAIN_UNAVAILABLE');
  assert.equal(h.chain.sent.length, 1, 'none of the refusals sent anything');
  assert.equal(only(h).txSignature, sig);
  assert.equal((await refusal(h.service.retry('nope', 'PUBLISH'))).reason, 'NOT_FOUND');
  assert.equal((await refusal(h.service.retry(h.coa.id, 'REVOKE'))).reason, 'NOT_ELIGIBLE');
});

test('retry of a stuck PENDING: the old signature is searched first; found+finalized confirms WITHOUT a second transaction', async () => {
  const h = makeHarness();
  h.chain.broadcastMode = 'unknown';
  await request(h);
  only(h).updatedAt = ago(STALE);
  h.chain.land(only(h).txSignature);
  const snapshot = await h.service.retry(h.coa.id, 'PUBLISH');
  assert.equal(snapshot.status, 'CONFIRMED');
  assert.equal(h.chain.sent.length, 1);
});

test('retry of a stuck PENDING whose signature the chain does not know (after 10 minutes): reset and re-sent as a new transaction', async () => {
  const h = makeHarness();
  h.chain.broadcastMode = 'unknown';
  await request(h);
  const old = only(h).txSignature;
  only(h).updatedAt = ago(STALE);
  h.chain.broadcastMode = 'ok';
  const snapshot = await h.service.retry(h.coa.id, 'PUBLISH');
  assert.equal(h.chain.sent.length, 2);
  assert.notEqual(snapshot.txSignature, old);
  assert.equal(snapshot.attempts, 1);
});

test('retry of a FAILED anchor whose transaction landed wrongly sends a corrected one; whose transaction landed correctly confirms instead', async () => {
  const wrong = makeHarness();
  let signature = await pendingWithSignature(wrong);
  wrong.chain.land(signature, { tx: tx(wrong.signer!.keypair, [memoInstruction(wrong.signer!.keypair.publicKey, buildCoaMemo('PUBLISH', 'LOT-009', 1, SHA_A))]) });
  await wrong.service.reconcile();
  assert.equal(only(wrong).status, 'FAILED');
  only(wrong).updatedAt = ago(STALE);
  const resent = await wrong.service.retry(wrong.coa.id, 'PUBLISH');
  assert.equal(resent.status, 'PENDING');
  assert.equal(wrong.chain.sent.length, 2);

  // FAILED earlier only because the configured publisher was different; once the right key is bound again the same transaction confirms.
  const rotated = makeHarness();
  signature = await pendingWithSignature(rotated);
  rotated.chain.land(signature);
  const other = new AnchorService(rotated.prisma as never, rotated.config, rotated.chain, new InMemoryPublisherSigner());
  await other.verifyAnchor(only(rotated).id);
  assert.equal(only(rotated).status, 'FAILED');
  const back = await rotated.service.retry(rotated.coa.id, 'PUBLISH');
  assert.equal(back.status, 'CONFIRMED');
  assert.equal(rotated.chain.sent.length, 1);
});

test('retry serializes with concurrent requests: parallel retries of a FAILED anchor send exactly one new transaction', async () => {
  const h = makeHarness();
  h.chain.broadcastMode = 'reject';
  await request(h);
  h.chain.broadcastMode = 'ok';
  h.chain.broadcastDelayMs = 10;
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => h.service.retry(h.coa.id, 'PUBLISH')));
  assert.equal(h.chain.sent.length, 2, 'the rejected one plus exactly one retry');
  assert.equal(results.filter((r) => r.status === 'fulfilled').length >= 1, true);
  for (const result of results) if (result.status === 'rejected') assert.ok(result.reason instanceof CoaAnchorRefusedError);
});
