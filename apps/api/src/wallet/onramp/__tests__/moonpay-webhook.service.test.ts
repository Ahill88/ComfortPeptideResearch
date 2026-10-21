import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Logger } from '@nestjs/common';
import {
  AUDIT_MISMATCH, AUDIT_PROCESSED, AUDIT_STALE, AUDIT_UNKNOWN_INTENT, InvalidWebhookPayloadError, MoonPayWebhookService, decideTransition, mapBuyStatus, parseBuyEvent,
} from '../moonpay-webhook.service';
import { CUSTOMER_ID, INTENT_ID, MOONPAY_TX_ID, WALLET, buyEvent, makeWebhookDb, seedIntent } from './moonpay-webhook.helpers';

Logger.overrideLogger(false);

function setup(intent: Record<string, unknown> | null = {}) {
  const { db, prisma } = makeWebhookDb();
  if (intent) seedIntent(db, intent);
  const service = new MoonPayWebhookService(prisma);
  const intentRow = () => db.onRampIntent.rows.find((r) => r.id === INTENT_ID);
  const audits = (action?: string) => db.walletAuditEvent.rows.filter((r) => !action || r.action === action);
  return { db, service, intentRow, audits };
}

const T = (minute: number) => `2026-10-21T10:${String(minute).padStart(2, '0')}:00.000Z`;

test('status mapping: waitingPayment|pending|waitingAuthorization => PENDING, failed => FAILED, completed => COMPLETED, anything else is unmapped', () => {
  for (const s of ['waitingPayment', 'pending', 'waitingAuthorization']) assert.equal(mapBuyStatus(s), 'PENDING', s);
  assert.equal(mapBuyStatus('failed'), 'FAILED');
  assert.equal(mapBuyStatus('completed'), 'COMPLETED');
  for (const s of ['COMPLETED', 'refunded', '', 'Completed ']) assert.equal(mapBuyStatus(s), null, s);
});

test('all three buy event types are accepted and applied', async () => {
  for (const [type, status, expected] of [
    ['transaction_created', 'waitingPayment', 'PENDING'],
    ['transaction_updated', 'completed', 'COMPLETED'],
    ['transaction_failed', 'failed', 'FAILED'],
  ] as const) {
    const { service, intentRow, audits } = setup();
    const out = await service.handleEvent(buyEvent({ type, status, data: { failureReason: status === 'failed' ? 'cardNotSupported' : null } }));
    assert.equal(out.outcome, 'processed', type);
    assert.equal(intentRow()!.status, expected, type);
    assert.equal(intentRow()!.externalReference, MOONPAY_TX_ID);
    assert.equal(audits(AUDIT_PROCESSED).length, 1);
  }
});

test('other event types are acknowledged and do nothing (no DB access at all)', async () => {
  const { db, service, intentRow } = setup();
  for (const type of ['sell_transaction_created', 'sell_transaction_updated', 'sell_transaction_failed', 'identity_check_updated', 'swap_transaction_created', 'virtual_account_status_updated', 'totally_new', '']) {
    assert.deepEqual(await service.handleEvent(buyEvent({ type })), { outcome: 'ignored-type' }, type);
  }
  assert.equal(db.transactions, 0);
  assert.equal(intentRow()!.status, 'CREATED');
  assert.equal(db.walletAuditEvent.rows.length, 0);
});

test('payload validation: signed-but-unusable bodies are rejected as InvalidWebhookPayloadError (controller maps to 400)', () => {
  for (const body of [null, 'x', 5, [], {}, { type: 5 }, { type: 'transaction_updated' }, { type: 'transaction_updated', data: [] }]) {
    assert.throws(() => parseBuyEvent(body), InvalidWebhookPayloadError, JSON.stringify(body));
  }
  const base = buyEvent();
  for (const patch of [{ id: undefined }, { id: '' }, { id: 5 }, { status: undefined }, { updatedAt: undefined }, { updatedAt: 'not a date' }, { updatedAt: 12345 }]) {
    assert.throws(() => parseBuyEvent({ ...base, data: { ...base.data, ...patch } }), InvalidWebhookPayloadError, JSON.stringify(patch));
  }
  assert.equal(parseBuyEvent({ type: 'sell_transaction_updated' }), null);
});

test('pending then completed advances; completed then a late pending (older updatedAt) does not move it backwards', async () => {
  const { service, intentRow, audits } = setup();
  assert.equal((await service.handleEvent(buyEvent({ status: 'waitingPayment', at: T(1), type: 'transaction_created' }))).outcome, 'processed');
  assert.equal(intentRow()!.status, 'PENDING');
  assert.equal((await service.handleEvent(buyEvent({ status: 'pending', at: T(2) }))).outcome, 'processed');
  assert.equal(intentRow()!.status, 'PENDING');
  const done = await service.handleEvent(buyEvent({ status: 'completed', at: T(3) }));
  assert.deepEqual(done, { outcome: 'processed', intentId: INTENT_ID, statusBefore: 'PENDING', statusAfter: 'COMPLETED', changed: true });
  assert.equal(intentRow()!.status, 'COMPLETED');

  const late = await service.handleEvent(buyEvent({ status: 'pending', at: T(2) }));
  assert.equal(late.outcome, 'stale');
  assert.equal(intentRow()!.status, 'COMPLETED');
  assert.equal(audits(AUDIT_STALE).length, 1);
  // even a NEWER pending cannot move a COMPLETED intent backwards
  const newerPending = await service.handleEvent(buyEvent({ status: 'pending', at: T(9) }));
  assert.equal(newerPending.outcome, 'processed');
  assert.equal(intentRow()!.status, 'COMPLETED');
});

test('out-of-order delivery: completed arrives first, the older created/pending arrive later and are ignored', async () => {
  const { service, intentRow } = setup();
  assert.equal((await service.handleEvent(buyEvent({ status: 'completed', at: T(5) }))).outcome, 'processed');
  assert.equal((await service.handleEvent(buyEvent({ status: 'waitingPayment', at: T(1), type: 'transaction_created' }))).outcome, 'stale');
  assert.equal((await service.handleEvent(buyEvent({ status: 'pending', at: T(3) }))).outcome, 'stale');
  assert.equal(intentRow()!.status, 'COMPLETED');
});

test('out-of-order delivery decided by updatedAt, not arrival: failed(t=2) then pending(t=1) stays FAILED; pending(t=1) after completed(t=3) is stale', async () => {
  const { service, intentRow } = setup();
  await service.handleEvent(buyEvent({ status: 'failed', at: T(2), type: 'transaction_failed' }));
  assert.equal((await service.handleEvent(buyEvent({ status: 'pending', at: T(1) }))).outcome, 'stale');
  assert.equal(intentRow()!.status, 'FAILED');
});

test('exact duplicate deliveries are a no-op: no second audit row, no update', async () => {
  const { db, service, intentRow, audits } = setup();
  const event = buyEvent({ status: 'completed', at: T(4) });
  assert.equal((await service.handleEvent(event)).outcome, 'processed');
  const before = JSON.stringify([intentRow(), db.walletAuditEvent.rows]);
  for (let i = 0; i < 5; i++) assert.deepEqual(await service.handleEvent(JSON.parse(JSON.stringify(event))), { outcome: 'duplicate' });
  assert.equal(JSON.stringify([intentRow(), db.walletAuditEvent.rows]), before);
  assert.equal(audits().length, 1);
});

test('concurrent identical deliveries produce exactly one transition and one audit row', async () => {
  const { service, intentRow, audits } = setup();
  const event = buyEvent({ status: 'completed', at: T(4) });
  const results = await Promise.all(Array.from({ length: 12 }, () => service.handleEvent(event)));
  assert.equal(results.filter((r) => r.outcome === 'processed').length, 1);
  assert.equal(results.filter((r) => r.outcome === 'duplicate').length, 11);
  assert.equal(intentRow()!.status, 'COMPLETED');
  assert.equal(audits(AUDIT_PROCESSED).length, 1);
});

test('the intent row is locked (SELECT ... FOR UPDATE) inside the transaction', async () => {
  const { db, service } = setup();
  await service.handleEvent(buyEvent());
  assert.equal(db.lockQueries.length, 1);
  assert.match((db.lockQueries[0][0] as string[]).join('?'), /FOR UPDATE/);
});

test('unknown intent: 200-style outcome plus MOONPAY_WEBHOOK_UNKNOWN_INTENT audit, no throw, deduplicated across retries', async () => {
  const { db, service, audits } = setup(null);
  const event = buyEvent({ data: { externalTransactionId: 'does-not-exist' } });
  assert.deepEqual(await service.handleEvent(event), { outcome: 'unknown-intent' });
  assert.deepEqual(await service.handleEvent(event), { outcome: 'unknown-intent' });
  assert.equal(audits(AUDIT_UNKNOWN_INTENT).length, 1);
  assert.equal(audits()[0].customerId, CUSTOMER_ID);
  assert.equal(db.onRampIntent.rows.length, 0);
  // no externalTransactionId at all, or one that is not a plausible id (never reaches SQL): still acknowledged + audited
  for (const bad of [undefined, null, '', "x'; DROP TABLE \"OnRampIntent\"; --", 'a'.repeat(200), 'nul\u0000byte']) {
    const out = await service.handleEvent(buyEvent({ data: { externalTransactionId: bad, externalCustomerId: undefined }, envelope: { externalCustomerId: undefined } }));
    assert.deepEqual(out, { outcome: 'unknown-intent' }, String(bad));
  }
  assert.equal(db.lockQueries.length, 2, 'only the two well-formed ids reached the lock query');
  assert.ok(audits(AUDIT_UNKNOWN_INTENT).some((a) => a.customerId === 'unknown'));
});

test('mismatches (customer, wallet, currency, provider, status, transaction id): no status change, manualReview audit, still acknowledged', async () => {
  const cases: [string, Record<string, unknown>, Record<string, unknown>?][] = [
    ['customer-mismatch', { externalCustomerId: 'someone-else' }],
    ['wallet-mismatch', { walletAddress: '11111111111111111111111111111112' }],
    ['wallet-mismatch', { walletAddress: WALLET.toLowerCase() }], // base58 is case sensitive
    ['wallet-mismatch', { walletAddress: undefined }],
    ['currency-mismatch', { currency: { code: 'usdc' } }],
    ['currency-mismatch', { currency: { code: 'eth' } }],
    ['currency-mismatch', { currency: undefined }],
    ['unrecognised-status', { status: 'refunded' }],
    ['provider-not-moonpay', {}, { provider: 'moonpay-sandbox' }],
    ['transaction-id-differs', { id: 'another-moonpay-transaction' }, { externalReference: MOONPAY_TX_ID }],
  ];
  for (const [reason, data, intentOverride] of cases) {
    const { db, service, intentRow, audits } = setup({ status: 'PENDING', ...intentOverride });
    const before = JSON.stringify(intentRow());
    const out = await service.handleEvent(buyEvent({ status: 'completed', data }));
    assert.deepEqual(out, { outcome: 'mismatch', reason }, JSON.stringify(data));
    assert.equal(JSON.stringify(intentRow()), before, `intent untouched for ${reason}`);
    assert.equal(audits(AUDIT_PROCESSED).length, 0);
    const [audit] = audits(AUDIT_MISMATCH);
    assert.equal(audit.detail.manualReview, true);
    assert.equal(audit.detail.reason, reason);
    assert.equal(audit.detail.intentId, INTENT_ID);
    assert.equal(db.walletAuditEvent.rows.length, 1);
    // a retry of the same delivery does not pile up audit rows
    await service.handleEvent(buyEvent({ status: 'completed', data }));
    assert.equal(audits(AUDIT_MISMATCH).length, 1);
  }
});

test('currency code comparison tolerates case only: USDC_SOL is accepted', async () => {
  const { service, intentRow } = setup();
  assert.equal((await service.handleEvent(buyEvent({ status: 'pending', data: { currency: { code: 'USDC_SOL' } } }))).outcome, 'processed');
  assert.equal(intentRow()!.status, 'PENDING');
});

test('a missing data.externalCustomerId is allowed (only a PRESENT, different one is a mismatch)', async () => {
  const { service, intentRow } = setup();
  assert.equal((await service.handleEvent(buyEvent({ status: 'pending', data: { externalCustomerId: undefined } }))).outcome, 'processed');
  assert.equal(intentRow()!.status, 'PENDING');
});

test('externalReference: saved on first sight, kept afterwards, never rewritten', async () => {
  const { service, intentRow } = setup();
  await service.handleEvent(buyEvent({ status: 'pending', at: T(1) }));
  assert.equal(intentRow()!.externalReference, MOONPAY_TX_ID);
  await service.handleEvent(buyEvent({ status: 'completed', at: T(2) }));
  assert.equal(intentRow()!.externalReference, MOONPAY_TX_ID);
});

test('externalReference conflict: a MoonPay transaction id already claimed by ANOTHER intent is a manual-review mismatch, nothing is overwritten', async () => {
  const { db, service, intentRow, audits } = setup();
  seedIntent(db, { id: 'other-intent', customerId: 'cust_2', externalReference: MOONPAY_TX_ID, status: 'COMPLETED' });
  const out = await service.handleEvent(buyEvent({ status: 'completed' }));
  assert.deepEqual(out, { outcome: 'mismatch', reason: 'transaction-id-claimed-by-other-intent' });
  assert.equal(intentRow()!.externalReference, null);
  assert.equal(intentRow()!.status, 'CREATED');
  assert.equal(db.onRampIntent.rows.find((r) => r.id === 'other-intent')!.status, 'COMPLETED');
  assert.equal(audits(AUDIT_MISMATCH)[0].detail.manualReview, true);
});

test('externalReference unique-constraint race: the DB rejects at write time, the transaction rolls back, and the retry records a mismatch', async () => {
  const { db, service, intentRow, audits } = setup();
  seedIntent(db, { id: 'other-intent', customerId: 'cust_2', externalReference: null });
  // Simulate losing the race: the other intent claims the id right after our pre-check ran.
  const original = db.onRampIntent.findUnique.bind(db.onRampIntent);
  let attempts = 0;
  const claim = () => {
    db.onRampIntent.rows.find((r) => r.id === 'other-intent')!.externalReference = MOONPAY_TX_ID;
  };
  db.onRampIntent.findUnique = async (args: { where: Record<string, unknown> }) => {
    if (!('externalReference' in args.where)) return original(args);
    attempts += 1;
    // 1st attempt: the pre-check sees nothing, THEN the other transaction commits its claim (it survives our rollback).
    // Later attempts: the claim is already committed.
    if (attempts === 1) {
      const found = await original(args);
      claim();
      return found;
    }
    claim();
    return original(args);
  };
  const out = await service.handleEvent(buyEvent({ status: 'completed' }));
  assert.deepEqual(out, { outcome: 'mismatch', reason: 'transaction-id-claimed-by-other-intent' });
  assert.equal(intentRow()!.status, 'CREATED');
  assert.equal(intentRow()!.externalReference, null);
  assert.equal(audits(AUDIT_PROCESSED).length, 0, 'the rolled-back attempt left no audit row behind');
  assert.equal(audits(AUDIT_MISMATCH).length, 1);
  assert.equal(attempts, 2, 'exactly one retry');
});

test('a failing database write rolls the whole event back and surfaces as an error (MoonPay retries)', async () => {
  const { db, service, intentRow, audits } = setup();
  db.walletAuditEvent.create = async () => {
    throw new Error('db down');
  };
  await assert.rejects(service.handleEvent(buyEvent({ status: 'completed' })), /db down/);
  assert.equal(intentRow()!.status, 'CREATED');
  assert.equal(intentRow()!.externalReference, null);
  assert.equal(audits().length, 0);
});

test('expired intent + completed event => COMPLETED with an audit note; expired + pending/failed keeps EXPIRED', async () => {
  const completed = setup({ status: 'EXPIRED' });
  const out = await completed.service.handleEvent(buyEvent({ status: 'completed', at: T(7) }));
  assert.deepEqual(out, { outcome: 'processed', intentId: INTENT_ID, statusBefore: 'EXPIRED', statusAfter: 'COMPLETED', changed: true });
  assert.equal(completed.intentRow()!.status, 'COMPLETED');
  assert.equal(completed.audits(AUDIT_PROCESSED)[0].detail.note, 'completed-after-expiry');

  for (const [status, type] of [['pending', 'transaction_updated'], ['failed', 'transaction_failed']] as const) {
    const kept = setup({ status: 'EXPIRED' });
    const res = await kept.service.handleEvent(buyEvent({ status, type, at: T(7) }));
    assert.equal(res.outcome, 'processed');
    assert.equal(kept.intentRow()!.status, 'EXPIRED', status);
    assert.equal(kept.intentRow()!.externalReference, MOONPAY_TX_ID, 'the MoonPay id is still recorded');
    assert.equal(kept.audits(AUDIT_PROCESSED)[0].detail.changed, false);
  }
});

test('transition table: terminal states never move backwards; completed after failed is applied and flagged; failed after completed is flagged', () => {
  assert.deepEqual(decideTransition('CREATED', 'PENDING'), { status: 'PENDING' });
  assert.deepEqual(decideTransition('PENDING', 'FAILED'), { status: 'FAILED' });
  assert.deepEqual(decideTransition('CREATED', 'COMPLETED'), { status: 'COMPLETED' });
  assert.deepEqual(decideTransition('COMPLETED', 'COMPLETED'), { status: 'COMPLETED' });
  assert.equal(decideTransition('COMPLETED', 'PENDING').status, 'COMPLETED');
  assert.deepEqual(decideTransition('COMPLETED', 'FAILED'), { status: 'COMPLETED', note: 'failed-after-completed-ignored', manualReview: true });
  assert.equal(decideTransition('FAILED', 'PENDING').status, 'FAILED');
  assert.equal(decideTransition('FAILED', 'FAILED').status, 'FAILED');
  assert.deepEqual(decideTransition('FAILED', 'COMPLETED'), { status: 'COMPLETED', note: 'completed-after-failed', manualReview: true });
  assert.equal(decideTransition('EXPIRED', 'FAILED').status, 'EXPIRED');
  assert.equal(decideTransition('EXPIRED', 'PENDING').status, 'EXPIRED');
});

test('equal updatedAt with a different status is treated as the same revision (strictly newer is required to advance)', async () => {
  const { service, intentRow } = setup();
  await service.handleEvent(buyEvent({ status: 'pending', at: T(1) }));
  assert.equal((await service.handleEvent(buyEvent({ status: 'completed', at: T(1) }))).outcome, 'duplicate');
  assert.equal(intentRow()!.status, 'PENDING');
});

test('audit payloads carry ids and statuses only: no raw body, no email/PII fields, no signature, no wallet address', async () => {
  const { db, service } = setup();
  const event = buyEvent({ status: 'completed', at: T(3), data: { email: 'pii@example.test', cardholderName: 'Jane Doe', ipAddress: '203.0.113.9', cryptoTransactionId: '5abc', failureReason: null } });
  await service.handleEvent(event);
  const [audit] = db.walletAuditEvent.rows;
  assert.equal(audit.action, 'MOONPAY_WEBHOOK_PROCESSED');
  assert.equal(audit.customerId, CUSTOMER_ID);
  const text = JSON.stringify(audit);
  for (const forbidden of ['pii@example.test', 'Jane Doe', '203.0.113.9', WALLET, 'signature', 'Moonpay-Signature']) assert.ok(!text.includes(forbidden), `audit leaked ${forbidden}`);
  assert.deepEqual(Object.keys(audit.detail).sort(), ['changed', 'cryptoTransactionId', 'eventType', 'intentId', 'moonpayStatus', 'moonpayTransactionId', 'moonpayUpdatedAt', 'statusAfter', 'statusBefore']);
  assert.equal(audit.detail.moonpayUpdatedAt, T(3));
});

test('INVARIANT: the webhook touches only OnRampIntent and WalletAuditEvent (any other table access throws in the double) and no chain object exists', async () => {
  const { db, service } = setup();
  for (const status of ['waitingPayment', 'pending', 'waitingAuthorization', 'completed', 'failed']) {
    await service.handleEvent(buyEvent({ status, at: T(1 + ['waitingPayment', 'pending', 'waitingAuthorization', 'completed', 'failed'].indexOf(status)) }));
  }
  assert.deepEqual(Object.keys(db).filter((k) => !['lockQueries', 'transactions', 'proxy'].includes(k) && !k.startsWith('tail')).sort(), ['onRampIntent', 'walletAuditEvent']);
  assert.equal(service.constructor.length, 1, 'the service is constructed from the database client alone (no chain, wallet or credit dependency)');
});
