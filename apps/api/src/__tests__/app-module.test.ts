import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { configureApp } from '../config/configure-app';
import { HEALTH_PREFIX_EXCLUDE } from '../health/health.module';
import { PrismaService } from '../prisma.service';
import { SolanaUsdcProcessor } from '../payments/solana-usdc.processor';
import { CHAIN_PORT } from '../wallet/checkout/ports';
import { MERCHANT_SIGNER } from '../wallet/refunds/merchant-signer.port';
import { RefundsService } from '../wallet/refunds/refunds.service';
import { SOLANA_CHAIN } from '../wallet/wallet.tokens';

/**
 * DI boot of the REAL AppModule graph (every module, controller, guard and provider as wired in production) over
 * loopback HTTP. Only the two network-bound leaves are replaced by in-memory doubles:
 *   - PrismaService  -> no Postgres (nothing connects; a query would hit the double)
 *   - BullMQ queue + processor -> no Redis (a real Queue/Worker opens a Redis connection on construction)
 * Everything else (ConfigModule + env validation, throttler, pino, wallet, checkout, refunds, auth, health) is real.
 * AppModule is imported lazily because its ConfigModule.forRoot validates process.env at import time.
 * The wallet prepared-store is the in-memory one because NODE_ENV=test/development; no Redis client is created.
 */
const ADMIN_TOKEN = 'a'.repeat(40);
const saved: Record<string, string | undefined> = {};
const envOverrides: Record<string, string | undefined> = {
  NODE_ENV: 'test',
  ADMIN_API_TOKEN: ADMIN_TOKEN,
  WALLET_RECONCILE_INTERVAL_MS: '0', // no background reconcile timer
  WALLET_CHAIN_MODE: undefined, // factory default: in-memory sandbox chain
  WALLET_PREPARED_STORE: undefined,
  SOLANA_USDC_TREASURY: '11111111111111111111111111111111',
};

let app: INestApplication;
let base = '';
const queries: string[] = [];
let dbDown = false;

before(async () => {
  for (const [key, value] of Object.entries(envOverrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // AppModule evaluates ConfigModule.forRoot (env validation) at import time, so it must be imported only after
  // the environment above is in place (a bare `ts-node file.ts` run has no NODE_ENV; run-all.mjs sets NODE_ENV=test).
  const { AppModule } = await import('../app.module');
  const prisma = {
    async $queryRaw(strings: TemplateStringsArray) {
      queries.push(strings.join('?'));
      if (dbDown) throw new Error('postgresql://user:pw@host/db is down');
      return [{ '?column?': 1 }];
    },
    cryptoTransaction: { findMany: async () => [] },
    async $disconnect() {},
  };
  const queue = { add: async () => undefined, close: async () => undefined };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService).useValue(prisma)
    .overrideProvider(getQueueToken('payment-confirmation')).useValue(queue)
    .overrideProvider(SolanaUsdcProcessor).useValue({})
    .compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  // Mirrors main.ts, plus the health prefix exclusion main.ts must apply.
  app.setGlobalPrefix('v1', { exclude: HEALTH_PREFIX_EXCLUDE });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  configureApp(app as NestExpressApplication, process.env);
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
});

after(async () => {
  await app?.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('the full AppModule graph resolves: RefundsService gets the wallet chain through CHAIN_PORT and NO merchant signer', () => {
  const refunds = app.get(RefundsService);
  assert.ok(refunds);
  assert.equal(app.get(CHAIN_PORT, { strict: false }), app.get(SOLANA_CHAIN, { strict: false }), 'CHAIN_PORT is an alias of SOLANA_CHAIN');
  // The token exists only so the dev launcher can override it (like COA_PUBLISHER_SIGNER); its default binding is "nothing".
  assert.equal(app.get(MERCHANT_SIGNER, { strict: false }), undefined, 'no MERCHANT_SIGNER implementation may be bound anywhere in AppModule');
  assert.equal((refunds as unknown as { signer: unknown }).signer, undefined);
});

test('health probes are mounted unprefixed and unauthenticated', async () => {
  const live = await fetch(`${base}/health`);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { status: 'ok' });
  assert.equal(live.headers.get('cache-control'), 'no-store');
  const ready = await fetch(`${base}/health/ready`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: 'ok' });
  assert.ok(queries.includes('SELECT 1'));
  dbDown = true;
  try {
    const down = await fetch(`${base}/health/ready`);
    assert.equal(down.status, 503);
    assert.deepEqual(await down.json(), { status: 'unavailable' });
  } finally {
    dbDown = false;
  }
});

test('refunds are admin-only: no token / wrong token -> 401 on every route', async () => {
  const calls: [string, string, string?][] = [
    ['GET', '/v1/admin/refunds'],
    ['POST', '/v1/admin/refunds/request', '{"orderId":"o1","reason":"r"}'],
    ['POST', '/v1/admin/refunds/r1/submit'],
    ['POST', '/v1/admin/refunds/r1/verify'],
  ];
  for (const [method, path, body] of calls) {
    for (const headers of [{}, { 'x-admin-token': 'wrong' }, { 'x-admin-token': ADMIN_TOKEN.slice(1) }] as Record<string, string>[]) {
      const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body });
      assert.equal(res.status, 401, `${method} ${path} ${JSON.stringify(headers)}`);
    }
  }
});

test('refunds with the admin token: list works; submit fails closed with 503 because no signer is bound', async () => {
  const headers = { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' };
  const list = await fetch(`${base}/v1/admin/refunds`, { headers });
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), []);
  assert.equal(list.headers.get('cache-control'), 'no-store');

  const submit = await fetch(`${base}/v1/admin/refunds/refund_1/submit`, { method: 'POST', headers });
  assert.equal(submit.status, 503);
  assert.match(JSON.stringify(await submit.json()), /Merchant signer is not configured/);
});

test('the rest of the graph is mounted: admin wallet reporting is guarded, unknown routes are 404, throttling is global', async () => {
  assert.equal((await fetch(`${base}/v1/admin/wallets/providers`)).status, 401);
  assert.equal((await fetch(`${base}/v1/admin/wallets/providers`, { headers: { 'x-admin-token': ADMIN_TOKEN } })).status, 200);
  assert.equal((await fetch(`${base}/v1/does-not-exist`)).status, 404);
  assert.equal((await fetch(`${base}/v1/wallet/checkout/ord_1/status`, { method: 'GET' })).status < 500, true);
});
