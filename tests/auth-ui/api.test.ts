import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { authApi, AuthApiError, authErrorMessage } from '../../apps/storefront/lib/auth/api';
import { InvalidAuthResponse } from '../../apps/storefront/lib/auth/validation';
import { apiRequest } from '../../apps/storefront/lib/wallet/api';

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else delete (globalThis as unknown as { window?: unknown }).window;
});
const customer = { id: 'customer-1', email: 'test@example.org', name: null, emailVerified: true, mfaEnabled: false };
function respond(status: number, body?: unknown) {
  globalThis.fetch = (async () => new Response(body === undefined ? null : JSON.stringify(body), { status })) as typeof fetch;
}
test('auth transport includes cookies, no-store, no identity header, and normalized credentials', async () => {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    assert.ok(url.endsWith('/auth/login'));
    assert.equal(init.credentials, 'include'); assert.equal(init.cache, 'no-store'); assert.equal(init.method, 'POST');
    assert.deepEqual(init.headers, { Accept: 'application/json', 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(String(init.body)), { email: 'test@example.org', password: 'twelve-chars-password', totp: '012345' });
    return new Response(JSON.stringify({ customer }), { status: 200 });
  }) as typeof fetch;
  assert.deepEqual(await authApi.login(' Test@Example.ORG ', 'twelve-chars-password', ' 012345 '), customer);
});
test('session 401 is signed out; malformed or unavailable sessions are not accepted', async () => {
  respond(401, { message: 'Authentication required.' }); assert.equal(await authApi.session(), null);
  respond(200, { customer: { email: 'test@example.org', verified: true } }); await assert.rejects(authApi.session(), InvalidAuthResponse);
  respond(503, { message: 'internal details' }); await assert.rejects(authApi.session(), /Account service is unavailable/);
});
test('correct-password MFA and email-verification challenges retain only the documented codes/statuses', async () => {
  for (const [status, code] of [[401, 'MFA_REQUIRED'], [403, 'EMAIL_NOT_VERIFIED']] as const) {
    respond(status, { code, message: '<script>internal data</script>' });
    await assert.rejects(authApi.login(customer.email, 'password'), (e: unknown) => e instanceof AuthApiError && e.code === code && !e.message.includes('<script>'));
  }
  respond(500, { code: 'MFA_REQUIRED' }); await assert.rejects(authApi.login(customer.email, 'password'), (e: unknown) => e instanceof AuthApiError && e.code === null);
});
test('unknown-account sign-in stays generic; arbitrary server/HTML/network errors never leak', async () => {
  respond(401, { message: 'customer exists, internal path' }); await assert.rejects(authApi.login('test@example.org', 'bad'), /Invalid sign-in/);
  globalThis.fetch = (async () => new Response('<html>stack trace</html>', { status: 502 })) as typeof fetch;
  await assert.rejects(authApi.profile(), /Account service is unavailable/);
  globalThis.fetch = (async () => { throw new Error('database password leaked'); }) as typeof fetch;
  await assert.rejects(authApi.requestPasswordReset('test@example.org'), /Account service is unavailable/);
  assert.equal(authErrorMessage(new Error('raw error')), 'Unable to complete the request. Please try again.');
});
test('register/reset accepted responses must have the expected status and a message', async () => {
  respond(202, { message: 'Check your email to verify your account.' }); await authApi.register('Test', customer.email, 'twelve-chars-password');
  respond(200, { message: 'OK' }); await assert.rejects(authApi.register('Test', customer.email, 'twelve-chars-password'), InvalidAuthResponse);
  respond(202, {}); await assert.rejects(authApi.requestPasswordReset(customer.email), InvalidAuthResponse);
});
test('mutation responses validate 204 and expired reset links remain generic', async () => {
  respond(204); await authApi.verifyEmail('a'.repeat(43)); await authApi.resetPassword('a'.repeat(43), 'new-long-password'); await authApi.logout();
  respond(200, { success: true }); await assert.rejects(authApi.verifyEmail('a'.repeat(43)), InvalidAuthResponse);
  respond(400, { message: 'internal token hash' }); await assert.rejects(authApi.resetPassword('a'.repeat(43), 'new-long-password'), /Invalid or expired link/);
});
test('authenticated 401 notifies the provider; login challenge never expires an existing session', async () => {
  const events: string[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { dispatchEvent: (e: Event) => events.push(e.type) } });
  respond(401); await assert.rejects(authApi.addresses()); assert.deepEqual(events, ['hf:customer-session-expired']);
  respond(401, { code: 'MFA_REQUIRED' }); await assert.rejects(authApi.login(customer.email, 'password')); assert.equal(events.length, 1);
});
test('address endpoints encode IDs and support the exact default-only PATCH', async () => {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    assert.ok(url.endsWith('/auth/addresses/address%2F%3F%23')); assert.equal(init.method, 'PATCH');
    assert.deepEqual(JSON.parse(String(init.body)), { isDefault: true });
    return new Response(JSON.stringify({ id: 'a', label: null, recipient: 'A', line1: '1 Main', line2: null, city: 'Boston', region: 'MA', postalCode: '02110', country: 'US', isDefault: true }), { status: 200 });
  }) as typeof fetch;
  assert.equal((await authApi.updateAddress('address/?#', { isDefault: true })).isDefault, true);
});
test('wallet Node clients retain the explicit email seam and send credentials', async () => {
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    assert.equal(init.credentials, 'include'); assert.equal(new Headers(init.headers).get('x-customer-email'), customer.email);
    return new Response('{}');
  }) as typeof fetch;
  await apiRequest('/wallet', { email: customer.email });
});
test('wallet browser clients strip identity headers case-insensitively despite legacy email arguments', async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    assert.equal(init.credentials, 'include'); assert.equal(new Headers(init.headers).has('x-customer-email'), false);
    assert.equal(new Headers(init.headers).get('idempotency-key'), 'order-1');
    return new Response('{}');
  }) as typeof fetch;
  await apiRequest('/orders', { email: customer.email, headers: { 'X-Customer-Email': 'spoof@example.org', 'x-customer-email': 'spoof2@example.org', 'Idempotency-Key': 'order-1' } });
});
