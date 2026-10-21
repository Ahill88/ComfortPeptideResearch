/** The `public` rate-limit bucket (config/rate-limit.ts) that protects the unauthenticated COA verification routes. */
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { DEFAULT_RATE_LIMITS, RouteAwareThrottlerGuard, buildThrottlerModuleOptions, loadRateLimitConfig, selectRateLimitBucket } from '../../config/rate-limit';
import { validateEnv } from '../../config/env.validation';
import { PrismaService } from '../../prisma.service';
import { CoaPublicController } from '../coa-public.controller';
import { CoaPublicService } from '../coa-public.service';

test('bucket selection: everything under /public is the public bucket (version prefix, case, query and encoding ignored); other routes are unchanged', () => {
  for (const path of ['/v1/public/lots/LOT-1', '/public/anchor-info', '/V1/PUBLIC/coa/by-hash/ab', '/v1//public/lots/x?y=1', '/v1/%70ublic/anchor-info']) assert.equal(selectRateLimitBucket(path), 'public', path);
  for (const path of ['/v1/products', '/v1/orders', '/v1/admin/lots', '/v1/publicity', '/v1/x/public', '/v1/auth/login', '/v1/wallet/transfers/prepare']) {
    assert.notEqual(selectRateLimitBucket(path), 'public', path);
  }
  assert.equal(selectRateLimitBucket('/v1/auth/login'), 'auth');
  assert.equal(selectRateLimitBucket('/v1/wallet/transfers/prepare'), 'money');
});

test('defaults: public is more generous than the default bucket but bounded, env override works, bad values fall back, startup validation reports them', () => {
  assert.deepEqual(DEFAULT_RATE_LIMITS.public, { limit: 180, ttl: 60_000 });
  assert.ok(DEFAULT_RATE_LIMITS.public.limit > DEFAULT_RATE_LIMITS.default.limit);
  assert.equal(loadRateLimitConfig({ THROTTLE_PUBLIC_LIMIT: '500' }).public.limit, 500);
  assert.equal(loadRateLimitConfig({ THROTTLE_PUBLIC_LIMIT: '0' }).public.limit, 180);
  assert.equal(loadRateLimitConfig({ THROTTLE_PUBLIC_LIMIT: 'lots' }).public.limit, 180);
  assert.match(JSON.stringify(validateEnv({ NODE_ENV: 'test', THROTTLE_PUBLIC_LIMIT: '0' }).errors), /THROTTLE_PUBLIC_LIMIT/);
  assert.deepEqual(validateEnv({ NODE_ENV: 'test', THROTTLE_PUBLIC_LIMIT: '300' }).errors, []);
});

let app: INestApplication;
let base = '';
before(async () => {
  const env = { THROTTLE_DEFAULT_LIMIT: '3', THROTTLE_PUBLIC_LIMIT: '8' };
  const moduleRef = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot(buildThrottlerModuleOptions(env))],
    controllers: [CoaPublicController],
    providers: [CoaPublicService, { provide: PrismaService, useValue: {} }, { provide: APP_GUARD, useClass: RouteAwareThrottlerGuard }],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
});
after(async () => {
  await app?.close();
});

test('HTTP: public routes use only the public bucket (not the shared default one), then answer 429 with Retry-After', async () => {
  const statuses: number[] = [];
  let blocked: Response | undefined;
  for (let i = 0; i < 10; i += 1) {
    const res = await fetch(`${base}/v1/public/anchor-info`);
    statuses.push(res.status);
    if (res.status === 429) blocked ??= res;
  }
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 200, 200, 429, 429], 'the default limit of 3 does not apply to public routes; the public limit of 8 does');
  assert.ok(Number(blocked?.headers.get('retry-after')) > 0);
  // the public bucket is shared across all public routes of the client
  assert.equal((await fetch(`${base}/v1/public/lots/LOT-1`)).status, 429);
  assert.equal((await fetch(`${base}/v1/public/coa/by-hash/${'a'.repeat(64)}`)).status, 429);
});
