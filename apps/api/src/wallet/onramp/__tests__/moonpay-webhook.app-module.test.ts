import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, afterEach, before, test } from 'node:test';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { configureApp } from '../../../config/configure-app';
import { HEALTH_PREFIX_EXCLUDE } from '../../../health/health.module';
import { SolanaUsdcProcessor } from '../../../payments/solana-usdc.processor';
import { PrismaService } from '../../../prisma.service';
import { WebhookDb, buyEvent, makeWebhookDb, moonPayHeader, seedIntent } from './moonpay-webhook.helpers';

/**
 * Boots the REAL AppModule graph (same overrides as src/__tests__/app-module.test.ts: no Postgres, no Redis) and proves
 * the MoonPay webhook is mounted at POST /v1/webhooks/moonpay through the real wiring, with the real global throttler,
 * the real configureApp() raw-body capture and no identity/admin guard in front of it.
 */
Logger.overrideLogger(false);
const KEY = 'whk_app_module_key';
const saved: Record<string, string | undefined> = {};
const envOverrides: Record<string, string | undefined> = {
  NODE_ENV: 'test',
  ADMIN_API_TOKEN: 'a'.repeat(40),
  WALLET_RECONCILE_INTERVAL_MS: '0',
  WALLET_CHAIN_MODE: undefined,
  WALLET_PREPARED_STORE: undefined,
  SOLANA_USDC_TREASURY: '11111111111111111111111111111111',
  MOONPAY_WEBHOOK_TOLERANCE_SECONDS: undefined,
};
const running: INestApplication[] = [];

before(() => {
  for (const [key, value] of Object.entries({ ...envOverrides, MOONPAY_WEBHOOK_KEY: undefined })) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
afterEach(async () => {
  for (const app of running.splice(0)) await app.close();
});
after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function bootAppModule(webhookKey: string | undefined): Promise<{ base: string; db: WebhookDb }> {
  if (webhookKey === undefined) delete process.env.MOONPAY_WEBHOOK_KEY;
  else process.env.MOONPAY_WEBHOOK_KEY = webhookKey;
  const { AppModule } = await import('../../../app.module');
  const { db, prisma } = makeWebhookDb();
  seedIntent(db);
  const queue = { add: async () => undefined, close: async () => undefined };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService).useValue(prisma)
    .overrideProvider(getQueueToken('payment-confirmation')).useValue(queue)
    .overrideProvider(SolanaUsdcProcessor).useValue({})
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  app.setGlobalPrefix('v1', { exclude: HEALTH_PREFIX_EXCLUDE });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  configureApp(app, process.env);
  await app.listen(0, '127.0.0.1');
  running.push(app);
  return { base: (await app.getUrl()).replace('[::1]', '127.0.0.1'), db };
}

const send = (base: string, body: string, header?: string) =>
  fetch(`${base}/v1/webhooks/moonpay`, { method: 'POST', headers: { 'content-type': 'application/json', ...(header ? { 'moonpay-signature-v2': header } : {}) }, body });

test('AppModule: POST /v1/webhooks/moonpay is mounted, unguarded by identity/admin guards, signature-authenticated, and updates the intent', async () => {
  const { base, db } = await bootAppModule(KEY);
  // no signature: 401 from the webhook itself (a guard would answer 401 too, so also prove the signed path reaches the handler)
  assert.equal((await send(base, '{}')).status, 401);
  const body = JSON.stringify(buyEvent({ status: 'completed' }), null, 1);
  const t = Math.floor(Date.now() / 1000);
  const res = await send(base, body, moonPayHeader(body, KEY, t));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { received: true });
  assert.equal(db.onRampIntent.rows[0].status, 'COMPLETED');
  assert.equal(db.walletAuditEvent.rows.length, 1);
  // wrong key and an unprefixed path
  assert.equal((await send(base, body, moonPayHeader(body, 'wrong', t))).status, 401);
  assert.equal((await fetch(`${base}/webhooks/moonpay`, { method: 'POST', body })).status, 404);
  // the unrelated unauthenticated surface is unchanged: the wallet routes still demand identity
  assert.equal((await fetch(`${base}/v1/wallet`)).status, 401);
});

test('AppModule: without MOONPAY_WEBHOOK_KEY the mounted route fails closed with 503 and processes nothing', async () => {
  const { base, db } = await bootAppModule(undefined);
  const body = JSON.stringify(buyEvent({ status: 'completed' }));
  const header = moonPayHeader(body, KEY, Math.floor(Date.now() / 1000));
  assert.equal((await send(base, body, header)).status, 503);
  assert.equal((await send(base, '{}')).status, 503);
  assert.equal(db.onRampIntent.rows[0].status, 'CREATED');
  assert.equal(db.walletAuditEvent.rows.length, 0);
  assert.equal(db.transactions, 0);
});
