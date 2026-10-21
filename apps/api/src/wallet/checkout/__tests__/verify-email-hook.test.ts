import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { RecordingEmail } from '../../../orders/__tests__/recording-email';
import { VerificationService } from '../verification.service';
import { CUSTOMER_ID, ORDER_ID, makeHarness, prepareSignSubmit, transferFor } from './harness';

async function setup(configure: (email: RecordingEmail) => void = () => undefined, opts: Parameters<typeof makeHarness>[0] = {}) {
  const h = makeHarness(opts);
  const email = new RecordingEmail();
  configure(email);
  const verification = new VerificationService(h.prisma as any, h.chain, h.flags, { trigger: async () => undefined }, email);
  const sub = await prepareSignSubmit(h);
  h.chain.transfers.set(sub.signature, transferFor(h, sub.prepared, sub.signature));
  return { h, email, verification, ...sub };
}

test('settling enqueues order_confirmation once, to the customer, with the contract data and dedupeKey', async () => {
  const { h, email, verification, prepared } = await setup();
  const result = await verification.verifyAndSettle({ paymentReference: prepared.paymentReference });
  assert.equal(result.outcome, 'FINALIZED');
  assert.equal(h.prisma.orders[0].status, 'PAID');
  assert.deepEqual(email.sent, [
    { to: 'researcher@example.com', template: 'order_confirmation', dedupeKey: `order_confirmation:${ORDER_ID}`, data: { orderId: ORDER_ID, totalCents: 25_000, currency: 'USD' } },
  ]);
});

test('10 racing verifications of one payment: one settlement, ONE enqueue attempt (not merely one outbox row)', async () => {
  const { h, email, verification, prepared } = await setup();
  const results = await Promise.all(Array.from({ length: 10 }, () => verification.verifyAndSettle({ paymentReference: prepared.paymentReference })));
  assert.equal(results.filter((r) => r.outcome === 'FINALIZED' && r.settledNow).length, 1);
  assert.ok(results.every((r) => r.outcome === 'FINALIZED' || r.outcome === 'ALREADY_FINALIZED'), 'the nine losers see an already-settled payment');
  assert.equal(h.prisma.audits.filter((a) => a.action === 'checkout.settled').length, 1);
  assert.equal(email.attempts.length, 1);
  assert.equal(email.sent.length, 1);
});

test('later duplicate verifications (by reference and by signature) enqueue nothing more', async () => {
  const { email, verification, prepared, signature } = await setup();
  await verification.verifyAndSettle({ paymentReference: prepared.paymentReference });
  await verification.verifyAndSettle({ paymentReference: prepared.paymentReference });
  await verification.verifyAndSettle({ signature });
  assert.equal(email.attempts.length, 1);
});

test('no email for payments that do not settle: pending, failed transfer, wrong amount', async () => {
  const pending = await setup();
  pending.h.chain.transfers.set(pending.signature, transferFor(pending.h, pending.prepared, pending.signature, { finalized: false }));
  assert.equal((await pending.verification.verifyAndSettle({ paymentReference: pending.prepared.paymentReference })).outcome, 'PENDING');
  assert.equal(pending.email.attempts.length, 0);

  const wrong = await setup();
  wrong.h.chain.transfers.set(wrong.signature, transferFor(wrong.h, wrong.prepared, wrong.signature, { amountAtomic: 1n }));
  assert.equal((await wrong.verification.verifyAndSettle({ paymentReference: wrong.prepared.paymentReference })).outcome, 'FAILED');
  assert.equal(wrong.email.attempts.length, 0);

  const failed = await setup();
  failed.h.chain.transfers.set(failed.signature, transferFor(failed.h, failed.prepared, failed.signature, { succeeded: false }));
  assert.equal((await failed.verification.verifyAndSettle({ paymentReference: failed.prepared.paymentReference })).outcome, 'FAILED');
  assert.equal(failed.email.attempts.length, 0);
});

test('an order that cannot be marked paid (cancelled meanwhile) sends no confirmation', async () => {
  const { h, email, verification, prepared } = await setup();
  h.prisma.orders[0].status = 'CANCELLED';
  const result = await verification.verifyAndSettle({ paymentReference: prepared.paymentReference });
  assert.equal(result.outcome, 'FAILED');
  assert.equal(email.attempts.length, 0);
});

test('hook failure never fails or undoes settlement: reject, throw synchronously, hang', async () => {
  for (const mode of ['reject', 'throw', 'hang'] as const) {
    const { h, email, verification, prepared } = await setup((e) => {
      if (mode === 'hang') e.hang = true;
      else {
        e.failWith = new Error('outbox down');
        e.sync = mode === 'throw';
      }
    });
    const started = Date.now();
    const result = await verification.verifyAndSettle({ paymentReference: prepared.paymentReference });
    assert.equal(result.outcome, 'FINALIZED', mode);
    assert.equal(result.settledNow, true, mode);
    assert.equal(h.prisma.orders[0].status, 'PAID', mode);
    assert.equal(h.prisma.txs[0].status, 'FINALIZED', mode);
    assert.equal(h.prisma.audits.filter((a) => a.action === 'checkout.settled').length, 1, mode);
    assert.equal(email.attempts.length, 1, mode);
    assert.ok(Date.now() - started < 1500, `${mode} delayed settlement`);
  }
});

test('a customer with no email row, or a missing port, settles normally and sends nothing', async () => {
  const { h, email, verification, prepared } = await setup();
  h.prisma.tables.customer.splice(0, h.prisma.tables.customer.length, ...h.prisma.tables.customer.filter((c) => c.id !== CUSTOMER_ID));
  assert.equal((await verification.verifyAndSettle({ paymentReference: prepared.paymentReference })).outcome, 'FINALIZED');
  assert.equal(email.attempts.length, 0);

  const bare = makeHarness();
  const sub = await prepareSignSubmit(bare);
  bare.chain.transfers.set(sub.signature, transferFor(bare, sub.prepared, sub.signature));
  assert.equal((await bare.verification.verifyAndSettle({ paymentReference: sub.prepared.paymentReference })).outcome, 'FINALIZED');
});
