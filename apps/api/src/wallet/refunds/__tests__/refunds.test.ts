import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { ChainUnavailableError, USDC_DEVNET_MINT } from '../../contracts';
import { ChainRejectedError } from '../../chain/chain-errors';
import { RefundsService } from '../refunds.service';
import { ORDER_ID, TOTAL_ATOMIC, makeHarness } from './harness';

const rejects = (promise: Promise<unknown>, status: number, match?: RegExp) =>
  assert.rejects(promise, (e: any) => {
    assert.equal(e.getStatus?.(), status, `expected HTTP ${status}, got ${e.getStatus?.()} (${e.message})`);
    if (match) assert.match(e.message, match);
    return true;
  });

const ask = (h: ReturnType<typeof makeHarness>, amount?: bigint) => h.service.requestRefund(ORDER_ID, amount, 'customer request', 'admin-1');
const auditActions = (h: ReturnType<typeof makeHarness>) => h.prisma.audits.map((a) => a.action);

// ------------------------------------------------------------------------------------------------
// eligibility
// ------------------------------------------------------------------------------------------------
test('cannot refund an unpaid order (PENDING_PAYMENT), a cancelled order, or an unknown order', async () => {
  for (const status of ['PENDING_PAYMENT', 'CANCELLED', 'REFUNDED']) {
    const h = makeHarness({ orderStatus: status });
    await rejects(ask(h), 409, /PAID/);
    assert.equal(h.prisma.refunds.length, 0);
  }
  const h = makeHarness();
  await rejects(h.service.requestRefund('nope', undefined, 'customer request', 'admin-1'), 404);
});

test('cannot refund a PAID order that has no FINALIZED purchase row', async () => {
  const none = makeHarness({ withPurchase: false });
  await rejects(ask(none), 409, /no finalized/);
  const notFinal = makeHarness();
  notFinal.prisma.txs.find((t) => t.type === 'PURCHASE')!.status = 'SUBMITTED';
  await rejects(ask(notFinal), 409, /no finalized/);
  assert.equal(none.prisma.refunds.length + notFinal.prisma.refunds.length, 0);
});

test('request validates inputs: reason, actor, and a positive amount', async () => {
  const h = makeHarness();
  await rejects(h.service.requestRefund(ORDER_ID, undefined, '  ', 'admin-1'), 400);
  await rejects(h.service.requestRefund(ORDER_ID, undefined, 'customer request', ''), 400);
  await rejects(h.service.requestRefund(ORDER_ID, 0n, 'customer request', 'admin-1'), 400);
  await rejects(h.service.requestRefund(ORDER_ID, -5n, 'customer request', 'admin-1'), 400);
  assert.equal(h.prisma.refunds.length, 0);
});

// ------------------------------------------------------------------------------------------------
// over-refund
// ------------------------------------------------------------------------------------------------
test('over-refund is rejected, including cumulative over-refund across partial refunds', async () => {
  const h = makeHarness();
  await rejects(ask(h, TOTAL_ATOMIC + 1n), 409, /exceeds/);
  const first = await ask(h, 100_000_000n);
  assert.equal(first.status, 'PREPARED');
  await rejects(ask(h, 150_000_001n), 409, /exceeds/);
  const second = await ask(h, 150_000_000n);
  assert.equal(second.amountAtomic, '150000000');
  await rejects(ask(h), 409, /fully refunded/);
  assert.equal(h.prisma.refunds.length, 2);
  assert.notEqual(first.reference, second.reference);
});

test('a FAILED refund frees its amount; an in-flight one does not', async () => {
  const h = makeHarness();
  const a = await ask(h);
  await rejects(ask(h, 1n), 409);
  h.prisma.txs.find((t) => t.id === a.refundId)!.status = 'FAILED';
  const b = await ask(h);
  assert.equal(b.amountAtomic, TOTAL_ATOMIC.toString());
});

for (const mode of ['serialized', 'concurrent'] as const) {
  test(`concurrent full-amount requests cannot over-refund (${mode} transactions)`, async () => {
    const h = makeHarness({ mode });
    const results = await Promise.allSettled([ask(h), ask(h), ask(h), ask(h)]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    assert.equal(ok.length, 1, `exactly one concurrent request may win, got ${ok.length}`);
    for (const r of results) if (r.status === 'rejected') assert.equal((r.reason as any).getStatus(), 409);
    const sum = h.prisma.refunds.reduce((s, r) => s + (r.amountAtomic as bigint), 0n);
    assert.equal(sum, TOTAL_ATOMIC);
  });

  test(`concurrent partial requests never exceed the total (${mode} transactions)`, async () => {
    const h = makeHarness({ mode });
    const results = await Promise.allSettled([ask(h, 100_000_000n), ask(h, 100_000_000n), ask(h, 100_000_000n), ask(h, 100_000_000n)]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    assert.equal(ok.length, 2); // 3 x 100 > 250
    const sum = h.prisma.refunds.reduce((s, r) => s + (r.amountAtomic as bigint), 0n);
    assert.equal(sum, 200_000_000n);
    assert.ok(sum <= TOTAL_ATOMIC);
    assert.equal(new Set(h.prisma.refunds.map((r) => r.reference)).size, h.prisma.refunds.length);
  });
}

test('P2002 on the sequence reference triggers a re-check (recomputed sum), not a blind retry', async () => {
  const h = makeHarness({ mode: 'concurrent' });
  const [a, b] = await Promise.allSettled([ask(h, 200_000_000n), ask(h, 200_000_000n)]);
  assert.equal([a, b].filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(h.prisma.refunds.length, 1);
});

// ------------------------------------------------------------------------------------------------
// destination is always the customer's wallet
// ------------------------------------------------------------------------------------------------
test('destination is derived from the original purchase source; source and fee payer are the treasury', async () => {
  const h = makeHarness();
  const requested = await ask(h);
  assert.equal(requested.destination, h.customer.publicKey.toBase58());
  assert.equal(requested.source, h.treasury.publicKey.toBase58());
  assert.equal(requested.mint, USDC_DEVNET_MINT);
  assert.equal(h.prisma.refunds[0].destinationAddress, h.customer.publicKey.toBase58());

  const submitted = await h.service.prepareAndSubmit(requested.refundId);
  assert.equal(submitted.status, 'SUBMITTED');
  const context = h.signer.calls[0].context;
  assert.equal(context.destination, h.customer.publicKey.toBase58());
  assert.equal(context.orderId, ORDER_ID);
  assert.equal(context.refundId, requested.refundId);
  assert.equal(context.amountAtomic, TOTAL_ATOMIC);

  // The unsigned transaction the signer received really pays the customer's USDC account from the treasury's.
  const tx = Transaction.from(Buffer.from(h.signer.calls[0].unsignedBase64, 'base64'));
  assert.equal(tx.feePayer!.toBase58(), h.treasury.publicKey.toBase58());
  const keys = tx.instructions[0].keys.map((k) => k.pubkey.toBase58());
  const mint = USDC_DEVNET_MINT;
  const ata = (owner: Keypair, offCurve: boolean) => getAssociatedTokenAddressSync(new PublicKey(mint), owner.publicKey, offCurve).toBase58();
  assert.equal(keys[0], ata(h.treasury, true));
  assert.equal(keys[2], ata(h.customer, false));
  assert.equal(keys[3], h.treasury.publicKey.toBase58());
  assert.equal(tx.instructions[0].keys.filter((k) => k.isSigner).length, 1);
});

test('requestRefund and prepareAndSubmit accept no destination parameter', () => {
  const h = makeHarness();
  assert.equal(h.service.requestRefund.length, 4); // orderId, amountAtomic, reason, actorId
  assert.equal(h.service.prepareAndSubmit.length, 1); // refundId
  assert.equal(h.service.verifyRefund.length, 1);
});

test('a tampered stored destination is detected at submit: nothing is signed or broadcast', async () => {
  const h = makeHarness();
  const requested = await ask(h);
  h.prisma.txs.find((t) => t.id === requested.refundId)!.destinationAddress = h.stranger.publicKey.toBase58();
  await rejects(h.service.prepareAndSubmit(requested.refundId), 409, /destination/);
  assert.equal(h.signer.calls.length, 0);
  assert.equal(h.chain.broadcasts.length, 0);
  assert.equal(h.prisma.txs.find((t) => t.id === requested.refundId)!.status, 'PREPARED');
});

test('a tampered stored destination is detected at verify: refund FAILED, order untouched', async () => {
  const h = makeHarness();
  const requested = await ask(h);
  const submitted = await h.service.prepareAndSubmit(requested.refundId);
  const row = h.prisma.txs.find((t) => t.id === requested.refundId)!;
  row.destinationAddress = h.stranger.publicKey.toBase58();
  h.land(submitted, { destinationOwner: h.stranger.publicKey.toBase58() });
  const out = await h.service.verifyRefund(requested.refundId);
  assert.equal(out.outcome, 'FAILED');
  assert.match(out.reason!, /destination/);
  assert.equal(h.prisma.orders[0].status, 'PAID');
});

// ------------------------------------------------------------------------------------------------
// merchant signer: fail closed
// ------------------------------------------------------------------------------------------------
test('with no MerchantSigner bound: 503, status unchanged, nothing broadcast', async () => {
  const h = makeHarness();
  const requested = await ask(h);
  const snapshot = () => JSON.stringify(h.prisma.txs, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  const before = snapshot();
  const auditsBefore = h.prisma.audits.length;
  await rejects(h.serviceWithoutSigner.prepareAndSubmit(requested.refundId), 503, /signer/i);
  assert.equal(snapshot(), before);
  assert.equal(h.prisma.audits.length, auditsBefore);
  assert.equal(h.chain.broadcasts.length, 0);
  assert.equal(h.prisma.txs.find((t) => t.id === requested.refundId)!.status, 'PREPARED');
});

test('a signature from the wrong key is rejected and nothing is broadcast', async () => {
  const h = makeHarness();
  const requested = await ask(h);
  // Stranger signs an equivalent transaction (stranger as fee payer) and the signature is placed in the treasury's slot.
  h.signer.respond = (unsignedBase64, _keypair) => {
    const original = Transaction.from(Buffer.from(unsignedBase64, 'base64'));
    const forged = new Transaction({ feePayer: h.stranger.publicKey, blockhash: original.recentBlockhash!, lastValidBlockHeight: 1 });
    forged.add(...original.instructions);
    forged.partialSign(h.stranger);
    original.addSignature(h.treasury.publicKey, forged.signature!);
    return original.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  };
  await rejects(h.service.prepareAndSubmit(requested.refundId), 502, /signature is invalid/);
  assert.equal(h.chain.broadcasts.length, 0);
  assert.equal(h.prisma.txs.find((t) => t.id === requested.refundId)!.status, 'PREPARED');
  assert.equal(h.prisma.txs.find((t) => t.id === requested.refundId)!.txSignature, null);
});

test('a transaction signed by a stranger as fee payer (different message) is rejected', async () => {
  const h = makeHarness();
  const requested = await ask(h);
  h.signer.respond = (unsignedBase64) => {
    const original = Transaction.from(Buffer.from(unsignedBase64, 'base64'));
    const other = new Transaction({ feePayer: h.stranger.publicKey, blockhash: original.recentBlockhash!, lastValidBlockHeight: 1 });
    other.add(...original.instructions);
    other.partialSign(h.stranger);
    return other.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  };
  await rejects(h.service.prepareAndSubmit(requested.refundId), 502, /differs/);
  assert.equal(h.chain.broadcasts.length, 0);
});

test('an unsigned, altered-amount, or garbage signer response is rejected', async () => {
  const h = makeHarness();
  const requested = await ask(h);
  h.signer.respond = (unsignedBase64) => unsignedBase64; // not signed
  await rejects(h.service.prepareAndSubmit(requested.refundId), 502, /not signed/);

  h.signer.respond = (unsignedBase64, keypair) => {
    // Re-sign a message that pays a different amount to the same accounts.
    const original = Transaction.from(Buffer.from(unsignedBase64, 'base64'));
    const data = Buffer.from(original.instructions[0].data);
    data.writeBigUInt64LE(BigInt(TOTAL_ATOMIC) * 2n, 1);
    original.instructions[0].data = data;
    original.signatures = [];
    original.partialSign(keypair);
    return original.serialize().toString('base64');
  };
  await rejects(h.service.prepareAndSubmit(requested.refundId), 502, /differs/);

  h.signer.respond = () => 'not base64 !!';
  await rejects(h.service.prepareAndSubmit(requested.refundId), 502, /base64/);

  h.signer.respond = () => {
    throw new Error('hsm offline');
  };
  await rejects(h.service.prepareAndSubmit(requested.refundId), 502, /did not sign/);
  assert.equal(h.chain.broadcasts.length, 0);
  assert.equal(h.prisma.txs.find((t) => t.id === requested.refundId)!.status, 'PREPARED');
});

test('a signer whose treasury is not the treasury that received the payment is refused before signing', async () => {
  const h = makeHarness();
  const requested = await ask(h);
  h.signer.reportedTreasury = h.stranger.publicKey.toBase58();
  await rejects(h.service.prepareAndSubmit(requested.refundId), 409, /treasury/);
  assert.equal(h.signer.calls.length, 0);
});

test('insufficient treasury USDC/SOL and RPC outage leave the refund PREPARED', async () => {
  const h = makeHarness();
  const requested = await ask(h);
  h.chain.usdc.set(h.treasury.publicKey.toBase58(), 1n);
  await rejects(h.service.prepareAndSubmit(requested.refundId), 409, /USDC/);
  h.chain.usdc.set(h.treasury.publicKey.toBase58(), TOTAL_ATOMIC);
  h.chain.sol.set(h.treasury.publicKey.toBase58(), 1n);
  await rejects(h.service.prepareAndSubmit(requested.refundId), 409, /SOL/);
  h.chain.sol.set(h.treasury.publicKey.toBase58(), 100_000_000n);
  h.chain.unavailable = true;
  await rejects(h.service.prepareAndSubmit(requested.refundId), 503);
  assert.equal(h.signer.calls.length, 0);
  assert.equal(h.prisma.txs.find((t) => t.id === requested.refundId)!.status, 'PREPARED');
});

// ------------------------------------------------------------------------------------------------
// submit semantics
// ------------------------------------------------------------------------------------------------
test('submit signs once, broadcasts, marks SUBMITTED, and is idempotent', async () => {
  const h = makeHarness();
  const requested = await ask(h);
  const first = await h.service.prepareAndSubmit(requested.refundId);
  const second = await h.service.prepareAndSubmit(requested.refundId);
  assert.equal(first.status, 'SUBMITTED');
  assert.equal(second.txSignature, first.txSignature);
  assert.equal(h.chain.broadcasts.length, 1);
  assert.equal(h.signer.calls.length, 1);
  assert.equal(h.prisma.orders[0].status, 'PAID'); // submit never touches the order
  assert.ok(auditActions(h).includes('refund.submitted'));
});

test('concurrent submits broadcast exactly once', async () => {
  const h = makeHarness();
  const requested = await ask(h);
  const results = await Promise.allSettled([h.service.prepareAndSubmit(requested.refundId), h.service.prepareAndSubmit(requested.refundId)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
  assert.equal(h.chain.broadcasts.length, 1);
});

test('a definitively rejected broadcast returns to PREPARED; an unknown outcome stays SUBMITTED (no double pay)', async () => {
  const h = makeHarness();
  const requested = await ask(h);
  h.chain.broadcastError = new ChainRejectedError('blockhash not found');
  await rejects(h.service.prepareAndSubmit(requested.refundId), 502);
  let row = h.prisma.txs.find((t) => t.id === requested.refundId)!;
  assert.equal(row.status, 'PREPARED');
  assert.equal(row.txSignature, null);

  h.chain.broadcastError = new ChainUnavailableError();
  await rejects(h.service.prepareAndSubmit(requested.refundId), 503);
  row = h.prisma.txs.find((t) => t.id === requested.refundId)!;
  assert.equal(row.status, 'SUBMITTED');
  assert.ok(row.txSignature);
  // A retry must NOT sign a second transaction while the first may have landed.
  const callsBefore = h.signer.calls.length;
  h.chain.broadcastError = null;
  const again = await h.service.prepareAndSubmit(requested.refundId);
  assert.equal(again.status, 'SUBMITTED');
  assert.equal(h.signer.calls.length, callsBefore);
  assert.equal(h.chain.broadcasts.length, 0);
});

test('submit of a missing or non-refund id is 404; of a FAILED refund is 409', async () => {
  const h = makeHarness();
  await rejects(h.service.prepareAndSubmit('nope'), 404);
  await rejects(h.service.prepareAndSubmit('purchase_1'), 404); // a PURCHASE row is not a refund
  const requested = await ask(h);
  h.prisma.txs.find((t) => t.id === requested.refundId)!.status = 'FAILED';
  await rejects(h.service.prepareAndSubmit(requested.refundId), 409);
});

// ------------------------------------------------------------------------------------------------
// verify
// ------------------------------------------------------------------------------------------------
test('verify finalizes a matching transfer; full refund moves the order to REFUNDED with an audit event', async () => {
  const h = makeHarness();
  const { verified } = await h.fullCycle();
  assert.equal(verified.outcome, 'FINALIZED');
  assert.equal(verified.orderRefunded, true);
  assert.equal(verified.refund.status, 'FINALIZED');
  assert.ok(verified.refund.finalizedAt);
  assert.equal(h.prisma.orders[0].status, 'REFUNDED');
  const finalized = h.prisma.audits.filter((a) => a.action === 'refund.finalized');
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].customerId, 'cust_1');
  assert.equal(finalized[0].detail.orderRefunded, true);
  assert.equal(finalized[0].detail.cumulativeRefundedAtomic, TOTAL_ATOMIC.toString());
});

test('partial then full refund: order stays PAID until cumulative finalized refunds equal the total', async () => {
  const h = makeHarness();
  const first = await h.fullCycle(100_000_000n);
  assert.equal(first.verified.outcome, 'FINALIZED');
  assert.equal(first.verified.orderRefunded, false);
  assert.equal(h.prisma.orders[0].status, 'PAID');

  const second = await h.fullCycle(); // remaining 150_000_000
  assert.equal(second.refund.amountAtomic, '150000000');
  assert.equal(second.verified.orderRefunded, true);
  assert.equal(h.prisma.orders[0].status, 'REFUNDED');
  assert.equal(h.prisma.audits.filter((a) => a.action === 'refund.finalized').length, 2);
  await rejects(ask(h), 409, /PAID/);
});

test('REFUNDED is not reached while another refund is merely SUBMITTED (finalized sum < total)', async () => {
  const h = makeHarness();
  const a = await ask(h, 100_000_000n);
  const b = await ask(h, 150_000_000n);
  const subA = await h.service.prepareAndSubmit(a.refundId);
  await h.service.prepareAndSubmit(b.refundId);
  h.land(subA);
  const out = await h.service.verifyRefund(a.refundId);
  assert.equal(out.outcome, 'FINALIZED');
  assert.equal(out.orderRefunded, false);
  assert.equal(h.prisma.orders[0].status, 'PAID');
});

test('duplicate and concurrent verify are idempotent: one transition, one audit event', async () => {
  const h = makeHarness();
  const { refund } = await h.fullCycle();
  const again = await h.service.verifyRefund(refund.refundId);
  assert.equal(again.outcome, 'ALREADY_FINALIZED');
  assert.equal(again.orderRefunded, false);
  const [x, y] = await Promise.all([h.service.verifyRefund(refund.refundId), h.service.verifyRefund(refund.refundId)]);
  assert.equal(x.outcome, 'ALREADY_FINALIZED');
  assert.equal(y.outcome, 'ALREADY_FINALIZED');
  assert.equal(h.prisma.audits.filter((a) => a.action === 'refund.finalized').length, 1);
  assert.equal(h.prisma.orders[0].status, 'REFUNDED');
});

test('concurrent first verifies of a fresh transfer finalize exactly once (even across service instances)', async () => {
  const h = makeHarness({ mode: 'concurrent' });
  const requested = await ask(h);
  const submitted = await h.service.prepareAndSubmit(requested.refundId);
  h.land(submitted);
  const other = new RefundsService(h.prisma as any, h.chain, h.signer);
  const results = await Promise.all([h.service.verifyRefund(requested.refundId), other.verifyRefund(requested.refundId)]);
  assert.equal(results.filter((r) => r.outcome === 'FINALIZED').length, 1);
  assert.equal(results.filter((r) => r.orderRefunded).length, 1);
  assert.equal(h.prisma.audits.filter((a) => a.action === 'refund.finalized').length, 1);
});

const mismatches: Array<[string, (h: ReturnType<typeof makeHarness>) => Record<string, unknown>, RegExp]> = [
  ['wrong amount (less)', () => ({ amountAtomic: TOTAL_ATOMIC - 1n }), /underpayment/],
  ['wrong amount (more)', () => ({ amountAtomic: TOTAL_ATOMIC + 1n }), /overpayment/],
  ['wrong destination', (h) => ({ destinationOwner: h.stranger.publicKey.toBase58() }), /destination/],
  ['wrong source', (h) => ({ sourceOwner: h.stranger.publicKey.toBase58() }), /source/],
  ['wrong mint', (h) => ({ mint: h.stranger.publicKey.toBase58() }), /mint/],
  ['missing reference', () => ({ referenceKeys: [] }), /reference/],
  ['wrong network', () => ({ network: 'solana-mainnet' }), /network/],
];
for (const [name, override, pattern] of mismatches) {
  test(`on-chain mismatch => FAILED, order untouched: ${name}`, async () => {
    const h = makeHarness();
    const requested = await ask(h);
    const submitted = await h.service.prepareAndSubmit(requested.refundId);
    h.land(submitted, override(h) as any);
    const out = await h.service.verifyRefund(requested.refundId);
    assert.equal(out.outcome, 'FAILED');
    assert.match(out.reason!, pattern);
    assert.equal(out.refund.status, 'FAILED');
    assert.equal(h.prisma.orders[0].status, 'PAID');
    const failed = h.prisma.audits.filter((a) => a.action === 'refund.failed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].detail.manualReview, true);
    assert.equal(failed[0].detail.fundsMoved, true);
    assert.equal(h.prisma.audits.filter((a) => a.action === 'refund.finalized').length, 0);
    // Terminal: verifying again does not resurrect it.
    assert.equal((await h.service.verifyRefund(requested.refundId)).outcome, 'TERMINAL');
  });
}

test('a transaction that failed on chain is FAILED without funds moved; the amount becomes refundable again', async () => {
  const h = makeHarness();
  const requested = await ask(h);
  const submitted = await h.service.prepareAndSubmit(requested.refundId);
  h.land(submitted, { succeeded: false });
  const out = await h.service.verifyRefund(requested.refundId);
  assert.equal(out.outcome, 'FAILED');
  assert.equal(h.prisma.audits.find((a) => a.action === 'refund.failed')!.detail.fundsMoved, false);
  const retry = await ask(h);
  assert.equal(retry.amountAtomic, TOTAL_ATOMIC.toString());
  assert.notEqual(retry.reference, requested.reference);
});

test('not found / not finalized stay pending; RPC outage is 503 with state untouched', async () => {
  const h = makeHarness();
  const requested = await ask(h);
  assert.equal((await h.service.verifyRefund(requested.refundId)).outcome, 'PENDING'); // not submitted
  const submitted = await h.service.prepareAndSubmit(requested.refundId);
  assert.equal((await h.service.verifyRefund(requested.refundId)).outcome, 'PENDING'); // not on chain yet
  h.land(submitted, { finalized: false });
  const confirmed = await h.service.verifyRefund(requested.refundId);
  assert.equal(confirmed.outcome, 'PENDING');
  assert.equal(confirmed.refund.status, 'CONFIRMED');
  assert.equal(h.prisma.orders[0].status, 'PAID');
  h.chain.unavailable = true;
  await rejects(h.service.verifyRefund(requested.refundId), 503);
  assert.equal(h.prisma.txs.find((t) => t.id === requested.refundId)!.status, 'CONFIRMED');
  h.chain.unavailable = false;
  h.land(submitted);
  assert.equal((await h.service.verifyRefund(requested.refundId)).outcome, 'FINALIZED');
});

test('verify of a missing refund or a PURCHASE row is 404', async () => {
  const h = makeHarness();
  await rejects(h.service.verifyRefund('nope'), 404);
  await rejects(h.service.verifyRefund('purchase_1'), 404);
});

test('list returns refunds only, newest first, with string amounts; filters by order and status', async () => {
  const h = makeHarness();
  const a = await ask(h, 100_000_000n);
  const b = await ask(h, 50_000_000n);
  const all = await h.service.list();
  assert.deepEqual(all.map((r) => r.refundId), [b.refundId, a.refundId]);
  assert.equal(typeof all[0].amountAtomic, 'string');
  assert.equal((await h.service.list({ status: 'FINALIZED' })).length, 0);
  assert.equal((await h.service.list({ orderId: 'other' })).length, 0);
  assert.equal((await h.service.list({ orderId: ORDER_ID, status: 'PREPARED' })).length, 2);
});

test('the platform never touches customer funds: no customer key is ever needed and treasury is the only signer', async () => {
  const h = makeHarness();
  await h.fullCycle();
  const tx = Transaction.from(h.chain.broadcasts[0] as Buffer);
  assert.equal(tx.signatures.length, 1);
  assert.equal(tx.signatures[0].publicKey.toBase58(), h.treasury.publicKey.toBase58());
  assert.ok(!tx.instructions[0].keys.some((k) => k.isSigner && k.pubkey.equals(h.customer.publicKey)));
});
