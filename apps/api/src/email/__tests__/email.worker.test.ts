import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EmailWorker, BACKOFF_MS, LEASE_MS, MAX_ATTEMPTS, RETENTION_MS, backoffMs } from '../email.worker';
import { captureLogs, FakeClock, FakeProvider, InMemoryEmailPrisma, TOKEN, testConfig } from './email-support';

const KEY = 're_test_0123456789abcdefghij';
const DAY = 24 * 3_600_000;

function setup(options: { provider?: FakeProvider | null; config?: Parameters<typeof testConfig>[0] } = {}) {
  const prisma = new InMemoryEmailPrisma();
  const clock = new FakeClock();
  const provider = options.provider === undefined ? new FakeProvider() : options.provider;
  const worker = new EmailWorker(prisma as any, testConfig(options.config), provider, clock.now);
  const seed = (fields: Record<string, unknown> = {}) => prisma.seed({ nextAttemptAt: clock.now(), createdAt: clock.now(), ...fields });
  return { prisma, clock, provider: provider as FakeProvider, worker, seed };
}

test('backoff schedule is 30s, 2m, 10m, 1h, 6h and the last step repeats', () => {
  assert.deepEqual([...BACKOFF_MS], [30_000, 120_000, 600_000, 3_600_000, 21_600_000]);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(backoffMs), [30_000, 120_000, 600_000, 3_600_000, 21_600_000, 21_600_000, 21_600_000, 21_600_000]);
  assert.equal(MAX_ATTEMPTS, 8);
  assert.equal(LEASE_MS, 5 * 60_000);
  assert.equal(RETENTION_MS, 90 * DAY);
});

test('success: row becomes SENT with sentAt and provider id; one-time link is scrubbed from stored data; no recipient in the log', async () => {
  const logs = captureLogs();
  try {
    const { prisma, provider, worker, seed, clock } = setup();
    const row = seed();
    const summary = await worker.tick();
    assert.deepEqual(summary, { claimed: 1, sent: 1, retried: 0, failed: 0, skipped: null });
    assert.equal(provider.sent.length, 1);
    assert.equal(provider.sent[0].to, 'buyer@example.com');
    assert.ok(provider.sent[0].text.includes(TOKEN), 'the provider receives the real link');
    assert.equal(row.status, 'SENT');
    assert.equal(row.attempts, 1);
    assert.equal(row.sentAt.getTime(), clock.now().getTime());
    assert.equal(row.providerMessageId, `fake-${row.id}`);
    assert.equal(row.lastError, null);
    assert.deepEqual(row.data, { removedAfterSend: true });
    assert.equal(prisma.rows.length, 1);
    assert.ok(logs.lines.every((l) => !l.includes(TOKEN) && !l.includes('buyer@')), logs.lines.join('\n'));
    assert.equal((await worker.tick()).claimed, 0, 'a SENT row is never picked up again');
    assert.equal(provider.sent.length, 1);
  } finally {
    logs.restore();
  }
});

test('success keeps order data intact (only credential-link templates are scrubbed)', async () => {
  const { provider, worker, seed } = setup();
  const row = seed({ template: 'order_confirmation', data: { orderId: 'o1', totalCents: 500, currency: 'USD' } });
  await worker.tick();
  assert.equal(row.status, 'SENT');
  assert.deepEqual(row.data, { orderId: 'o1', totalCents: 500, currency: 'USD' });
  assert.match(provider.sent[0].subject, /Order confirmation o1/);
});

test('rows that are not due yet are not sent; due rows go oldest first', async () => {
  const { provider, worker, seed, clock } = setup();
  const later = seed({ nextAttemptAt: new Date(clock.now().getTime() + 1000), template: 'order_confirmation', data: { orderId: 'later', totalCents: 1, currency: 'USD' } });
  seed({ nextAttemptAt: new Date(clock.now().getTime() - 2000), template: 'order_confirmation', data: { orderId: 'first', totalCents: 1, currency: 'USD' } });
  seed({ nextAttemptAt: new Date(clock.now().getTime() - 1000), template: 'order_confirmation', data: { orderId: 'second', totalCents: 1, currency: 'USD' } });
  await worker.tick();
  assert.deepEqual(provider.sent.map((m) => m.subject), ['Order confirmation first', 'Order confirmation second']);
  assert.equal(later.status, 'PENDING');
  clock.advance(1001);
  await worker.tick();
  assert.equal(later.status, 'SENT');
});

test('retryable failures follow the exact backoff schedule with an injected clock, then FAILED at attempt 8 with a redacted lastError', async () => {
  const { prisma, provider, worker, seed, clock } = setup();
  provider.behavior = () => ({ ok: false, retryable: true, error: 'HTTP 503 temporarily unavailable' });
  const row = seed();
  const expectedDelays = [30_000, 120_000, 600_000, 3_600_000, 21_600_000, 21_600_000, 21_600_000];
  for (let attempt = 1; attempt <= 7; attempt += 1) {
    const before = clock.now().getTime();
    const summary = await worker.tick();
    assert.equal(summary.retried, 1, `attempt ${attempt}`);
    assert.equal(row.status, 'PENDING');
    assert.equal(row.attempts, attempt);
    assert.equal(row.nextAttemptAt.getTime(), before + expectedDelays[attempt - 1], `delay after attempt ${attempt}`);
    // Just before the due time nothing happens...
    clock.advance(expectedDelays[attempt - 1] - 1);
    assert.equal((await worker.tick()).claimed, 0, `not due yet after attempt ${attempt}`);
    assert.equal(provider.sent.length, attempt);
    // ...and at the due time the next attempt runs.
    clock.advance(1);
  }
  const summary = await worker.tick();
  assert.equal(summary.failed, 1);
  assert.equal(row.status, 'FAILED');
  assert.equal(row.attempts, 8);
  assert.equal(provider.sent.length, 8);
  assert.match(row.lastError, /503/);
  clock.advance(30 * DAY);
  assert.equal((await worker.tick()).claimed, 0, 'FAILED rows are never retried automatically');
  assert.equal(prisma.rows.length, 1);
});

test('permanent failure: FAILED on the first attempt, never retried, lastError redacted of key/address/token', async () => {
  const { provider, worker, seed, clock } = setup({ config: { apiKey: KEY } });
  provider.behavior = () => ({ ok: false, retryable: false, error: `HTTP 403 bad key ${KEY} for buyer@example.com at https://shop.example.com/reset-password?token=${TOKEN} (${TOKEN})` });
  const row = seed();
  const summary = await worker.tick();
  assert.equal(summary.failed, 1);
  assert.equal(row.status, 'FAILED');
  assert.equal(row.attempts, 1);
  for (const leaked of [KEY, 'buyer@example.com', TOKEN]) assert.ok(!row.lastError.includes(leaked), `lastError leaked ${leaked}: ${row.lastError}`);
  assert.match(row.lastError, /HTTP 403/);
  clock.advance(10 * DAY);
  await worker.tick();
  assert.equal(provider.sent.length, 1);
});

test('a provider that throws is retryable and its message is redacted (stored and logged)', async () => {
  const logs = captureLogs();
  try {
    const { provider, worker, seed } = setup({ config: { apiKey: KEY } });
    provider.behavior = () => { throw new Error(`socket hang up (${KEY}) to buyer@example.com ${TOKEN}`); };
    const row = seed();
    const summary = await worker.tick();
    assert.equal(summary.retried, 1);
    assert.equal(row.status, 'PENDING');
    for (const leaked of [KEY, 'buyer@example.com', TOKEN]) {
      assert.ok(!row.lastError.includes(leaked), row.lastError);
      assert.ok(logs.lines.every((l) => !l.includes(leaked)), `log leaked ${leaked}:\n${logs.lines.join('\n')}`);
    }
  } finally {
    logs.restore();
  }
});

test('Retry-After from a provider lengthens (never shortens) the backoff', async () => {
  const { provider, worker, seed, clock } = setup();
  provider.behavior = () => ({ ok: false, retryable: true, error: 'HTTP 429', retryAfterMs: 3_600_000 });
  const row = seed();
  const before = clock.now().getTime();
  await worker.tick();
  assert.equal(row.nextAttemptAt.getTime(), before + 3_600_000);
  provider.behavior = () => ({ ok: false, retryable: true, error: 'HTTP 429', retryAfterMs: 1000 });
  clock.advance(3_600_000);
  const before2 = clock.now().getTime();
  await worker.tick();
  assert.equal(row.nextAttemptAt.getTime(), before2 + 120_000, 'attempt 2 backoff (2m) is longer than a 1s Retry-After');
});

test('a malformed stored row fails permanently without calling the provider', async () => {
  const { provider, worker, seed } = setup();
  const bad = seed({ template: 'unknown_template', data: {} });
  const badData = seed({ template: 'password_reset', data: { link: 'javascript:alert(1)' } });
  await worker.tick();
  assert.equal(provider.sent.length, 0);
  for (const row of [bad, badData]) {
    assert.equal(row.status, 'FAILED');
    assert.match(row.lastError, /not valid/);
    assert.ok(!row.lastError.includes('javascript'));
  }
});

test('stale SENDING rows (lease older than 5 minutes) are re-claimable; fresh leases are not', async () => {
  const { provider, worker, seed, clock } = setup();
  const fresh = seed({ status: 'SENDING', attempts: 1, nextAttemptAt: new Date(clock.now().getTime() + 60_000) });
  const stale = seed({ status: 'SENDING', attempts: 1, nextAttemptAt: new Date(clock.now().getTime() - 1) });
  await worker.tick();
  assert.equal(provider.sent.length, 1);
  assert.equal(stale.status, 'SENT');
  assert.equal(stale.attempts, 2, 'a reclaim counts as an attempt');
  assert.equal(fresh.status, 'SENDING');
  clock.advance(61_000);
  await worker.tick();
  assert.equal(fresh.status, 'SENT');
});

test('crash recovery end to end: a claim leases the row for 5 minutes; after that a second worker takes over and the first one cannot overwrite it', async () => {
  const prisma = new InMemoryEmailPrisma();
  const clock = new FakeClock();
  let release: (() => void) | undefined;
  const slow = new FakeProvider();
  slow.behavior = () => new Promise((resolve) => { release = () => resolve({ ok: true, providerMessageId: 'late' }); });
  const fast = new FakeProvider();
  const first = new EmailWorker(prisma as any, testConfig(), slow, clock.now);
  const second = new EmailWorker(prisma as any, testConfig(), fast, clock.now);
  const row = prisma.seed({ nextAttemptAt: clock.now() });
  const logs = captureLogs();
  try {
    const stuck = first.tick();
    await new Promise((r) => setImmediate(r));
    assert.equal(row.status, 'SENDING');
    assert.equal(row.nextAttemptAt.getTime(), clock.now().getTime() + LEASE_MS);
    clock.advance(LEASE_MS - 1);
    assert.equal((await second.tick()).claimed, 0, 'lease still held');
    clock.advance(1);
    assert.equal((await second.tick()).sent, 1, 'lease expired: second worker sends');
    assert.equal(row.status, 'SENT');
    assert.equal(row.providerMessageId, `fake-${row.id}`);
    release!();
    await stuck;
    assert.equal(row.providerMessageId, `fake-${row.id}`, 'the late first worker did not overwrite the result');
    assert.equal(row.attempts, 2);
    assert.ok(logs.lines.some((l) => /lease had expired/.test(l)));
  } finally {
    logs.restore();
  }
});

test('a stale SENDING row that already used its last attempt is FAILED, not sent a ninth time', async () => {
  const { provider, worker, seed, clock } = setup();
  const row = seed({ status: 'SENDING', attempts: 8, nextAttemptAt: new Date(clock.now().getTime() - 1) });
  const summary = await worker.tick();
  assert.equal(provider.sent.length, 0);
  assert.equal(row.status, 'FAILED');
  assert.equal(summary.failed, 1);
  assert.match(row.lastError, /attempt limit/);
});

test('two worker instances over one outbox send every row exactly once', async () => {
  const prisma = new InMemoryEmailPrisma();
  const clock = new FakeClock();
  const sentA = new FakeProvider();
  const sentB = new FakeProvider();
  sentA.delayMs = 1;
  sentB.delayMs = 1;
  const a = new EmailWorker(prisma as any, testConfig(), sentA, clock.now);
  const b = new EmailWorker(prisma as any, testConfig(), sentB, clock.now);
  const ids = Array.from({ length: 40 }, (_, i) => prisma.seed({ template: 'order_confirmation', data: { orderId: `o${i}`, totalCents: 1, currency: 'USD' }, nextAttemptAt: clock.now() }).id);
  for (let round = 0; round < 4; round += 1) await Promise.all([a.tick(), b.tick()]);
  const all = [...sentA.sent, ...sentB.sent].map((m) => m.id);
  assert.equal(all.length, 40, 'every row sent');
  assert.equal(new Set(all).size, 40, 'no row sent twice');
  assert.deepEqual([...all].sort(), [...ids].sort());
  assert.ok(sentA.sent.length > 0 && sentB.sent.length > 0, 'both instances did work');
  assert.ok(prisma.rows.every((r) => r.status === 'SENT' && r.attempts === 1));
});

test('EMAIL_PROVIDER=none: the worker warns loudly ONCE, sends nothing and leaves rows PENDING', async () => {
  const logs = captureLogs();
  try {
    const { worker, seed, clock } = setup({ provider: null, config: { provider: 'none' } });
    const row = seed();
    for (let i = 0; i < 3; i += 1) assert.equal((await worker.tick()).skipped, 'no-provider');
    clock.advance(DAY);
    await worker.tick();
    const warnings = logs.lines.filter((l) => /NO EMAIL WILL BE SENT/.test(l));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^warn /);
    assert.equal(row.status, 'PENDING');
    assert.equal(row.attempts, 0);
  } finally {
    logs.restore();
  }
});

test('retention: SENT rows older than 90 days are deleted; younger SENT, PENDING, SENDING and FAILED rows stay; sweep runs at most hourly', async () => {
  const { prisma, worker, seed, clock } = setup();
  const old = seed({ status: 'SENT', sentAt: new Date(clock.now().getTime() - 91 * DAY) });
  const young = seed({ status: 'SENT', sentAt: new Date(clock.now().getTime() - 89 * DAY) });
  const oldPending = seed({ nextAttemptAt: new Date(clock.now().getTime() + 400 * DAY), createdAt: new Date(clock.now().getTime() - 200 * DAY) });
  const oldFailed = seed({ status: 'FAILED', createdAt: new Date(clock.now().getTime() - 200 * DAY) });
  await worker.tick();
  assert.deepEqual(prisma.rows.map((r) => r.id).sort(), [young.id, oldPending.id, oldFailed.id].sort());
  assert.ok(!prisma.rows.includes(old));
  const older = seed({ status: 'SENT', sentAt: new Date(clock.now().getTime() - 120 * DAY), nextAttemptAt: new Date(clock.now().getTime() + DAY) });
  await worker.tick();
  assert.ok(prisma.rows.includes(older), 'throttled: not swept again within the hour');
  clock.advance(3_600_001);
  await worker.tick();
  assert.ok(!prisma.rows.includes(older));
  assert.equal(await worker.sweepRetention(true), 0);
});

test('overlapping ticks never run concurrently', async () => {
  const { provider, worker, seed } = setup();
  provider.delayMs = 20;
  seed();
  const [one, two] = await Promise.all([worker.tick(), worker.tick()]);
  assert.deepEqual([one.skipped, two.skipped], [null, 'busy']);
  assert.equal(provider.sent.length, 1);
});

test('timer: EMAIL_WORKER_INTERVAL_MS=0 starts no timer; a positive interval starts one that onModuleDestroy clears', async () => {
  const off = setup({ config: { workerIntervalMs: 0 } });
  off.worker.onModuleInit();
  assert.equal((off.worker as any).timer, undefined);
  const on = setup({ config: { workerIntervalMs: 60_000 } });
  on.worker.onModuleInit();
  assert.ok((on.worker as any).timer, 'timer started');
  on.worker.onModuleDestroy();
  assert.equal((on.worker as any).timer, undefined);
});

test('a database failure inside a tick is caught and logged without PII; the worker keeps running', async () => {
  const logs = captureLogs();
  try {
    const { prisma, worker } = setup();
    (prisma.emailOutbox as any).findMany = async () => { throw new Error('connection refused for buyer@example.com'); };
    const summary = await worker.tick();
    assert.equal(summary.claimed, 0);
    assert.ok(logs.lines.some((l) => /worker pass failed/.test(l)));
    assert.ok(logs.lines.every((l) => !l.includes('buyer@example.com')));
    assert.notEqual((await worker.tick()).skipped, 'busy', 'the busy flag was released');
  } finally {
    logs.restore();
  }
});
