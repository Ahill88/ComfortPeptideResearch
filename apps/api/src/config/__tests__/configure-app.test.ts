import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import { Body, Controller, Get, INestApplication, Post, Req, ValidationPipe } from '@nestjs/common';
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
  /** Reports what a handler sees for the MoonPay webhook route: the body must be the untouched raw bytes. */
  @Post('webhooks/moonpay') hook(@Req() req: { body: unknown }) {
    return Buffer.isBuffer(req.body) ? { raw: true, text: req.body.toString('utf8'), length: req.body.length } : { raw: false };
  }
  @Post('webhooks/other') other(@Req() req: { body: unknown }) { return { raw: Buffer.isBuffer(req.body), body: req.body }; }
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

test('MoonPay webhook route receives the exact raw bytes: a MAC over them verifies, a re-serialised body would not; other routes still get parsed JSON', async () => {
  const { app, base } = await boot(dev);
  try {
    const key = 'whk-test';
    const mac = (message: string) => createHmac('sha256', key).update(message).digest('hex');
    // pretty-printed, odd spacing, unicode escape: JSON.parse + JSON.stringify cannot reproduce these bytes
    const raw = '{ "type" : "transaction_updated",\n  "data":{"id":"abc","note":"\\u00e9"} }';
    const timestamp = '1800000000';
    const send = (path: string, body: string, contentType = 'application/json') => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': contentType }, body });

    const res = await send('/v1/webhooks/moonpay', raw);
    assert.equal(res.status, 201);
    const seen = (await res.json()) as { raw: boolean; text: string; length: number };
    assert.equal(seen.raw, true, 'the handler gets a Buffer');
    assert.equal(seen.text, raw, 'byte-for-byte identical to what was sent');
    assert.equal(seen.length, Buffer.byteLength(raw));

    const signedOverRaw = mac(`${timestamp}.${raw}`);
    assert.equal(mac(`${timestamp}.${seen.text}`), signedOverRaw, 'the raw body verifies');
    const reserialised = JSON.stringify(JSON.parse(seen.text));
    assert.notEqual(reserialised, raw);
    assert.notEqual(mac(`${timestamp}.${reserialised}`), signedOverRaw, 'a re-serialised body would FAIL verification');

    // casing, trailing slash and other content types still reach the raw reader; query strings are ignored for matching
    for (const path of ['/v1/Webhooks/MoonPay', '/v1/webhooks/moonpay/', '/v1/webhooks/moonpay?x=1']) {
      const r = await send(path, raw, 'text/plain');
      assert.equal(r.status, 201, path);
      assert.equal(((await r.json()) as { text: string }).text, raw, path);
    }
    // a request with no body is left as `{}` (no Buffer); the webhook controller treats that as zero bytes
    assert.equal((await fetch(`${base}/v1/webhooks/moonpay`, { method: 'POST' })).status, 201);

    // every other route is unchanged: JSON is parsed into an object by the normal parser
    const other = (await (await send('/v1/webhooks/other', raw)).json()) as { raw: boolean; body: { type: string } };
    assert.equal(other.raw, false);
    assert.equal(other.body.type, 'transaction_updated');
    const echo = await fetch(`${base}/v1/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
    assert.equal(echo.status, 201);
    // and the 100kb limit still applies to the raw route
    assert.equal((await send('/v1/webhooks/moonpay', JSON.stringify({ blob: 'a'.repeat(101 * 1024) }))).status, 413);
    assert.equal((await send('/v1/webhooks/moonpay', JSON.stringify({ blob: 'a'.repeat(50_000) }))).status, 201);
  } finally {
    await app.close();
  }
});
