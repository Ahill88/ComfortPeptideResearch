import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ANCHOR_REQUEST_TIMEOUT_MS, requestAnchorSafely } from '../coa-anchor-call';

const input = { coaId: 'c1', kind: 'PUBLISH' as const };

test('the timeout is about 3 seconds', () => {
  assert.equal(ANCHOR_REQUEST_TIMEOUT_MS, 3000);
});

test('a fast port is awaited and receives exactly {coaId, kind}', async () => {
  const calls: unknown[] = [];
  const done = await requestAnchorSafely({ requestAnchor: async (value) => void calls.push(value) }, input);
  assert.equal(done, true);
  assert.deepEqual(calls, [input]);
});

test('no port bound is a no-op', async () => {
  assert.equal(await requestAnchorSafely(undefined, input), false);
});

test('a throwing or rejecting port never propagates', async () => {
  assert.equal(await requestAnchorSafely({ requestAnchor: () => { throw new Error('sync boom'); } }, input), false);
  assert.equal(await requestAnchorSafely({ requestAnchor: async () => { throw new Error('async boom'); } }, input), false);
  assert.equal(await requestAnchorSafely({ requestAnchor: () => Promise.reject(new Error('rejected')) }, input), false);
});

test('a never-resolving port is abandoned after the timeout, and a later rejection is swallowed', async () => {
  let rejectLater: (error: Error) => void = () => undefined;
  const port = { requestAnchor: () => new Promise<void>((_, reject) => { rejectLater = reject; }) };
  const started = Date.now();
  assert.equal(await requestAnchorSafely(port, input, 50), false);
  assert.ok(Date.now() - started < 1000);
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  rejectLater(new Error('late failure'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  process.off('unhandledRejection', listener);
  assert.deepEqual(unhandled, []);
});
