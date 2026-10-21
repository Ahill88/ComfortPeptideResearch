/**
 * Refunds engine additions for the owner workflow (no database): PROCESSING orders are refundable, SHIPPED/DELIVERED are not, the order
 * hook runs inside the finalize transaction exactly once and only for the call that flipped the order, and the submit claim cannot race a
 * shipment. The ORIGINAL engine behaviour is covered, untouched, by apps/api/src/wallet/refunds/__tests__.
 *
 *   pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only ../../tests/refunds/refund-engine-states.test.ts
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ORDER_ID, makeHarness, type Harness } from '../../apps/api/src/wallet/refunds/__tests__/harness';
import type { RefundOrderHook } from '../../apps/api/src/wallet/refunds/refund-order-hook';
import { RefundsService } from '../../apps/api/src/wallet/refunds/refunds.service';
import { ACTIVE_REFUND_STATUSES, currentRefund, toAdminRefund, withRefundAction, type RefundRow } from '../../apps/api/src/admin/orders/admin-order-refund.view';

const rejects = (promise: Promise<unknown>, status: number, match?: RegExp) =>
  assert.rejects(promise, (e: any) => {
    assert.equal(e.getStatus?.(), status, `expected HTTP ${status}, got ${e.getStatus?.()} (${e.message})`);
    if (match) assert.match(e.message, match);
    return true;
  });

interface HookCall {
  orderId: string;
  fromStatus: string;
  refundId: string;
  txSignature: string | null;
  insideTransaction: boolean;
}

/** A service wired like the app (hook bound) over the harness doubles. */
function withHook(h: Harness, behaviour: { fail?: boolean } = {}) {
  const calls: HookCall[] = [];
  const hook: RefundOrderHook = {
    async onOrderRefunded(tx, info) {
      // Inside the transaction the order already shows REFUNDED, a read outside would not (serialized mode: still the old value)
      const seen = await (tx as any).order.findUnique({ where: { id: info.orderId } });
      calls.push({ ...info, insideTransaction: seen.status === 'REFUNDED' });
      if (behaviour.fail) throw new Error('hook failed');
    },
  };
  const service = new RefundsService(h.prisma as any, h.chain, h.signer, hook);
  return { service, calls };
}

const order = (h: Harness) => h.prisma.orders[0];

for (const status of ['PAID', 'PROCESSING'] as const) {
  test(`${status}: request, submit and verify work; the order becomes REFUNDED and the hook sees fromStatus ${status}`, async () => {
    const h = makeHarness({ orderStatus: status });
    const { service, calls } = withHook(h);
    const requested = await service.requestRefund(ORDER_ID, undefined, 'x', 'admin-1');
    assert.equal(order(h).status, status, 'the order does not move until the refund finalizes');
    const submitted = await service.prepareAndSubmit(requested.refundId);
    assert.equal(submitted.status, 'SUBMITTED');
    assert.equal(h.signer.calls.length, 1);
    h.land(submitted);
    const verified = await service.verifyRefund(requested.refundId);
    assert.equal(verified.outcome, 'FINALIZED');
    assert.equal(verified.orderRefunded, true);
    assert.equal(order(h).status, 'REFUNDED');
    assert.equal(calls.length, 1);
    assert.deepEqual({ ...calls[0], insideTransaction: undefined }, { orderId: ORDER_ID, fromStatus: status, refundId: requested.refundId, txSignature: submitted.txSignature, insideTransaction: undefined });
    assert.equal(calls[0].insideTransaction, true, 'the hook runs after the flip, inside the same transaction');
  });
}

test('SHIPPED and DELIVERED orders cannot be requested; a refund requested earlier cannot be submitted once the order shipped (nothing signed)', async () => {
  for (const status of ['SHIPPED', 'DELIVERED']) {
    const h = makeHarness({ orderStatus: status });
    await rejects(h.service.requestRefund(ORDER_ID, undefined, 'x', 'admin-1'), 409, /PAID or PROCESSING/);
    assert.equal(h.prisma.refunds.length, 0);
  }
  const h = makeHarness({ orderStatus: 'PROCESSING' });
  const requested = await h.service.requestRefund(ORDER_ID, undefined, 'x', 'admin-1');
  order(h).status = 'SHIPPED';
  await rejects(h.service.prepareAndSubmit(requested.refundId), 409, /PAID or PROCESSING/);
  assert.equal(h.signer.calls.length, 0);
  assert.equal(h.chain.broadcasts.length, 0);
  assert.equal(h.prisma.refunds[0].status, 'PREPARED');
});

test('an order that ships while the signer is signing is caught at the claim: 409, nothing broadcast, the refund stays PREPARED', async () => {
  const h = makeHarness({ orderStatus: 'PROCESSING' });
  const requested = await h.service.requestRefund(ORDER_ID, undefined, 'x', 'admin-1');
  const original = h.signer.signTransaction.bind(h.signer);
  h.signer.signTransaction = async (unsigned, context) => {
    order(h).status = 'SHIPPED'; // the owner ships during the signing round trip
    return original(unsigned, context);
  };
  await rejects(h.service.prepareAndSubmit(requested.refundId), 409, /PAID or PROCESSING/);
  assert.equal(h.chain.broadcasts.length, 0);
  assert.equal(h.prisma.refunds[0].status, 'PREPARED');
  assert.equal(h.prisma.refunds[0].txSignature, null);
});

test('concurrent verifies call the hook exactly once (serialized and concurrent transactions, separate service instances)', async () => {
  for (const mode of ['serialized', 'concurrent'] as const) {
    const h = makeHarness({ orderStatus: 'PROCESSING', mode });
    const a = withHook(h);
    const b = withHook(h);
    const requested = await a.service.requestRefund(ORDER_ID, undefined, 'x', 'admin-1');
    h.land(await a.service.prepareAndSubmit(requested.refundId));
    const results = await Promise.all([a.service, b.service, a.service, b.service].map((s) => s.verifyRefund(requested.refundId)));
    assert.equal(results.filter((r) => r.orderRefunded).length, 1, `${mode}: one call flips the order`);
    assert.equal(a.calls.length + b.calls.length, 1, `${mode}: the hook ran once`);
    assert.equal(order(h).status, 'REFUNDED');
  }
});

test('a partial refund does not flip the order or call the hook; the completing refund does, once', async () => {
  const h = makeHarness();
  const { service, calls } = withHook(h);
  const half = await service.requestRefund(ORDER_ID, 100_000_000n, 'x', 'admin-1');
  h.land(await service.prepareAndSubmit(half.refundId));
  await service.verifyRefund(half.refundId);
  assert.equal(order(h).status, 'PAID');
  assert.equal(calls.length, 0);
  const rest = await service.requestRefund(ORDER_ID, undefined, 'x', 'admin-1');
  h.land(await service.prepareAndSubmit(rest.refundId));
  await service.verifyRefund(rest.refundId);
  assert.equal(order(h).status, 'REFUNDED');
  assert.equal(calls.length, 1);
});

test('a failing hook rolls the whole finalize back: refund stays SUBMITTED, order unchanged; a later verify with a working hook completes it', async () => {
  const h = makeHarness({ orderStatus: 'PROCESSING' });
  const broken = withHook(h, { fail: true });
  const requested = await broken.service.requestRefund(ORDER_ID, undefined, 'x', 'admin-1');
  h.land(await broken.service.prepareAndSubmit(requested.refundId));
  await assert.rejects(broken.service.verifyRefund(requested.refundId), /hook failed/);
  assert.equal(order(h).status, 'PROCESSING');
  assert.equal(h.prisma.refunds[0].status, 'SUBMITTED');
  assert.equal(h.prisma.refunds[0].finalizedAt, null);
  assert.equal(h.prisma.audits.filter((a) => a.action === 'refund.finalized').length, 0);
  const fixed = withHook(h);
  const done = await fixed.service.verifyRefund(requested.refundId);
  assert.equal(done.outcome, 'FINALIZED');
  assert.equal(order(h).status, 'REFUNDED');
  assert.equal(fixed.calls.length, 1);
});

test('a refund that finalizes after the order shipped still flips to REFUNDED, and tells the hook it was SHIPPED (no restock)', async () => {
  const h = makeHarness({ orderStatus: 'PROCESSING' });
  const { service, calls } = withHook(h);
  const requested = await service.requestRefund(ORDER_ID, undefined, 'x', 'admin-1');
  h.land(await service.prepareAndSubmit(requested.refundId));
  order(h).status = 'SHIPPED';
  const done = await service.verifyRefund(requested.refundId);
  assert.equal(done.orderRefunded, true);
  assert.equal(calls[0].fromStatus, 'SHIPPED');
});

test('with no hook bound the engine behaves as before (status flip only)', async () => {
  const h = makeHarness({ orderStatus: 'PROCESSING' });
  const { refund, verified } = await h.fullCycle();
  assert.equal(verified.outcome, 'FINALIZED');
  assert.equal(order(h).status, 'REFUNDED');
  assert.ok(refund.txSignature);
});

test('isSigningAvailable reflects whether a MerchantSigner is bound; a 1 character reason is accepted, a blank one is not', async () => {
  const h = makeHarness();
  assert.equal(h.service.isSigningAvailable(), true);
  assert.equal(h.serviceWithoutSigner.isSigningAvailable(), false);
  await rejects(h.service.requestRefund(ORDER_ID, undefined, '   ', 'admin-1'), 400);
  assert.equal((await h.service.requestRefund(ORDER_ID, undefined, 'x', 'admin-1')).status, 'PREPARED');
});

// ----------------------------------------------------------------------------- read-side helpers

const row = (over: Partial<RefundRow>): RefundRow => ({
  id: 'r', status: 'PREPARED', amountAtomic: 1_250_000n, txSignature: null, failureReason: null, destinationAddress: 'dest', createdAt: new Date('2026-01-01T00:00:00Z'), ...over,
});

test('refund status mapping: PREPARED=REQUESTED, SUBMITTED/CONFIRMED=SUBMITTED, FINALIZED, FAILED/EXPIRED=FAILED; no address is exposed', () => {
  const map = (status: string) => toAdminRefund(row({ status }))!.status;
  assert.deepEqual(['PREPARED', 'SUBMITTED', 'CONFIRMED', 'FINALIZED', 'FAILED', 'EXPIRED'].map(map), ['REQUESTED', 'SUBMITTED', 'SUBMITTED', 'FINALIZED', 'FAILED', 'FAILED']);
  const shown = toAdminRefund(row({ status: 'SUBMITTED', txSignature: 'sig', failureReason: null }))!;
  assert.deepEqual(shown, { id: 'r', status: 'SUBMITTED', amountAtomic: '1250000', txSignature: 'sig', requestedAt: '2026-01-01T00:00:00.000Z', failureReason: null });
  assert.equal(toAdminRefund(null), null);
});

test('currentRefund prefers the active refund over older failed ones, else the newest', () => {
  const failed = row({ id: 'f1', status: 'FAILED', createdAt: new Date('2026-01-01') });
  const failed2 = row({ id: 'f2', status: 'EXPIRED', createdAt: new Date('2026-01-02') });
  const active = row({ id: 'a', status: 'SUBMITTED', createdAt: new Date('2026-01-03') });
  assert.equal(currentRefund([]), null);
  assert.equal(currentRefund([failed, failed2])!.id, 'f2');
  assert.equal(currentRefund([failed, active, failed2])!.id, 'a');
  assert.deepEqual([...ACTIVE_REFUND_STATUSES], ['PREPARED', 'SUBMITTED', 'CONFIRMED', 'FINALIZED']);
});

test("'refund' is offered on PAID/PROCESSING without an active refund, just before add-note; never on other statuses", () => {
  assert.deepEqual(withRefundAction(['start-packing', 'add-note'], 'PAID', []), ['start-packing', 'refund', 'add-note']);
  assert.deepEqual(withRefundAction(['ship', 'add-note'], 'PROCESSING', [row({ status: 'FAILED' })]), ['ship', 'refund', 'add-note']);
  assert.deepEqual(withRefundAction(['ship', 'add-note'], 'PROCESSING', [row({ status: 'PREPARED' })]), ['ship', 'add-note']);
  for (const status of ['PENDING_PAYMENT', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'] as const) {
    assert.deepEqual(withRefundAction(['add-note'], status, []), ['add-note']);
  }
});
