import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ORDER_EMAIL_HOOK_TIMEOUT_MS, runOrderEmailHook } from '../customer-orders.email-hook';
import { RecordingEmail, quietLogger } from './recording-email';

const message = { to: 'private.person@example.test', template: 'order_confirmation' as const, data: { orderId: 'o1', totalCents: 1, currency: 'USD' }, dedupeKey: 'order_confirmation:o1' };
const run = (email: RecordingEmail | undefined, build: () => Promise<typeof message | null>, extra: { timeoutMs?: number } = {}) => {
  const logger = quietLogger();
  return runOrderEmailHook({ email, logger, template: 'order_confirmation', orderId: 'o1', build, ...extra }).then((outcome) => ({ outcome, logger }));
};

test('the default time box is under one second', () => {
  assert.ok(ORDER_EMAIL_HOOK_TIMEOUT_MS < 1000);
});

test('enqueues what build returns', async () => {
  const email = new RecordingEmail();
  const { outcome } = await run(email, async () => message);
  assert.equal(outcome, 'enqueued');
  assert.deepEqual(email.sent, [message]);
});

test('no port bound, or nothing to send: skipped, build is not even called without a port', async () => {
  let built = 0;
  assert.equal((await run(undefined, async () => (built++, message))).outcome, 'skipped');
  assert.equal(built, 0);
  assert.equal((await run(new RecordingEmail(), async () => null)).outcome, 'skipped');
});

test('a rejecting or synchronously throwing enqueue never throws; the log has ids and the error class only', async () => {
  for (const sync of [false, true]) {
    const email = new RecordingEmail();
    email.failWith = new TypeError('smtp exploded for private.person@example.test');
    email.sync = sync;
    const { outcome, logger } = await run(email, async () => message);
    assert.equal(outcome, 'failed');
    assert.equal(logger.lines.length, 1);
    assert.match(logger.lines[0], /template=order_confirmation, order=o1/);
    assert.ok(!/private\.person|exploded|example\.test/.test(logger.lines[0]), 'no address or error text in logs');
  }
});

test('a failing lookup never throws', async () => {
  const { outcome } = await run(new RecordingEmail(), async () => { throw new Error('db down'); });
  assert.equal(outcome, 'failed');
});

test('a hung enqueue is abandoned at the time box; a later rejection is swallowed', async () => {
  const email = new RecordingEmail();
  email.hang = true;
  const started = Date.now();
  const { outcome, logger } = await run(email, async () => message);
  const elapsed = Date.now() - started;
  assert.equal(outcome, 'timeout');
  assert.ok(elapsed < 1000, `took ${elapsed}ms`);
  assert.equal(logger.lines.length, 1);

  const slowFail = new RecordingEmail();
  slowFail.delayMs = 40;
  slowFail.failWith = new Error('late failure');
  const result = await run(slowFail, async () => message, { timeoutMs: 10 });
  assert.equal(result.outcome, 'timeout');
  await new Promise((resolve) => setTimeout(resolve, 80)); // would crash the process on an unhandled rejection
});
