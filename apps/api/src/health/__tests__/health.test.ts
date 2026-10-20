import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Controller, Get, Global, INestApplication, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { configureApp } from '../../config/configure-app';
import { RouteAwareThrottlerGuard, buildThrottlerModuleOptions } from '../../config/rate-limit';
import { PrismaService } from '../../prisma.service';
import { DB_PROBE_TIMEOUT_MS, HealthService } from '../health.service';
import { HEALTH_PREFIX_EXCLUDE, HealthModule } from '../health.module';

const SECRET_URL = 'postgresql://helix:s3cr3t-pass@db.internal.example:5432/helix_field';

/** In-memory PrismaService double: only $queryRaw (tagged template) is used by the probe. */
class FakePrisma {
  calls: string[] = [];
  behavior: 'ok' | 'fail' | 'hang' = 'ok';
  async $queryRaw(strings: TemplateStringsArray) {
    this.calls.push(strings.join('?'));
    if (this.behavior === 'fail') throw Object.assign(new Error(`Can't reach database server at ${SECRET_URL}`), { code: 'P1001' });
    if (this.behavior === 'hang') return new Promise(() => undefined);
    return [{ '?column?': 1 }];
  }
}

@Controller()
class PingController {
  @Get('ping') ping() { return { ok: true }; }
}

async function boot(options: { env?: Record<string, string | undefined>; prefixExclude?: boolean } = {}) {
  const env = { NODE_ENV: 'development', ...options.env };
  const prisma = new FakePrisma();
  @Global()
  @Module({ providers: [{ provide: PrismaService, useValue: prisma }], exports: [PrismaService] })
  class FakePrismaModule {}
  const moduleRef = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot(buildThrottlerModuleOptions(env)), FakePrismaModule, HealthModule],
    controllers: [PingController],
    providers: [{ provide: APP_GUARD, useClass: RouteAwareThrottlerGuard }],
  }).compile();
  const app: INestApplication = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  // Same global wiring as main.ts (prefix v1) plus the transport hardening it applies.
  app.setGlobalPrefix('v1', options.prefixExclude ? { exclude: HEALTH_PREFIX_EXCLUDE } : undefined);
  configureApp(app as NestExpressApplication, env);
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  return { app, base, prisma };
}

test('liveness is 200 {status:ok}, uses no database, and keeps Cache-Control: no-store', async () => {
  const { app, base, prisma } = await boot();
  try {
    prisma.behavior = 'fail';
    const res = await fetch(`${base}/v1/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.deepEqual(prisma.calls, [], 'liveness must not query the database');
  } finally {
    await app.close();
  }
});

test('readiness: 200 {status:ok} after one SELECT 1; Cache-Control stays no-store', async () => {
  const { app, base, prisma } = await boot();
  try {
    const res = await fetch(`${base}/v1/health/ready`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(prisma.calls, ['SELECT 1']);
  } finally {
    await app.close();
  }
});

test('readiness: database failure is a generic 503 that never leaks the connection string or error text', async () => {
  const { app, base, prisma } = await boot();
  try {
    prisma.behavior = 'fail';
    const res = await fetch(`${base}/v1/health/ready`);
    const text = await res.text();
    assert.equal(res.status, 503);
    assert.deepEqual(JSON.parse(text), { status: 'unavailable' });
    for (const secret of ['s3cr3t', 'postgresql', 'db.internal', 'P1001', 'reach']) assert.ok(!text.includes(secret), `leaked ${secret}`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    // liveness is unaffected by the database being down
    assert.equal((await fetch(`${base}/v1/health`)).status, 200);
  } finally {
    await app.close();
  }
});

test('readiness: a hung database yields false after the timeout (default budget is 2s); late rejections are swallowed', async () => {
  assert.equal(DB_PROBE_TIMEOUT_MS, 2000);
  const prisma = new FakePrisma();
  const service = new HealthService(prisma as unknown as PrismaService);
  prisma.behavior = 'hang';
  const started = Date.now();
  assert.equal(await service.isDatabaseReady(50), false);
  assert.ok(Date.now() - started < 1000);

  // Slow failure that settles after the timeout already won must not become an unhandled rejection.
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const slowFail = { $queryRaw: () => new Promise((_, reject) => setTimeout(() => reject(new Error(SECRET_URL)), 80)) };
    assert.equal(await new HealthService(slowFail as unknown as PrismaService).isDatabaseReady(10), false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('probes are never throttled and do not consume the default budget, while other routes still are', async () => {
  const { app, base } = await boot({ env: { THROTTLE_DEFAULT_LIMIT: '2' } });
  try {
    for (let i = 0; i < 12; i++) {
      assert.equal((await fetch(`${base}/v1/health`)).status, 200, `live #${i}`);
      assert.equal((await fetch(`${base}/v1/health/ready`)).status, 200, `ready #${i}`);
    }
    // 24 probe hits did not eat the limit of 2 for ordinary traffic from the same client...
    assert.equal((await fetch(`${base}/v1/ping`)).status, 200);
    assert.equal((await fetch(`${base}/v1/ping`)).status, 200);
    // ...but the limiter itself is active.
    assert.equal((await fetch(`${base}/v1/ping`)).status, 429);
    // and a throttled client can still be probed
    assert.equal((await fetch(`${base}/v1/health`)).status, 200);
    assert.equal((await fetch(`${base}/v1/health/ready`)).status, 200);
  } finally {
    await app.close();
  }
});

test('with HEALTH_PREFIX_EXCLUDE the probes are served at /health and /health/ready (and no longer under /v1)', async () => {
  const { app, base } = await boot({ prefixExclude: true });
  try {
    for (const path of ['/health', '/health/ready']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
      assert.deepEqual(await res.json(), { status: 'ok' });
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }
    assert.equal((await fetch(`${base}/v1/ping`)).status, 200, 'other routes keep the prefix');
    assert.equal((await fetch(`${base}/ping`)).status, 404);
  } finally {
    await app.close();
  }
});
