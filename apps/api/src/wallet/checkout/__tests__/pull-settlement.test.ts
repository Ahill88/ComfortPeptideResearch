/**
 * Pull-driven settlement: a best-effort kick after a successful broadcast, and a verify-then-read in status().
 * verifyAndSettle stays the only settlement path, so every safety check and exactly-once guarantee still applies.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Transaction } from '@solana/web3.js';
import { ChainRejectedError } from '../../chain/chain-errors';
import { ChainUnavailableError } from '../../contracts';
import { CUSTOMER_ID, ORDER_ID, makeHarness, prepareSignSubmit, signAs, signatureOf, transferFor, type Harness } from './harness';

const rejects = (promise: Promise<unknown>, status: number) =>
  assert.rejects(promise, (e: any) => {
    assert.equal(e.getStatus?.(), status, `expected HTTP ${status}, got ${e.getStatus?.()} (${e.message})`);
    return true;
  });

const harness = (options: Parameters<typeof makeHarness>[0] = {}) => makeHarness({ ...options, pullSettlement: true });

/** Counts verifyAndSettle calls while delegating to the real implementation. */
function spyVerify(h: Harness) {
  const calls: Array<{ paymentReference?: string; signature?: string }> = [];
  const original = h.verification.verifyAndSettle.bind(h.verification);
  h.verification.verifyAndSettle = async (input) => {
    calls.push(input);
    return original(input);
  };
  return calls;
}

async function waitFor(condition: () => boolean, label: string) {
  for (let i = 0; i < 500; i++) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for: ${label}`);
}

/** prepare + sign (without submitting), pre-registering the finalized on-chain transfer for the signature. */
async function prepareSigned(h: Harness, overrides: Parameters<typeof transferFor>[3] = {}) {
  const prepared = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  const signed = signAs(prepared.unsignedTransactionBase64, h.customer);
  const signature = signatureOf(signed);
  h.chain.transfers.set(signature, transferFor(h, prepared, signature, overrides));
  return { prepared, signed, signature };
}

const settledAudits = (h: Harness) => h.prisma.audits.filter((a) => a.action === 'checkout.settled').length;
const snapshot = (h: Harness) => structuredClone(h.prisma.tables);

// -------------------------------------------------------------------------------------------------
// (a) post-submit kick
// -------------------------------------------------------------------------------------------------

test('submit kicks settlement: the order becomes PAID without waiting for reconciliation', async () => {
  const h = harness();
  h.flags.enableLiveFulfillment = true;
  const { signed, signature } = await prepareSigned(h);
  const submitted = await h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed);
  assert.equal(submitted.status, 'SUBMITTED', 'the response itself still reports SUBMITTED');
  assert.equal(submitted.txSignature, signature);

  await waitFor(() => h.prisma.orders[0].status === 'PAID', 'order PAID');
  assert.equal(h.prisma.txs[0].status, 'FINALIZED');
  assert.equal(h.prisma.reservations[0].status, 'CONSUMED');
  assert.equal(settledAudits(h), 1);
  assert.equal(h.fulfillmentCalls.length, 1);
  assert.equal((await h.recon.reconcile(new Date(Date.now() + 10 * 60_000))).checked, 0, 'nothing left for the scheduler');
  assert.equal(settledAudits(h), 1);
});

test('kick of a not-yet-finalized transfer changes nothing but CONFIRMED, never settles', async () => {
  const h = harness();
  const { signed } = await prepareSigned(h, { finalized: false });
  await h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed);
  await waitFor(() => h.prisma.txs[0].status === 'CONFIRMED', 'CONFIRMED');
  assert.equal(h.prisma.orders[0].status, 'PENDING_PAYMENT');
  assert.equal(settledAudits(h), 0);
});

test('kick of a mismatched transfer fails closed exactly as verification does (underpayment is not settled)', async () => {
  const h = harness();
  const prepared = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  const signed = signAs(prepared.unsignedTransactionBase64, h.customer);
  const signature = signatureOf(signed);
  h.chain.transfers.set(signature, transferFor(h, prepared, signature, { amountAtomic: BigInt(prepared.amountAtomic) - 1n }));
  await h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed);
  await waitFor(() => h.prisma.txs[0].status === 'FAILED', 'FAILED');
  assert.match(h.prisma.txs[0].failureReason, /underpayment/);
  assert.equal(h.prisma.orders[0].status, 'PENDING_PAYMENT');
  assert.equal(settledAudits(h), 0);
});

test('kick errors (RPC outage, unexpected, synchronous throw) are swallowed: submit still succeeds', async () => {
  for (const failure of [
    () => Promise.reject(new ChainUnavailableError()),
    () => Promise.reject(new Error('boom')),
    () => {
      throw new Error('sync boom');
    },
  ]) {
    const h = harness();
    const { signed } = await prepareSigned(h);
    const calls = spyVerify(h);
    h.verification.verifyAndSettle = async (input) => {
      calls.push(input);
      return failure() as any;
    };
    const submitted = await h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed);
    assert.equal(submitted.status, 'SUBMITTED');
    await waitFor(() => calls.length === 1, 'kick attempted');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.prisma.txs[0].status, 'SUBMITTED', 'state untouched; reconciliation/status will retry');
    assert.equal(h.prisma.orders[0].status, 'PENDING_PAYMENT');
  }
});

test('an RPC outage right after broadcast leaves SUBMITTED and a later status poll settles it', async () => {
  const h = harness();
  const { signed } = await prepareSigned(h);
  const original = h.chain.getTransfer.bind(h.chain);
  h.chain.getTransfer = async () => {
    throw new ChainUnavailableError();
  };
  await h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.prisma.txs[0].status, 'SUBMITTED');
  h.chain.getTransfer = original;
  assert.equal((await h.checkout.status(CUSTOMER_ID, ORDER_ID)).orderStatus, 'PAID');
});

test('the kick never delays the submit response (a hanging verification does not block it)', async () => {
  const h = harness();
  const { signed } = await prepareSigned(h);
  let started = false;
  h.verification.verifyAndSettle = () => {
    started = true;
    return new Promise(() => undefined);
  };
  const outcome = await Promise.race([
    h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1000).unref()),
  ]);
  assert.notEqual(outcome, 'timeout');
  assert.equal((outcome as any).status, 'SUBMITTED');
  await waitFor(() => started, 'kick started in the background');
});

test('no kick when the submit response failed (rejected signature, tampered tx, broadcast error, outage)', async () => {
  // unsigned
  let h = harness();
  let calls = spyVerify(h);
  const prepared = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  await rejects(h.checkout.submit(CUSTOMER_ID, ORDER_ID, prepared.unsignedTransactionBase64), 400);
  // customer-signed but tampered (different amount): does not match the prepared message
  const tampered = Transaction.from(Buffer.from(prepared.unsignedTransactionBase64, 'base64'));
  tampered.instructions[0].data.writeBigUInt64LE(1n, 1);
  tampered.sign(h.customer);
  await rejects(h.checkout.submit(CUSTOMER_ID, ORDER_ID, tampered.serialize().toString('base64')), 400);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0);

  // chain rejects the broadcast
  h = harness();
  calls = spyVerify(h);
  h.chain.broadcastError = new ChainRejectedError('rejected');
  const p2 = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  await rejects(h.checkout.submit(CUSTOMER_ID, ORDER_ID, signAs(p2.unsignedTransactionBase64, h.customer)), 502);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0);
  assert.equal(h.prisma.txs[0].status, 'PREPARED');

  // RPC outage on broadcast
  h = harness();
  calls = spyVerify(h);
  h.chain.broadcastError = new ChainUnavailableError();
  const p3 = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  await rejects(h.checkout.submit(CUSTOMER_ID, ORDER_ID, signAs(p3.unsignedTransactionBase64, h.customer)), 503);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0);
});

test('the kick verifies only the payment that was just broadcast, by reference', async () => {
  const h = harness();
  const { prepared, signed } = await prepareSigned(h);
  const calls = spyVerify(h);
  await h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed);
  await waitFor(() => calls.length >= 1, 'kick');
  assert.deepEqual(calls, [{ paymentReference: prepared.paymentReference }]);
});

// -------------------------------------------------------------------------------------------------
// (b) status() verifies in-flight payments first
// -------------------------------------------------------------------------------------------------

/** Submitted with the kick neutralized, so status() is what settles. */
async function submittedAwaitingStatus(options: { finalized?: boolean } = {}) {
  const h = harness();
  const { signed, signature, prepared } = await prepareSigned(h, options.finalized === false ? { finalized: false } : {});
  const kick = h.verification.verifyAndSettle;
  h.verification.verifyAndSettle = async () => ({ outcome: 'PENDING', reason: 'kick disabled for this test' }) as any;
  await h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed);
  await new Promise((resolve) => setImmediate(resolve));
  h.verification.verifyAndSettle = kick;
  assert.equal(h.prisma.txs[0].status, 'SUBMITTED');
  return { h, signature, prepared };
}

test('status settles a SUBMITTED finalized payment and returns the fresh PAID state', async () => {
  const { h, signature } = await submittedAwaitingStatus();
  const status = await h.checkout.status(CUSTOMER_ID, ORDER_ID);
  assert.equal(status.orderStatus, 'PAID');
  assert.equal(status.payment?.status, 'FINALIZED');
  assert.equal(status.payment?.txSignature, signature);
  assert.ok(status.payment?.finalizedAt);
  assert.equal(status.reservation?.status, 'CONSUMED');
  assert.equal(settledAudits(h), 1);
});

test('status also settles a CONFIRMED payment', async () => {
  const { h } = await submittedAwaitingStatus();
  h.prisma.txs[0].status = 'CONFIRMED';
  assert.equal((await h.checkout.status(CUSTOMER_ID, ORDER_ID)).orderStatus, 'PAID');
});

test('status never settles a confirmed-but-not-finalized or mismatching transfer', async () => {
  const pending = await submittedAwaitingStatus({ finalized: false });
  const status = await pending.h.checkout.status(CUSTOMER_ID, ORDER_ID);
  assert.equal(status.orderStatus, 'PENDING_PAYMENT');
  assert.notEqual(status.payment?.status, 'FINALIZED');
  assert.equal(settledAudits(pending.h), 0);

  const wrong = await submittedAwaitingStatus();
  wrong.h.chain.transfers.set(wrong.signature, { ...wrong.h.chain.transfers.get(wrong.signature)!, destinationOwner: wrong.h.stranger.publicKey.toBase58() });
  const failed = await wrong.h.checkout.status(CUSTOMER_ID, ORDER_ID);
  assert.equal(failed.orderStatus, 'PENDING_PAYMENT');
  assert.equal(failed.payment?.status, 'FAILED');
  assert.match(failed.payment?.failureReason ?? '', /wrong destination/);
  assert.equal(settledAudits(wrong.h), 0);
});

test('repeated status polls settle exactly once (one PAID transition, one audit, fulfillment once)', async () => {
  const { h } = await submittedAwaitingStatus();
  h.flags.enableLiveFulfillment = true;
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await h.checkout.status(CUSTOMER_ID, ORDER_ID));
  assert.ok(results.every((r) => r.orderStatus === 'PAID' && r.payment?.status === 'FINALIZED'));
  assert.equal(h.prisma.orders[0].status, 'PAID');
  assert.equal(h.prisma.txs.filter((t) => t.status === 'FINALIZED').length, 1);
  assert.equal(settledAudits(h), 1);
  assert.equal(h.fulfillmentCalls.length, 1);
});

test('concurrent polls across service instances, the kick and reconciliation settle exactly once', async () => {
  const { h } = await submittedAwaitingStatus();
  h.flags.enableLiveFulfillment = true;
  // Separate CheckoutService instances do not share the in-process single-flight, so this exercises the
  // database-level compare-and-set in VerificationService.
  const instances = [h.checkout, h.makeCheckout(), h.makeCheckout(), h.makeCheckout()];
  const results = await Promise.all([
    ...instances.flatMap((c) => [c.status(CUSTOMER_ID, ORDER_ID), c.status(CUSTOMER_ID, ORDER_ID)]),
    h.verification.verifyAndSettle({ paymentReference: h.prisma.txs[0].reference }),
    h.recon.reconcile(new Date(Date.now() + 10 * 60_000)),
  ]);
  for (const r of results.slice(0, 8) as any[]) {
    assert.equal(r.orderStatus, 'PAID');
    assert.equal(r.payment.status, 'FINALIZED');
  }
  assert.equal(h.prisma.orders[0].status, 'PAID');
  assert.equal(h.prisma.txs.filter((t) => t.status === 'FINALIZED').length, 1);
  assert.equal(settledAudits(h), 1, 'exactly one settlement audit record');
  assert.equal(h.fulfillmentCalls.length, 1, 'fulfillment hook fires at most once');
  assert.equal(h.prisma.reservations[0].status, 'CONSUMED');
});

test('concurrent polls on ONE instance share a single verification (no RPC amplification)', async () => {
  const { h } = await submittedAwaitingStatus();
  const calls = spyVerify(h);
  const results = await Promise.all(Array.from({ length: 10 }, () => h.checkout.status(CUSTOMER_ID, ORDER_ID)));
  assert.ok(results.every((r) => r.orderStatus === 'PAID'));
  assert.equal(calls.length, 1);
  assert.equal(settledAudits(h), 1);
});

test('an RPC outage during status leaves state unchanged and returns the pre-existing state (no 503)', async () => {
  const { h, signature } = await submittedAwaitingStatus();
  h.chain.unavailable = true;
  const before = snapshot(h);
  const status = await h.checkout.status(CUSTOMER_ID, ORDER_ID); // must not throw
  assert.equal(status.orderStatus, 'PENDING_PAYMENT');
  assert.equal(status.payment?.status, 'SUBMITTED');
  assert.equal(status.payment?.txSignature, signature);
  assert.equal(status.payment?.finalizedAt, null);
  assert.equal(status.reservation?.status, 'ACTIVE');
  assert.deepEqual(h.prisma.tables, before, 'no row changed and no audit was written');

  // also when the failure surfaces as the service-level 503 or a raw chain error
  for (const error of [new ChainUnavailableError(), new (await import('@nestjs/common')).ServiceUnavailableException('rpc')]) {
    h.verification.verifyAndSettle = async () => {
      throw error;
    };
    assert.equal((await h.checkout.status(CUSTOMER_ID, ORDER_ID)).payment?.status, 'SUBMITTED');
  }

  // recovery: once the RPC is back the next poll settles
  h.chain.unavailable = false;
  h.verification.verifyAndSettle = VerificationProto(h);
  assert.equal((await h.checkout.status(CUSTOMER_ID, ORDER_ID)).orderStatus, 'PAID');
  assert.equal(settledAudits(h), 1);
});

function VerificationProto(h: Harness) {
  return Object.getPrototypeOf(h.verification).verifyAndSettle.bind(h.verification);
}

test('an unexpected refresh error does not turn a status read into a failure', async () => {
  const { h } = await submittedAwaitingStatus();
  h.verification.verifyAndSettle = async () => {
    throw new Error('unexpected');
  };
  const status = await h.checkout.status(CUSTOMER_ID, ORDER_ID);
  assert.equal(status.payment?.status, 'SUBMITTED');
  assert.equal(status.orderStatus, 'PENDING_PAYMENT');
});

test('ownership: a different customer (or a missing order) gets 404 and triggers no verification', async () => {
  const { h } = await submittedAwaitingStatus();
  const calls = spyVerify(h);
  const before = snapshot(h);
  await rejects(h.checkout.status('cust_2', ORDER_ID), 404);
  await rejects(h.checkout.status(CUSTOMER_ID, 'no-such-order'), 404);
  await rejects(h.checkout.status('cust_unknown', ORDER_ID), 404);
  assert.equal(calls.length, 0);
  assert.deepEqual(h.prisma.tables, before);
  // the rightful owner can
  assert.equal((await h.checkout.status(CUSTOMER_ID, ORDER_ID)).orderStatus, 'PAID');
});

test('status does not verify when nothing is in flight (no payment, PREPARED, FINALIZED)', async () => {
  const h = harness();
  const calls = spyVerify(h);
  assert.equal((await h.checkout.status(CUSTOMER_ID, ORDER_ID)).payment, null);
  await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  assert.equal((await h.checkout.status(CUSTOMER_ID, ORDER_ID)).payment?.status, 'PREPARED');
  assert.equal(calls.length, 0);

  const done = await submittedAwaitingStatus();
  await done.h.checkout.status(CUSTOMER_ID, ORDER_ID);
  const doneCalls = spyVerify(done.h);
  assert.equal((await done.h.checkout.status(CUSTOMER_ID, ORDER_ID)).payment?.status, 'FINALIZED');
  assert.equal(doneCalls.length, 0);
});

test('a CheckoutService without a verification service keeps the previous read-only status behavior', async () => {
  const h = makeHarness(); // pullSettlement off
  const { signature, prepared } = await prepareSignSubmit(h);
  h.chain.transfers.set(signature, transferFor(h, prepared, signature));
  const status = await h.checkout.status(CUSTOMER_ID, ORDER_ID);
  assert.equal(status.payment?.status, 'SUBMITTED');
  assert.equal(status.orderStatus, 'PENDING_PAYMENT');
});

test('Nest DI injects VerificationService into CheckoutService (pull settlement is wired in the real module)', async () => {
  const { Test } = await import('@nestjs/testing');
  const { PrismaService } = await import('../../../prisma.service');
  const { CheckoutModule } = await import('../checkout.module');
  const { CheckoutService } = await import('../checkout.service');
  const { VerificationService } = await import('../verification.service');
  const ports = await import('../ports');
  const h = makeHarness();
  const moduleRef = await Test.createTestingModule({
    imports: [
      CheckoutModule.register({
        providers: [
          { provide: PrismaService, useValue: h.prisma },
          { provide: ports.CHAIN_PORT, useValue: h.chain },
          { provide: ports.BALANCE_PORT, useValue: { getSpendable: async () => ({ finalizedAtomic: 0n, spendableAtomic: 0n, researchCredits: 0n, stale: false }) } },
          { provide: ports.WALLET_LOOKUP_PORT, useValue: { getWallet: async () => null } },
          { provide: ports.FULFILLMENT_PORT, useValue: { trigger: async () => undefined } },
          { provide: ports.WALLET_FLAGS, useValue: h.flags },
        ],
      }),
    ],
  }).compile();
  const checkout = moduleRef.get(CheckoutService) as any;
  assert.ok(checkout.verification instanceof VerificationService);
  assert.equal(checkout.verification, moduleRef.get(VerificationService));
  await moduleRef.close();
});
