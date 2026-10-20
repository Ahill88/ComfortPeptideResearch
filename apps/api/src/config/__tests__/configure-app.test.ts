import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Body, Controller, Get, INestApplication, Post, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { configureApp } from '../configure-app';
import { RouteAwareThrottlerGuard, buildThrottlerModuleOptions } from '../rate-limit';

@Controller()
class StubController {
  @Get('ping') ping() { return { ok: true }; }
  @Post('echo') echo(@Body() body: Record<string, unknown>) { return { size: JSON.stringify(body).length }; }
  @Post('auth/login') login() { return { ok: true }; }
  @Post('wallet/transfers/prepare') prepare() { return { ok: true }; }
}

/** Loopback-only HTTP: boots the real configureApp() against a stub controller. No DB, Redis or external network. */
async function boot(env: Record<string, string | undefined>) {
  const moduleRef = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot(buildThrottlerModuleOptions(env))],
    controllers: [StubController],
    providers: [{ provide: APP_GUARD, useClass: RouteAwareThrottlerGuard }],
  }).compile();
  const app: INestApplication = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const info = configureApp(app as NestExpressApplication, env);
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  return { app, base, info };
}

const dev = { NODE_ENV: 'development', STOREFRONT_ORIGIN: 'http://localhost:3000,https://shop.example.com' };

test('security headers on API responses; no X-Powered-By; no HSTS on development', async () => {
  const { app, base } = await boot(dev);
  try {
    const res = await fetch(`${base}/v1/ping`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.equal(res.headers.get('strict-transport-security'), null);
  } finally {
    await app.close();
  }
});

test('HSTS is added when the runtime is production-like', async () => {
  const { app, base } = await boot({ NODE_ENV: 'production' });
  try {
    assert.match((await fetch(`${base}/v1/ping`)).headers.get('strict-transport-security') ?? '', /max-age=/);
  } finally {
    await app.close();
  }
});

test('CORS: allowlisted origin is echoed (never *), no credentials, explicit methods and headers', async () => {
  const { app, base } = await boot(dev);
  try {
    const preflight = await fetch(`${base}/v1/wallet/transfers/prepare`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://shop.example.com', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,idempotency-key,x-customer-email' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://shop.example.com');
    assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
    const allowHeaders = (preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    for (const header of ['content-type', 'idempotency-key', 'x-customer-email']) assert.ok(allowHeaders.includes(header), header);
    assert.ok(!allowHeaders.includes('x-admin-token'));
    assert.ok(!allowHeaders.includes('*'));
    const methods = preflight.headers.get('access-control-allow-methods') ?? '';
    assert.ok(methods.includes('POST') && !methods.includes('*'));
    assert.equal(preflight.headers.get('vary')?.toLowerCase().includes('origin'), true);

    const actual = await fetch(`${base}/v1/ping`, { headers: { Origin: 'http://localhost:3000' } });
    assert.equal(actual.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  } finally {
    await app.close();
  }
});

test('CORS: origins outside the allowlist (including look-alikes and null) get no CORS headers', async () => {
  const { app, base } = await boot(dev);
  try {
    for (const origin of ['https://evil.example', 'https://shop.example.com.evil.example', 'http://shop.example.com', 'http://localhost:3001', 'null']) {
      const res = await fetch(`${base}/v1/ping`, { headers: { Origin: origin } });
      assert.equal(res.headers.get('access-control-allow-origin'), null, origin);
    }
  } finally {
    await app.close();
  }
});

test('CORS: with STOREFRONT_ORIGIN unset no origin is allowed', async () => {
  const { app, base } = await boot({ NODE_ENV: 'development' });
  try {
    const res = await fetch(`${base}/v1/ping`, { headers: { Origin: 'http://localhost:3000' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  } finally {
    await app.close();
  }
});

test('JSON body limit is 100kb: 413 above, accepted below', async () => {
  const { app, base } = await boot(dev);
  try {
    const post = (payload: string) => fetch(`${base}/v1/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
    assert.equal((await post(JSON.stringify({ blob: 'a'.repeat(50_000) }))).status, 201);
    const big = await post(JSON.stringify({ blob: 'a'.repeat(101 * 1024) }));
    assert.equal(big.status, 413);
  } finally {
    await app.close();
  }
});

test('Swagger UI gating over HTTP', async () => {
  const cases: [Record<string, string | undefined>, number][] = [
    [{ NODE_ENV: 'development' }, 200],
    [{ NODE_ENV: 'test' }, 200],
    [{ NODE_ENV: 'production' }, 404],
    [{ NODE_ENV: 'staging' }, 404],
    [{ NODE_ENV: undefined }, 404],
    [{ NODE_ENV: 'production', ENABLE_API_DOCS: 'true' }, 200],
    [{ NODE_ENV: 'production', ENABLE_API_DOCS: 'false' }, 404],
  ];
  for (const [env, expected] of cases) {
    const { app, base, info } = await boot(env);
    try {
      const res = await fetch(`${base}/docs`);
      assert.equal(res.status, expected, JSON.stringify(env));
      assert.equal(info.docs, expected === 200);
      if (expected === 200) assert.equal(res.headers.get('content-security-policy'), null, 'docs are exempt from the API-only CSP');
      const json = await fetch(`${base}/docs-json`);
      assert.equal(json.status, expected, `${JSON.stringify(env)} docs-json`);
    } finally {
      await app.close();
    }
  }
});

test('HTTP 429 on strict routes; spoofed X-Forwarded-For does not help when TRUST_PROXY is unset', async () => {
  const { app, base } = await boot({ ...dev, THROTTLE_AUTH_LIMIT: '2', THROTTLE_MONEY_LIMIT: '2' });
  try {
    const login = (xff: string) => fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'x-forwarded-for': xff } });
    assert.equal((await login('1.1.1.1')).status, 201);
    assert.equal((await login('2.2.2.2')).status, 201);
    const blocked = await login('3.3.3.3');
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    assert.match(JSON.stringify(await blocked.json()), /Too many requests/);
    // other strict buckets and normal routes remain available
    assert.equal((await fetch(`${base}/v1/wallet/transfers/prepare`, { method: 'POST' })).status, 201);
    assert.equal((await fetch(`${base}/v1/ping`)).status, 200);
  } finally {
    await app.close();
  }
});

test('with TRUST_PROXY=1 the nearest proxy-supplied client address becomes the tracker', async () => {
  const { app, base, info } = await boot({ ...dev, TRUST_PROXY: '1', THROTTLE_AUTH_LIMIT: '1' });
  try {
    assert.equal(info.trustProxy, 1);
    const login = (xff: string) => fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'x-forwarded-for': xff } });
    assert.equal((await login('10.0.0.1')).status, 201);
    assert.equal((await login('10.0.0.1')).status, 429);
    assert.equal((await login('10.0.0.2')).status, 201, 'a different client behind the trusted proxy has its own bucket');
  } finally {
    await app.close();
  }
});

test('configureApp refuses TRUST_PROXY=true', async () => {
  await assert.rejects(boot({ ...dev, TRUST_PROXY: 'true' }), /TRUST_PROXY=true/);
});
