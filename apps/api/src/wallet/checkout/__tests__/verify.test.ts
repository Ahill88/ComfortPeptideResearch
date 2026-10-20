import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { USDC_DEVNET_MINT } from '../../contracts';
import { referenceKeyFor } from '../checkout.util';
import { CUSTOMER_ID, ORDER_ID, makeHarness, prepareSignSubmit, transferFor } from './harness';

async function setup(opts: Parameters<typeof makeHarness>[0] = {}) {
  const h = makeHarness(opts);
  const sub = await prepareSignSubmit(h);
  return { h, ...sub };
}
const dump = (h: ReturnType<typeof makeHarness>) =>
  JSON.stringify(h.prisma.tables, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

async function assertRejectedAndNotSettled(overrides: Record<string, unknown>, reasonMatch: RegExp, expectOutcome = 'FAILED') {
  const { h, prepared, signature } = await setup();
  h.chain.transfers.set(signature, transferFor(h, prepared, signature, overrides as any));
  const result = await h.verification.verifyAndSettle({ paymentReference: prepared.paymentReference });
  assert.equal(result.outcome, expectOutcome);
  assert.match(result.reason ?? '', reasonMatch);
  assert.equal(h.prisma.orders[0].status, 'PENDING_PAYMENT', 'order must not be paid');
  assert.equal(h.fulfillmentCalls.length, 0);
  assert.equal(h.prisma.audits.filter((a) => a.action === 'checkout.settled').length, 0);
  assert.notEqual(h.prisma.txs[0].status, 'FINALIZED');
  return { h, prepared, result };
}

test('happy path: finalized exact transfer settles order PAID, consumes reservation, writes one audit, listSettlements', async () => {
  const { h, prepared, signature } = await setup();
  h.chain.transfers.set(signature, transferFor(h, prepared, signature));
  const result = await h.verification.verifyAndSettle({ paymentReference: prepared.paymentReference });
  assert.equal(result.outcome, 'FINALIZED');
  assert.equal(result.settledNow, true);
  assert.equal(h.prisma.orders[0].status, 'PAID');
  assert.equal(h.prisma.txs[0].status, 'FINALIZED');
  assert.ok(h.prisma.txs[0].finalizedAt instanceof Date);
  assert.equal(h.prisma.reservations[0].status, 'CONSUMED');
  const audits = h.prisma.audits.filter((a) => a.action === 'checkout.settled');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].detail.fulfillment, 'HELD_BY_FLAG');

  const settlements = await h.verification.listSettlements();
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].orderId, ORDER_ID);
  assert.equal(settlements[0].amountAtomic, 250_000_000n);
  assert.equal(settlements[0].txSignature, signature);
  assert.equal(settlements[0].merchant, h.merchant.publicKey.toBase58());
  assert.equal((await h.verification.listSettlements({ customerId: 'cust_2' })).length, 0);
});

test('lookup by signature also works', async () => {
  const { h, prepared, signature } = await setup();
  h.chain.transfers.set(signature, transferFor(h, prepared, signature));
  const result = await h.verification.verifyAndSettle({ signature });
  assert.equal(result.outcome, 'FINALIZED');
});

test('rejects wrong mint', async () => {
  const { h } = await assertRejectedAndNotSettled({ mint: Keypair.generate().publicKey.toBase58() }, /wrong mint/);
  assert.equal(h.prisma.txs[0].status, 'FAILED');
  assert.equal(h.prisma.reservations[0].status, 'RELEASED');
  assert.match(h.prisma.txs[0].failureReason, /wrong mint/);
  assert.equal(h.prisma.audits.find((a) => a.action === 'checkout.verification_failed')!.detail.manualReview, true);
});
test('rejects wrong destination', async () => {
  const { h } = await assertRejectedAndNotSettled({ destinationOwner: Keypair.generate().publicKey.toBase58() }, /wrong destination/);
  assert.equal(h.prisma.txs[0].status, 'FAILED');
});
test('rejects wrong source', async () => {
  const { h } = await assertRejectedAndNotSettled({ sourceOwner: Keypair.generate().publicKey.toBase58() }, /wrong source/);
  assert.equal(h.prisma.txs[0].status, 'FAILED');
});
test('rejects underpayment', async () => {
  const { h } = await assertRejectedAndNotSettled({ amountAtomic: 249_999_999n }, /underpayment/);
  assert.equal(h.prisma.txs[0].status, 'FAILED');
});
test('rejects overpayment', async () => {
  const { h } = await assertRejectedAndNotSettled({ amountAtomic: 250_000_001n }, /overpayment/);
  assert.equal(h.prisma.txs[0].status, 'FAILED');
});
test('rejects missing reference', async () => {
  const { h } = await assertRejectedAndNotSettled({ referenceKeys: [] }, /missing reference/);
  assert.equal(h.prisma.txs[0].status, 'FAILED');
});
test('rejects a reference belonging to a different payment', async () => {
  await assertRejectedAndNotSettled({ referenceKeys: [referenceKeyFor('chk_other').toBase58()] }, /missing reference/);
});
test('rejects network mismatch', async () => {
  await assertRejectedAndNotSettled({ network: 'solana-mainnet' }, /network mismatch/);
});
test('rejects a failed on-chain transaction', async () => {
  const { h } = await assertRejectedAndNotSettled({ succeeded: false }, /failed on chain/);
  assert.equal(h.prisma.txs[0].status, 'FAILED');
});

test('not finalized (merely confirmed) does not settle and stays pending', async () => {
  const { h, prepared, signature } = await setup();
  h.chain.transfers.set(signature, transferFor(h, prepared, signature, { finalized: false }));
  const result = await h.verification.verifyAndSettle({ paymentReference: prepared.paymentReference });
  assert.equal(result.outcome, 'PENDING');
  assert.equal(result.pendingKind, 'not_finalized');
  assert.equal(h.prisma.orders[0].status, 'PENDING_PAYMENT');
  assert.equal(h.prisma.txs[0].status, 'CONFIRMED');
  assert.equal(h.prisma.reservations[0].status, 'ACTIVE');
  // later it finalizes and settles
  h.chain.transfers.set(signature, transferFor(h, prepared, signature, { finalized: true }));
  assert.equal((await h.verification.verifyAndSettle({ paymentReference: prepared.paymentReference })).outcome, 'FINALIZED');
  assert.equal(h.prisma.orders[0].status, 'PAID');
});

test('transfer not found yet stays pending without state change', async () => {
  const { h, prepared } = await setup();
  const before = dump(h);
  const result = await h.verification.verifyAndSettle({ paymentReference: prepared.paymentReference });
  assert.equal(result.outcome, 'PENDING');
  assert.equal(result.pendingKind, 'not_found');
  assert.equal(dump(h), before);
});

test('unknown reference/signature is UNKNOWN and changes nothing', async () => {
  const h = makeHarness();
  assert.equal((await h.verification.verifyAndSettle({ paymentReference: 'nope' })).outcome, 'UNKNOWN');
  assert.equal((await h.verification.verifyAndSettle({ signature: 'nope' })).outcome, 'UNKNOWN');
  assert.equal((await h.verification.verifyAndSettle({})).outcome, 'UNKNOWN');
});

test('duplicate and concurrent verification settle exactly once (one PAID transition, one audit)', async () => {
  const { h, prepared, signature } = await setup();
  h.flags.enableLiveFulfillment = true;
  h.chain.transfers.set(signature, transferFor(h, prepared, signature));
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => h.verification.verifyAndSettle({ paymentReference: prepared.paymentReference })));
  assert.equal(results.filter((r) => r.settledNow).length, 1);
  assert.ok(results.every((r) => ['FINALIZED', 'ALREADY_FINALIZED'].includes(r.outcome)));
  assert.equal(h.prisma.audits.filter((a) => a.action === 'checkout.settled').length, 1);
  assert.equal(h.prisma.orders[0].status, 'PAID');
  assert.equal(h.fulfillmentCalls.length, 1, 'fulfillment triggered once');
  const again = await h.verification.verifyAndSettle({ signature });
  assert.equal(again.outcome, 'ALREADY_FINALIZED');
  assert.equal(h.prisma.audits.filter((a) => a.action === 'checkout.settled').length, 1);
  assert.equal((await h.verification.listSettlements()).length, 1);
});

test('order no longer pending at settlement: rolled back, flagged for manual refund, not settled', async () => {
  const { h, prepared, signature } = await setup();
  h.prisma.orders[0].status = 'CANCELLED';
  h.chain.transfers.set(signature, transferFor(h, prepared, signature));
  const result = await h.verification.verifyAndSettle({ paymentReference: prepared.paymentReference });
  assert.equal(result.outcome, 'FAILED');
  assert.match(result.reason!, /manual refund/);
  assert.equal(h.prisma.orders[0].status, 'CANCELLED');
  assert.equal(h.prisma.txs[0].status, 'FAILED');
  assert.equal((await h.verification.listSettlements()).length, 0);
  assert.equal(h.prisma.audits.filter((a) => a.action === 'checkout.settled').length, 0);
});

test('a failed settlement transaction rolls back every write', async () => {
  const { h, prepared, signature } = await setup();
  h.chain.transfers.set(signature, transferFor(h, prepared, signature));
  h.prisma.failOn = (table, op) => {
    if (table === 'walletAuditEvent' && op === 'create') throw new Error('db down');
  };
  await assert.rejects(h.verification.verifyAndSettle({ paymentReference: prepared.paymentReference }), /db down/);
  h.prisma.failOn = null;
  assert.equal(h.prisma.orders[0].status, 'PENDING_PAYMENT');
  assert.equal(h.prisma.txs[0].status, 'SUBMITTED');
  assert.equal(h.prisma.reservations[0].status, 'ACTIVE');
  // and a retry then succeeds
  assert.equal((await h.verification.verifyAndSettle({ paymentReference: prepared.paymentReference })).outcome, 'FINALIZED');
});

test('chain outage during verification leaves state unchanged and maps to 503', async () => {
  const { h, prepared, signature } = await setup();
  h.chain.transfers.set(signature, transferFor(h, prepared, signature));
  const before = dump(h);
  h.chain.unavailable = true;
  await assert.rejects(h.verification.verifyAndSettle({ paymentReference: prepared.paymentReference }), (e: any) => e.getStatus?.() === 503);
  assert.equal(dump(h), before);
});

test('fulfillment is held when enableLiveFulfillment is false, triggered when true', async () => {
  const held = await setup();
  held.h.chain.transfers.set(held.signature, transferFor(held.h, held.prepared, held.signature));
  await held.h.verification.verifyAndSettle({ paymentReference: held.prepared.paymentReference });
  assert.equal(held.h.fulfillmentCalls.length, 0);
  assert.equal(held.h.prisma.orders[0].status, 'PAID');

  const live = await setup();
  live.h.flags.enableLiveFulfillment = true;
  live.h.chain.transfers.set(live.signature, transferFor(live.h, live.prepared, live.signature));
  await live.h.verification.verifyAndSettle({ paymentReference: live.prepared.paymentReference });
  assert.deepEqual(live.h.fulfillmentCalls, [
    { orderId: ORDER_ID, customerId: CUSTOMER_ID, paymentReference: live.prepared.paymentReference, txSignature: live.signature },
  ]);
  assert.equal(live.h.prisma.audits.find((a) => a.action === 'checkout.settled')!.detail.fulfillment, 'TRIGGER_REQUESTED');
});

test('a throwing fulfillment trigger never undoes a settled payment', async () => {
  const { h, prepared, signature } = await setup();
  h.flags.enableLiveFulfillment = true;
  (h.verification as any).fulfillment = { trigger: async () => { throw new Error('warehouse down'); } };
  h.chain.transfers.set(signature, transferFor(h, prepared, signature));
  const result = await h.verification.verifyAndSettle({ paymentReference: prepared.paymentReference });
  assert.equal(result.outcome, 'FINALIZED');
  assert.equal(h.prisma.orders[0].status, 'PAID');
  assert.ok(h.prisma.audits.some((a) => a.action === 'checkout.fulfillment_trigger_failed'));
});

test('credits formula: spendable falls only via the finalized transfer, with no separate deduction', async () => {
  const price = 250_000_000n;
  const { h, prepared, signature } = await setup({ usdc: 1_000_000_000n });
  const cust = h.customer.publicKey.toBase58();
  // submitted but unfinalized: chain balance unchanged; hold is counted once (pending outgoing), not twice.
  let s = await h.spendable();
  assert.equal(s.finalizedAtomic, 1_000_000_000n);
  assert.equal(s.spendableAtomic, 1_000_000_000n - price);

  // no ledger-style rows other than the single PURCHASE
  assert.equal(h.prisma.txs.length, 1);
  assert.deepEqual(h.prisma.txs.map((t) => t.type), ['PURCHASE']);

  // the transfer finalizes on chain: the chain balance drops by exactly the price
  h.chain.usdc.set(cust, 1_000_000_000n - price);
  h.chain.transfers.set(signature, transferFor(h, prepared, signature));
  await h.verification.verifyAndSettle({ paymentReference: prepared.paymentReference });
  s = await h.spendable();
  assert.equal(s.finalizedAtomic, 750_000_000n);
  assert.equal(s.spendableAtomic, 750_000_000n, 'price is deducted exactly once (consumed reservation is not subtracted again)');
  assert.equal(h.prisma.reservations[0].status, 'CONSUMED');
});

test('a failed verification returns the hold: spendable is restored', async () => {
  const { h, prepared, signature } = await setup({ usdc: 1_000_000_000n });
  h.chain.transfers.set(signature, transferFor(h, prepared, signature, { succeeded: false }));
  await h.verification.verifyAndSettle({ paymentReference: prepared.paymentReference });
  const s = await h.spendable();
  assert.equal(s.spendableAtomic, 1_000_000_000n);
});

test('mint constant used for verification is USDC devnet', () => {
  assert.equal(USDC_DEVNET_MINT, '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
});
