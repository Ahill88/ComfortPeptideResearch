/**
 * Eligibility gate on checkout (security review E): prepare and submit both require an APPROVED CustomerEligibility.
 * Enforced by default; ELIGIBILITY_REQUIRED=false is honoured ONLY when NODE_ENV is exactly development or test.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Logger } from '@nestjs/common';
import { resolveEligibilityRequired } from '../checkout.service';
import { CUSTOMER_ID, ORDER_ID, makeHarness, prepareSignSubmit, signAs } from './harness';

const rejects403 = (promise: Promise<unknown>) =>
  assert.rejects(promise, (e: any) => {
    assert.equal(e.getStatus?.(), 403, `expected HTTP 403, got ${e.getStatus?.()} (${e.message})`);
    return true;
  });

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function assertNothingCreated(h: ReturnType<typeof makeHarness>) {
  assert.equal(h.prisma.reservations.length, 0, 'no reservation');
  assert.equal(h.prisma.txs.length, 0, 'no purchase row');
  assert.equal(h.prisma.audits.length, 0, 'no audit event');
  assert.equal(h.chain.broadcasts.length, 0, 'nothing broadcast');
}

for (const eligibility of ['PENDING', 'REJECTED', null] as const) {
  test(`unapproved customer (${eligibility ?? 'no record'}): prepare is 403 and creates no reservation`, async () => {
    const h = makeHarness({ eligibility });
    await rejects403(h.checkout.prepare(CUSTOMER_ID, ORDER_ID));
    assertNothingCreated(h);
    assert.equal(await h.store.get('anything'), null);
  });

  test(`unapproved customer (${eligibility ?? 'no record'}): submit is 403 and nothing is broadcast`, async () => {
    // Prepare with a temporary approval, then the customer is (or was never) approved at submit time.
    const h = makeHarness({ eligibility: 'APPROVED' });
    const prepared = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
    const signed = signAs(prepared.unsignedTransactionBase64, h.customer);
    if (eligibility === null) h.prisma.eligibility.splice(0, h.prisma.eligibility.length, ...h.prisma.eligibility.filter((r) => r.customerId !== CUSTOMER_ID));
    else h.prisma.eligibility.find((r) => r.customerId === CUSTOMER_ID)!.status = eligibility;
    await rejects403(h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed));
    assert.equal(h.chain.broadcasts.length, 0);
    assert.equal(h.prisma.txs[0].status, 'PREPARED', 'the row was not claimed');
    assert.equal(h.prisma.txs[0].txSignature, null);
  });
}

test('submit by a customer who was never approved is 403 before the payload is even decoded', async () => {
  const h = makeHarness({ eligibility: null });
  await rejects403(h.checkout.submit(CUSTOMER_ID, ORDER_ID, '!!!not base64'));
  await rejects403(h.checkout.submit(CUSTOMER_ID, ORDER_ID, 'AAAAAAAA'));
  assertNothingCreated(h);
});

test('approved customer: prepare and submit work', async () => {
  const h = makeHarness({ eligibility: 'APPROVED' });
  const { prepared, submitted } = await prepareSignSubmit(h);
  assert.equal(submitted.status, 'SUBMITTED');
  assert.equal(h.chain.broadcasts.length, 1);
  assert.equal(h.prisma.reservations.length, 1);
  assert.ok(prepared.paymentReference);
});

test('approval revoked between prepare and submit: submit is 403, nothing is broadcast, and re-approval lets the same payload through', async () => {
  const h = makeHarness({ eligibility: 'APPROVED' });
  const prepared = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  const signed = signAs(prepared.unsignedTransactionBase64, h.customer);
  const record = h.prisma.eligibility.find((r) => r.customerId === CUSTOMER_ID)!;
  record.status = 'REJECTED';
  await rejects403(h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed));
  assert.equal(h.chain.broadcasts.length, 0);
  assert.equal(h.prisma.txs[0].status, 'PREPARED');
  await rejects403(h.checkout.prepare(CUSTOMER_ID, ORDER_ID));
  record.status = 'APPROVED';
  assert.equal((await h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed)).status, 'SUBMITTED');
  assert.equal(h.chain.broadcasts.length, 1);
});

test('approval revoked while submit is validating (after the first check) is still stopped before the claim and broadcast', async () => {
  const h = makeHarness({ eligibility: 'APPROVED' });
  const prepared = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  const signed = signAs(prepared.unsignedTransactionBase64, h.customer);
  const record = h.prisma.eligibility.find((r) => r.customerId === CUSTOMER_ID)!;
  // Revoke as soon as submit has passed its first check and moves on to reading the reservation.
  const reservations = (h.prisma as any).creditReservation;
  const reads = reservations.findUnique.bind(reservations);
  reservations.findUnique = async (args: unknown) => {
    record.status = 'REJECTED';
    return reads(args);
  };
  await rejects403(h.checkout.submit(CUSTOMER_ID, ORDER_ID, signed));
  assert.equal(h.chain.broadcasts.length, 0);
  assert.equal(h.prisma.txs[0].status, 'PREPARED');
});

test('another customer being approved does not help: the gate is per customer', async () => {
  const h = makeHarness({ eligibility: 'PENDING' }); // cust_2 is APPROVED in the harness
  await rejects403(h.checkout.prepare(CUSTOMER_ID, ORDER_ID));
  assertNothingCreated(h);
});

// ------------------------------------------------------------------ ELIGIBILITY_REQUIRED override

test('resolveEligibilityRequired: enforced by default; false honoured only for NODE_ENV exactly development/test', () => {
  assert.deepEqual(resolveEligibilityRequired({}), { required: true });
  assert.deepEqual(resolveEligibilityRequired({ NODE_ENV: 'production' }), { required: true });
  for (const value of ['true', '', '0', 'no', 'off', 'disabled', undefined]) {
    assert.equal(resolveEligibilityRequired({ ELIGIBILITY_REQUIRED: value, NODE_ENV: 'development' }).required, true, `value ${value}`);
  }
  for (const nodeEnv of ['development', 'test']) {
    const result = resolveEligibilityRequired({ ELIGIBILITY_REQUIRED: 'false', NODE_ENV: nodeEnv });
    assert.equal(result.required, false);
    assert.match(result.warning!, /DISABLED/);
  }
  // Everything else ignores the override, keeps the gate on, and says so.
  for (const nodeEnv of ['production', 'staging', 'Production', 'PRODUCTION', ' production', 'dev', 'Test', 'development ', '', undefined]) {
    const result = resolveEligibilityRequired({ ELIGIBILITY_REQUIRED: 'false', NODE_ENV: nodeEnv });
    assert.equal(result.required, true, `NODE_ENV=${JSON.stringify(nodeEnv)} must ignore the override`);
    assert.match(result.warning!, /IGNORED/);
  }
});

test('service: ELIGIBILITY_REQUIRED=false in test lets an unapproved customer through (with a startup warning); in production it is ignored with a warning', async () => {
  const warnings: string[] = [];
  const original = Logger.prototype.warn;
  Logger.prototype.warn = function (message: unknown) {
    warnings.push(String(message));
  } as typeof Logger.prototype.warn;
  try {
    await withEnv({ ELIGIBILITY_REQUIRED: 'false', NODE_ENV: 'test' }, async () => {
      const h = makeHarness({ eligibility: null });
      assert.ok(warnings.some((w) => /DISABLED/.test(w)), 'startup warning for a disabled gate');
      const prepared = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
      assert.equal((await h.checkout.submit(CUSTOMER_ID, ORDER_ID, signAs(prepared.unsignedTransactionBase64, h.customer))).status, 'SUBMITTED');
    });
    warnings.length = 0;
    await withEnv({ ELIGIBILITY_REQUIRED: 'false', NODE_ENV: 'production' }, async () => {
      const h = makeHarness({ eligibility: null });
      assert.ok(warnings.some((w) => /IGNORED/.test(w)), 'startup warning for an ignored override');
      await rejects403(h.checkout.prepare(CUSTOMER_ID, ORDER_ID));
      assertNothingCreated(h);
    });
    await withEnv({ ELIGIBILITY_REQUIRED: undefined, NODE_ENV: 'test' }, async () => {
      await rejects403(makeHarness({ eligibility: null }).checkout.prepare(CUSTOMER_ID, ORDER_ID));
    });
  } finally {
    Logger.prototype.warn = original;
  }
});
