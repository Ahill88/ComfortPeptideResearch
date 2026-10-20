import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AmbiguousTransferError } from '../../chain/devnet-solana-chain';
import { AMBIGUOUS_TRANSFER_REASON } from '../verification.service';
import { CUSTOMER_ID, ORDER_ID, makeHarness, prepareSignSubmit, transferFor } from './harness';

const MIN = 60_000;

test('reconcile finalizes submitted purchases older than a minute and skips fresh ones', async () => {
  const h = makeHarness();
  const { prepared, signature } = await prepareSignSubmit(h);
  h.chain.transfers.set(signature, transferFor(h, prepared, signature));

  let summary = await h.recon.reconcile();
  assert.deepEqual(summary, { checked: 0, finalized: 0, failed: 0, expired: 0, unavailable: 0 }, 'too fresh');
  assert.equal(h.prisma.orders[0].status, 'PENDING_PAYMENT');

  h.prisma.txs[0].createdAt = new Date(Date.now() - 2 * MIN);
  summary = await h.recon.reconcile();
  assert.deepEqual(summary, { checked: 1, finalized: 1, failed: 0, expired: 0, unavailable: 0 });
  assert.equal(h.prisma.orders[0].status, 'PAID');

  summary = await h.recon.reconcile();
  assert.equal(summary.checked, 0, 'FINALIZED rows are not re-checked');
  assert.equal(h.prisma.audits.filter((a) => a.action === 'checkout.settled').length, 1);
});

test('reconcile records failures', async () => {
  const h = makeHarness();
  const { prepared, signature } = await prepareSignSubmit(h);
  h.chain.transfers.set(signature, transferFor(h, prepared, signature, { amountAtomic: 1n }));
  h.prisma.txs[0].createdAt = new Date(Date.now() - 2 * MIN);
  const summary = await h.recon.reconcile();
  assert.deepEqual(summary, { checked: 1, finalized: 0, failed: 1, expired: 0, unavailable: 0 });
  assert.equal(h.prisma.txs[0].status, 'FAILED');
  assert.equal(h.prisma.orders[0].status, 'PENDING_PAYMENT');
});

test('reconcile counts outages and changes nothing', async () => {
  const h = makeHarness();
  const { prepared, signature } = await prepareSignSubmit(h);
  h.chain.transfers.set(signature, transferFor(h, prepared, signature));
  h.prisma.txs[0].createdAt = new Date(Date.now() - 2 * MIN);
  h.chain.unavailable = true;
  const summary = await h.recon.reconcile();
  assert.deepEqual(summary, { checked: 1, finalized: 0, failed: 0, expired: 0, unavailable: 1 });
  assert.equal(h.prisma.txs[0].status, 'SUBMITTED');
  assert.equal(h.prisma.reservations[0].status, 'ACTIVE');
  assert.equal(h.prisma.orders[0].status, 'PENDING_PAYMENT');
});

test('reconcile expires ACTIVE reservations past expiry and unsubmitted PREPARED rows', async () => {
  const h = makeHarness();
  await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  assert.equal((await h.recon.reconcile()).expired, 0, 'still live');
  h.prisma.reservations[0].expiresAt = new Date(Date.now() - 1000);
  const summary = await h.recon.reconcile();
  assert.equal(summary.expired, 2, 'one reservation + one purchase row');
  assert.equal(h.prisma.reservations[0].status, 'EXPIRED');
  assert.equal(h.prisma.txs[0].status, 'EXPIRED');
  assert.equal((await h.recon.reconcile()).expired, 0, 'idempotent');
  // spendable is restored
  assert.equal((await h.spendable()).spendableAtomic, 1_000_000_000n);
});

test('reconcile does not expire a reservation with a submitted payment still in flight', async () => {
  const h = makeHarness();
  await prepareSignSubmit(h);
  h.prisma.reservations[0].expiresAt = new Date(Date.now() - 1000);
  const summary = await h.recon.reconcile(); // createdAt is fresh so nothing is verified either
  assert.equal(summary.expired, 0);
  assert.equal(h.prisma.reservations[0].status, 'ACTIVE');
  assert.equal(h.prisma.txs[0].status, 'SUBMITTED');
});

test('reconcile expires a never-landed submission only after the reservation TTL', async () => {
  const h = makeHarness();
  await prepareSignSubmit(h);
  h.prisma.txs[0].createdAt = new Date(Date.now() - 5 * MIN);
  let summary = await h.recon.reconcile();
  assert.deepEqual(summary, { checked: 1, finalized: 0, failed: 0, expired: 0, unavailable: 0 });
  assert.equal(h.prisma.txs[0].status, 'SUBMITTED');

  h.prisma.txs[0].createdAt = new Date(Date.now() - 20 * MIN);
  h.prisma.reservations[0].expiresAt = new Date(Date.now() - 5 * MIN);
  summary = await h.recon.reconcile();
  assert.equal(summary.checked, 1);
  assert.equal(summary.expired, 1);
  assert.equal(h.prisma.txs[0].status, 'EXPIRED');
  assert.equal(h.prisma.reservations[0].status, 'EXPIRED');
  assert.equal(h.prisma.orders[0].status, 'PENDING_PAYMENT');
});

test('a landed transaction whose transfer cannot be parsed is flagged for manual review, never expired, failed or settled', async () => {
  const h = makeHarness();
  const { prepared, signature } = await prepareSignSubmit(h);
  h.chain.transferError = new AmbiguousTransferError(signature, '2 spl-token transfers found; exactly one is required');
  // Far past the reservation TTL: a plain "not found" row would be expired by now.
  h.prisma.txs[0].createdAt = new Date(Date.now() - 60 * MIN);
  h.prisma.reservations[0].expiresAt = new Date(Date.now() - 30 * MIN);

  const summary = await h.recon.reconcile();
  assert.deepEqual(summary, { checked: 1, finalized: 0, failed: 0, expired: 0, unavailable: 0 });
  assert.equal(h.prisma.txs[0].status, 'SUBMITTED', 'row and signature are kept');
  assert.equal(h.prisma.txs[0].txSignature, signature);
  assert.equal(h.prisma.reservations[0].status, 'ACTIVE', 'the reservation is not released, so the customer cannot pay again');
  assert.equal(h.prisma.orders[0].status, 'PENDING_PAYMENT');
  const flags = h.prisma.audits.filter((a) => a.action === 'checkout.manual_review');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].detail.manualReview, true);
  assert.equal(flags[0].detail.reference, prepared.paymentReference);
  assert.equal(flags[0].detail.txSignature, signature);
  assert.equal(h.prisma.audits.filter((a) => a.action === 'checkout.submission_expired').length, 0);

  // Idempotent: repeated runs do not pile up audit events and still never expire it.
  await h.recon.reconcile();
  await h.recon.reconcile();
  assert.equal(h.prisma.audits.filter((a) => a.action === 'checkout.manual_review').length, 1);
  assert.equal(h.prisma.txs[0].status, 'SUBMITTED');

  // Re-preparing stays blocked while it is held for review.
  await assert.rejects(h.checkout.prepare(CUSTOMER_ID, ORDER_ID), (e: any) => e.getStatus?.() === 409);

  // Once the chain can read it again (operator fixed RPC / data), it settles normally.
  h.chain.transferError = null;
  h.chain.transfers.set(signature, transferFor(h, prepared, signature));
  assert.equal((await h.recon.reconcile()).finalized, 1);
  assert.equal(h.prisma.orders[0].status, 'PAID');
});

test('verification reports an ambiguous landed transfer as PENDING with the manual-review reason (no pendingKind, no state change)', async () => {
  const h = makeHarness();
  const { prepared, signature } = await prepareSignSubmit(h);
  h.chain.transferError = new AmbiguousTransferError(signature, 'Token-2022 instructions are not supported');
  const before = JSON.stringify(h.prisma.tables, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  const result = await h.verification.verifyAndSettle({ paymentReference: prepared.paymentReference });
  assert.equal(result.outcome, 'PENDING');
  assert.equal(result.reason, AMBIGUOUS_TRANSFER_REASON);
  assert.equal(result.pendingKind, undefined, 'must never look like not_found');
  assert.equal(JSON.stringify(h.prisma.tables, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)), before);
});
