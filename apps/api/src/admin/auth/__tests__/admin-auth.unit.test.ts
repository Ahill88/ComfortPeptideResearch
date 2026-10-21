/** Admin auth HTTP contract against the in-memory Prisma double (no database). The same scenarios run on Postgres in admin-auth.integration.test.ts. */
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { selectRateLimitBucket } from '../../../config/rate-limit';
import { startHarness, type Harness } from './harness';
import { createInMemoryAdminPrisma } from './in-memory-admin-prisma';
import { registerScenarios } from './scenarios';

let harness: Harness;
let throttled: Harness;
before(async () => {
  harness = await startHarness(createInMemoryAdminPrisma());
  throttled = await startHarness(createInMemoryAdminPrisma(), { throttleAuthLimit: 3 });
});
after(async () => {
  await harness?.close();
  await throttled?.close();
});

registerScenarios('in-memory', () => harness);

test('rate limit: sign-in and password change use the strict "auth" bucket; other admin routes only the default one', () => {
  assert.equal(selectRateLimitBucket('/v1/admin/auth/login'), 'auth');
  assert.equal(selectRateLimitBucket('/v1/Admin/AUTH/login/'), 'auth');
  assert.equal(selectRateLimitBucket('/v1/admin/auth/change-password'), 'auth');
  for (const path of ['/v1/admin/auth/me', '/v1/admin/auth/logout', '/v1/admin/users', '/v1/admin/audit', '/v1/admin/auth']) assert.equal(selectRateLimitBucket(path), null, path);
});

test('rate limit: the real throttler answers 429 + Retry-After on sign-in after the auth limit, not on /me', async () => {
  const admin = await throttled.makeAdmin('STAFF', 'throttle');
  const statuses: number[] = [];
  let last;
  for (let i = 0; i < 5; i += 1) {
    last = await throttled.login(admin, { password: 'wrong-password-123' });
    statuses.push(last.status);
  }
  assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
  assert.ok(last?.headers.get('retry-after'));
  assert.equal((await throttled.call('GET', '/admin/auth/me')).status, 401, 'default bucket still open');
});

test('guard and routes are wired: every admin route exists and rejects anonymous callers', async () => {
  for (const [method, path] of [['GET', '/admin/auth/me'], ['POST', '/admin/auth/logout'], ['POST', '/admin/auth/change-password'], ['GET', '/admin/users'], ['POST', '/admin/users'], ['POST', '/admin/users/x/deactivate'], ['GET', '/admin/audit']]) {
    const res = await harness.call(method, path, { body: method === 'POST' ? {} : undefined });
    assert.equal(res.status, 401, `${method} ${path}`);
    assert.equal(res.body.message, 'Admin sign-in required.');
  }
  const malformed = await harness.call('GET', '/admin/auth/me', { headers: { authorization: 'Bearer short' } });
  assert.equal(malformed.status, 401);
});
