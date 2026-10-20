import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Controller, ExecutionContext, Get, HttpStatus } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerException, ThrottlerModule } from '@nestjs/throttler';
import {
  DEFAULT_RATE_LIMITS,
  RouteAwareThrottlerGuard,
  buildThrottlerModuleOptions,
  loadRateLimitConfig,
  parsePositiveInt,
  routeSegments,
  selectRateLimitBucket,
} from '../rate-limit';

test('selectRateLimitBucket: money-moving routes', () => {
  const money = [
    '/v1/wallet/transfers/prepare',
    '/v1/wallet/transfers/abc123/submit',
    '/v1/wallet/transfers',
    '/v1/wallet/checkout/ord_1/submit',
    '/v1/wallet/onramp',
    '/v1/wallet/onramp/xyz/mock-complete',
    // evasion attempts: case, duplicate/trailing slash, percent-encoding, query string, missing version prefix
    '/V1/Wallet/Transfers/Prepare',
    '/v1//wallet///transfers/prepare/',
    '/v1/wallet/%74ransfers/prepare',
    '/v1/wallet/checkout/ord_1/SUBMIT/',
    '/v1/wallet/onramp?x=1',
    '/wallet/onramp',
    '/v2/wallet/onramp',
  ];
  for (const path of money) assert.equal(selectRateLimitBucket(path), 'money', path);
});

test('selectRateLimitBucket: auth/credential routes', () => {
  for (const path of ['/v1/auth/login', '/v1/auth/register', '/v1/auth/password-reset/request', '/v1/AUTH/profile', '/v1/auth', '/v1/auth/']) {
    assert.equal(selectRateLimitBucket(path), 'auth', path);
  }
});

test('selectRateLimitBucket: everything else uses only the default bucket', () => {
  const other = [
    '/',
    '/v1/catalog',
    '/v1/orders',
    '/v1/wallet',
    '/v1/wallet/balance',
    '/v1/wallet/transactions',
    '/v1/wallet/checkout/ord_1/prepare',
    '/v1/wallet/checkout/ord_1/status',
    '/v1/wallet/checkout/submit',
    '/v1/wallet/checkout/ord_1/submit/extra',
    '/v1/authors',
    '/v1/admin/wallets/balances',
    '/docs',
    '',
  ];
  for (const path of other) assert.equal(selectRateLimitBucket(path), null, JSON.stringify(path));
  assert.equal(selectRateLimitBucket(undefined), null);
});

test('routeSegments tolerates malformed percent-escapes', () => {
  assert.deepEqual(routeSegments('/v1/wallet/%E0%A4%A/transfers'), ['wallet', '%e0%a4%a', 'transfers']);
});

test('built-in limits: 120/min default, stricter money and auth', () => {
  assert.deepEqual(DEFAULT_RATE_LIMITS.default, { limit: 120, ttl: 60_000 });
  assert.ok(DEFAULT_RATE_LIMITS.money.limit < DEFAULT_RATE_LIMITS.default.limit);
  assert.ok(DEFAULT_RATE_LIMITS.auth.limit < DEFAULT_RATE_LIMITS.default.limit);
  assert.deepEqual(loadRateLimitConfig({}), DEFAULT_RATE_LIMITS);
});

test('env overrides apply; invalid overrides fall back to the safe default', () => {
  const config = loadRateLimitConfig({ THROTTLE_DEFAULT_LIMIT: '500', THROTTLE_MONEY_LIMIT: '0', THROTTLE_AUTH_LIMIT: 'lots' });
  assert.equal(config.default.limit, 500);
  assert.equal(config.money.limit, DEFAULT_RATE_LIMITS.money.limit);
  assert.equal(config.auth.limit, DEFAULT_RATE_LIMITS.auth.limit);
  assert.equal(parsePositiveInt('12'), 12);
  for (const bad of [undefined, '', '0', '-1', '1.5', '1e3', '9999999', 'x']) assert.equal(parsePositiveInt(bad), null, String(bad));
});

// ---- guard behaviour with real throttler storage but no HTTP -------------------------------------------------

@Controller()
class StubController {
  @Get() handler() {
    return 'ok';
  }
}

async function makeGuard(env: Record<string, string> = { THROTTLE_DEFAULT_LIMIT: '6', THROTTLE_MONEY_LIMIT: '2', THROTTLE_AUTH_LIMIT: '3' }) {
  const moduleRef = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot(buildThrottlerModuleOptions(env))],
    controllers: [StubController],
    providers: [RouteAwareThrottlerGuard],
  }).compile();
  await moduleRef.init();
  const guard = moduleRef.get(RouteAwareThrottlerGuard, { strict: false });
  const headers: Record<string, string | number> = {};
  const res = { header: (name: string, value: string | number) => { headers[name] = value; } };
  const hit = (path: string, init: { ip?: string; method?: string; xff?: string } = {}) => {
    const req = { path, url: path, method: init.method ?? 'POST', ip: init.ip ?? '203.0.113.7', headers: init.xff ? { 'x-forwarded-for': init.xff } : {}, socket: { remoteAddress: init.ip ?? '203.0.113.7' } };
    const context = {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
      getClass: () => StubController,
      getHandler: () => StubController.prototype.handler,
    } as unknown as ExecutionContext;
    return guard.canActivate(context);
  };
  return { hit, headers, close: () => moduleRef.close() };
}

const expectBlocked = async (promise: Promise<boolean>) =>
  assert.rejects(promise, (error: unknown) => error instanceof ThrottlerException && error.getStatus() === HttpStatus.TOO_MANY_REQUESTS);

test('money routes: 429 after the strict limit, counted across all money routes together', async () => {
  const { hit, headers, close } = await makeGuard();
  assert.equal(await hit('/v1/wallet/transfers/prepare'), true);
  assert.equal(await hit('/v1/wallet/onramp'), true);
  await expectBlocked(hit('/v1/wallet/checkout/ord_1/submit'));
  assert.ok(Number(headers['Retry-After']) > 0, 'standard Retry-After header is set');
  assert.equal(headers['Retry-After-money'], undefined);
  await close();
});

test('auth routes use their own bucket, independent from money', async () => {
  const { hit, close } = await makeGuard();
  for (let i = 0; i < 3; i += 1) assert.equal(await hit('/v1/auth/login'), true);
  await expectBlocked(hit('/v1/auth/login'));
  // money bucket for the same client is untouched by auth traffic
  assert.equal(await hit('/v1/wallet/transfers/prepare'), true);
  await close();
});

test('ordinary routes only hit the default (generous) bucket', async () => {
  const { hit, close } = await makeGuard();
  for (let i = 0; i < 6; i += 1) assert.equal(await hit('/v1/catalog', { method: 'GET' }), true);
  await expectBlocked(hit('/v1/catalog', { method: 'GET' }));
  await close();
});

test('default bucket is shared across routes, so strict-route traffic also consumes it', async () => {
  const { hit, close } = await makeGuard();
  assert.equal(await hit('/v1/wallet/transfers/prepare'), true);
  assert.equal(await hit('/v1/wallet/transfers/prepare'), true);
  for (let i = 0; i < 4; i += 1) assert.equal(await hit('/v1/catalog', { method: 'GET' }), true);
  await expectBlocked(hit('/v1/orders', { method: 'GET' })); // 7th request overall from this client
  await close();
});

test('limits are per client IP; X-Forwarded-For header is never used as the tracker', async () => {
  const { hit, close } = await makeGuard();
  assert.equal(await hit('/v1/wallet/onramp', { ip: '198.51.100.1' }), true);
  assert.equal(await hit('/v1/wallet/onramp', { ip: '198.51.100.1', xff: '1.1.1.1' }), true);
  await expectBlocked(hit('/v1/wallet/onramp', { ip: '198.51.100.1', xff: '2.2.2.2' })); // rotating XFF does not help
  assert.equal(await hit('/v1/wallet/onramp', { ip: '198.51.100.2' }), true); // a different socket peer is unaffected
  await close();
});

test('path normalisation cannot be used to dodge the strict bucket', async () => {
  const { hit, close } = await makeGuard();
  assert.equal(await hit('/v1/wallet/transfers/prepare'), true);
  assert.equal(await hit('/V1/WALLET/Transfers/prepare/'), true);
  await expectBlocked(hit('/v1//wallet/%74ransfers/prepare'));
  await close();
});

test('IPv6 clients are grouped by /64 and IPv4-mapped addresses match their IPv4 form', async () => {
  const { hit, close } = await makeGuard();
  assert.equal(await hit('/v1/wallet/onramp', { ip: '2001:db8:1:2:aaaa::1' }), true);
  assert.equal(await hit('/v1/wallet/onramp', { ip: '2001:db8:1:2:bbbb::9' }), true);
  await expectBlocked(hit('/v1/wallet/onramp', { ip: '2001:db8:1:2:cccc::5' }));
  assert.equal(await hit('/v1/wallet/onramp', { ip: '2001:db8:1:3::1' }), true);
  assert.equal(await hit('/v1/wallet/onramp', { ip: '::ffff:192.0.2.9' }), true);
  assert.equal(await hit('/v1/wallet/onramp', { ip: '192.0.2.9' }), true);
  await expectBlocked(hit('/v1/wallet/onramp', { ip: '::ffff:192.0.2.9' }));
  await close();
});

test('CORS preflight (OPTIONS) is never counted', async () => {
  const { hit, close } = await makeGuard();
  for (let i = 0; i < 20; i += 1) assert.equal(await hit('/v1/wallet/transfers/prepare', { method: 'OPTIONS' }), true);
  assert.equal(await hit('/v1/wallet/transfers/prepare'), true);
  await close();
});

test('requests without any usable address share one conservative bucket instead of bypassing limits', async () => {
  const { hit, close } = await makeGuard();
  const noIp = { ip: '' };
  assert.equal(await hit('/v1/wallet/onramp', noIp), true);
  assert.equal(await hit('/v1/wallet/onramp', noIp), true);
  await expectBlocked(hit('/v1/wallet/onramp', noIp));
  await close();
});
