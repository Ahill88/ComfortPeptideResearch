import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, afterEach, test } from 'node:test';
import { INestApplication, Logger, Module, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { configureApp } from '../../../config/configure-app';
import { RouteAwareThrottlerGuard, buildThrottlerModuleOptions } from '../../../config/rate-limit';
import { PrismaService } from '../../../prisma.service';
import { MOONPAY_WEBHOOK_CONFIG, MoonPayWebhookConfig, loadMoonPayWebhookConfig } from '../moonpay-webhook.config';
import { MOONPAY_WEBHOOK_THROTTLE, MoonPayWebhookController } from '../moonpay-webhook.controller';
import { MoonPayWebhookService } from '../moonpay-webhook.service';
import { INTENT_ID, MOONPAY_TX_ID, WebhookDb, buyEvent, makeWebhookDb, moonPayHeader, seedIntent } from './moonpay-webhook.helpers';

Logger.overrideLogger(false);

const KEY = 'whk_test_0123456789abcdef';
const NOW_SECONDS = 1_800_000_000;
const warnings: string[] = [];
const realWarn = Logger.prototype.warn;
Logger.prototype.warn = function (message: unknown, ...rest: unknown[]) {
  warnings.push(String(message));
  return realWarn.call(this, message, ...rest);
};

const apps: INestApplication[] = [];
// Each booted app registers process signal hooks (enableShutdownHooks), so close them as soon as a test is done.
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
after(() => {
  Logger.prototype.warn = realWarn;
});

async function boot(config: MoonPayWebhookConfig = { webhookKey: KEY, toleranceSeconds: 300 }, env: Record<string, string | undefined> = { NODE_ENV: 'test' }) {
  const { db, prisma } = makeWebhookDb();
  seedIntent(db);
  @Module({
    imports: [ThrottlerModule.forRoot(buildThrottlerModuleOptions(env))],
    controllers: [MoonPayWebhookController],
    providers: [
      { provide: PrismaService, useValue: prisma },
      { provide: MOONPAY_WEBHOOK_CONFIG, useValue: config },
      MoonPayWebhookService,
      { provide: APP_GUARD, useClass: RouteAwareThrottlerGuard },
    ],
  })
  class TestModule {}
  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  configureApp(app, env); // the same transport hardening main.ts applies, including raw-body capture for this route
  app.get(MoonPayWebhookController).clock = () => NOW_SECONDS * 1000;
  await app.listen(0, '127.0.0.1');
  apps.push(app);
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  return { app, base, db };
}

interface Send {
  body?: string;
  header?: string | null;
  contentType?: string;
  path?: string;
}
const post = (base: string, { body = '{}', header, contentType = 'application/json', path = '/v1/webhooks/moonpay' }: Send) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': contentType, ...(header ? { 'moonpay-signature-v2': header } : {}) }, body });

const signed = (event: unknown, over: { key?: string; t?: number; spaced?: boolean } = {}) => {
  const body = over.spaced ? JSON.stringify(event, null, 2) : JSON.stringify(event);
  return { body, header: moonPayHeader(body, over.key ?? KEY, over.t ?? NOW_SECONDS) };
};
const snapshot = (db: WebhookDb) => JSON.stringify([db.onRampIntent.rows, db.walletAuditEvent.rows]);

test('a valid signature is accepted for each of the three buy event types (200 {received:true}) and applied', async () => {
  for (const [type, status, expected] of [
    ['transaction_created', 'waitingPayment', 'PENDING'],
    ['transaction_updated', 'completed', 'COMPLETED'],
    ['transaction_failed', 'failed', 'FAILED'],
  ] as const) {
    const { base, db } = await boot();
    const res = await post(base, signed(buyEvent({ type, status })));
    assert.equal(res.status, 200, type);
    assert.deepEqual(await res.json(), { received: true });
    assert.equal(db.onRampIntent.rows[0].status, expected, type);
    assert.equal(db.onRampIntent.rows[0].externalReference, MOONPAY_TX_ID);
    assert.equal(db.walletAuditEvent.rows[0].action, 'MOONPAY_WEBHOOK_PROCESSED');
  }
});

test('route is mounted at POST /v1/webhooks/moonpay only; no identity header or admin token is needed; GET is 404', async () => {
  const { base } = await boot();
  assert.equal((await post(base, { ...signed(buyEvent()) })).status, 200);
  assert.equal((await fetch(`${base}/v1/webhooks/moonpay`)).status, 404);
  assert.equal((await post(base, { ...signed(buyEvent()), path: '/webhooks/moonpay' })).status, 404, 'the global version prefix is required');
});

test('missing header, malformed header, wrong key, tampered body and stale timestamp => 401, nothing processed, no state change', async () => {
  const { base, db } = await boot();
  const before = snapshot(db);
  const good = signed(buyEvent({ status: 'completed' }));
  const mac = good.header.split('s=')[1];
  const tampered = good.body.replace('"completed"', '"waitingPayment"');
  const bodies: [string, Send][] = [
    ['missing header', { body: good.body }],
    ['empty header', { body: good.body, header: '' }],
    ['malformed (no t)', { body: good.body, header: `s=${mac}` }],
    ['malformed (short mac)', { body: good.body, header: `t=${NOW_SECONDS},s=${mac.slice(0, 40)}` }],
    ['malformed (junk)', { body: good.body, header: 'garbage' }],
    ['legacy header format', { body: good.body, header: Buffer.from(mac, 'hex').toString('base64') }],
    ['wrong key', { ...signed(buyEvent({ status: 'completed' }), { key: 'a-different-key' }) }],
    ['tampered body', { body: tampered, header: good.header }],
    ['stale timestamp', { ...signed(buyEvent({ status: 'completed' }), { t: NOW_SECONDS - 301 }) }],
    ['future timestamp', { ...signed(buyEvent({ status: 'completed' }), { t: NOW_SECONDS + 301 }) }],
    ['empty body', { body: '', header: good.header }],
    ['invalid JSON, unsigned', { body: '{not json', header: `t=${NOW_SECONDS},s=${mac}` }],
  ];
  const responses: string[] = [];
  for (const [label, send] of bodies) {
    const res = await post(base, send);
    assert.equal(res.status, 401, label);
    responses.push(await res.text());
  }
  assert.equal(new Set(responses).size, 1, 'one generic 401 body for every reason (no oracle)');
  assert.equal(snapshot(db), before, 'state unchanged');
  assert.equal(db.transactions, 0, 'no database transaction was even opened');
  assert.equal(db.walletAuditEvent.rows.length, 0);
});

test('raw body: a re-serialised body fails while the exact raw bytes pass (and the content type does not matter)', async () => {
  const { base, db } = await boot();
  const event = buyEvent({ status: 'completed' });
  const spaced = signed(event, { spaced: true }); // pretty-printed: JSON.parse + JSON.stringify would NOT reproduce it
  assert.notEqual(spaced.body, JSON.stringify(JSON.parse(spaced.body)));
  // MAC computed over the re-serialised form but sent with the pretty-printed bytes => rejected
  const reserialised = { body: spaced.body, header: moonPayHeader(JSON.stringify(JSON.parse(spaced.body)), KEY, NOW_SECONDS) };
  assert.equal((await post(base, reserialised)).status, 401);
  assert.equal(db.onRampIntent.rows[0].status, 'CREATED');
  // MAC over the exact raw bytes => accepted
  assert.equal((await post(base, spaced)).status, 200);
  assert.equal(db.onRampIntent.rows[0].status, 'COMPLETED');
  // unusual-but-valid raw bytes: unicode escapes, odd whitespace, duplicate/unsorted keys, a BOM-free multibyte value
  const odd = `{"data" :${JSON.stringify(buyEvent({ status: 'completed' }).data)} ,\n\t"type":"transaction_updated","externalCustomerId":"cust_1","note":"é\\u00e9"}`;
  const { base: base2, db: db2 } = await boot();
  assert.equal((await post(base2, { body: odd, header: moonPayHeader(odd, KEY, NOW_SECONDS) })).status, 200);
  assert.equal(db2.onRampIntent.rows[0].status, 'COMPLETED');
  // a text/plain content type does not change how the route reads the body
  const { base: base3, db: db3 } = await boot();
  assert.equal((await post(base3, { ...signed(buyEvent({ status: 'pending' })), contentType: 'text/plain' })).status, 200);
  assert.equal(db3.onRampIntent.rows[0].status, 'PENDING');
});

test('authentic but invalid body: invalid JSON => 400; JSON that is not a BuyTransaction envelope => 400; nothing changes', async () => {
  const { base, db } = await boot();
  const before = snapshot(db);
  const raw = (body: string) => ({ body, header: moonPayHeader(body, KEY, NOW_SECONDS) });
  for (const body of ['{not json', '', '[1,2]', 'null', '"x"', '{"type":"transaction_updated"}', '{"type":"transaction_updated","data":{"id":"x"}}', '{"type":5}']) {
    assert.equal((await post(base, raw(body))).status, 400, body);
  }
  assert.equal(snapshot(db), before);
});

test('other event types are acknowledged with 200 and ignored (sell_*, identity_check_updated, swap_*, unknown)', async () => {
  const { base, db } = await boot();
  const before = snapshot(db);
  for (const type of ['sell_transaction_created', 'sell_transaction_updated', 'sell_transaction_failed', 'sell_transaction_requote_required', 'identity_check_updated', 'virtual_account_status_updated', 'swap_transaction_updated', 'brand_new_type']) {
    assert.equal((await post(base, signed({ ...buyEvent({ status: 'completed' }), type }))).status, 200, type);
  }
  // even a body that is not a BuyTransaction is fine when the type is not a buy type
  assert.equal((await post(base, signed({ type: 'identity_check_updated', data: { whatever: true } }))).status, 200);
  assert.equal(snapshot(db), before);
  assert.equal(db.transactions, 0);
});

test('MOONPAY_WEBHOOK_KEY unset => 503 and nothing processed, even for a perfectly formed request (every runtime)', async () => {
  for (const nodeEnv of ['test', 'development', 'production', 'staging', undefined]) {
    const config = loadMoonPayWebhookConfig({ NODE_ENV: nodeEnv });
    assert.equal(config.webhookKey, null, String(nodeEnv));
    const { base, db } = await boot(config, { NODE_ENV: nodeEnv });
    const before = snapshot(db);
    for (const send of [signed(buyEvent({ status: 'completed' })), { body: '{}' }, { body: '{}', header: 'x' }]) {
      const res = await post(base, send);
      assert.equal(res.status, 503, `${nodeEnv}`);
    }
    assert.equal(snapshot(db), before);
    assert.equal(db.transactions, 0);
  }
  // an empty-string key is the same as unset; it must never turn into "sign with the empty key"
  const blank = loadMoonPayWebhookConfig({ MOONPAY_WEBHOOK_KEY: '' });
  const { base, db } = await boot(blank);
  assert.equal((await post(base, signed(buyEvent(), { key: '' }))).status, 503);
  assert.equal(db.walletAuditEvent.rows.length, 0);
});

test('the configured tolerance is honoured in both directions', async () => {
  const { base } = await boot({ webhookKey: KEY, toleranceSeconds: 1000 });
  assert.equal((await post(base, signed(buyEvent(), { t: NOW_SECONDS - 600 }))).status, 200);
  assert.equal((await post(base, signed(buyEvent(), { t: NOW_SECONDS + 600 }))).status, 200);
  assert.equal((await post(base, signed(buyEvent(), { t: NOW_SECONDS - 1001 }))).status, 401);
});

test('logging: stale-but-authentic is logged distinctly; neither the signature, the key nor the body is ever logged', async () => {
  const { base } = await boot();
  warnings.length = 0;
  const stale = signed(buyEvent({ status: 'completed' }), { t: NOW_SECONDS - 4000 });
  assert.equal((await post(base, stale)).status, 401);
  const bad = signed(buyEvent({ status: 'completed' }), { key: 'wrong' });
  assert.equal((await post(base, bad)).status, 401);
  assert.equal((await post(base, { body: '{}' })).status, 401);
  const staleLog = warnings.filter((w) => /stale timestamp/.test(w));
  assert.equal(staleLog.length, 1, 'exactly the authentic stale request is reported as stale');
  assert.match(staleLog[0], /age 4000s/);
  assert.ok(warnings.some((w) => /mismatch signature/.test(w)) && warnings.some((w) => /missing signature/.test(w)));
  const logged = warnings.join('\n');
  for (const needle of [stale.header.split('s=')[1], bad.header.split('s=')[1], KEY, 'wrong', INTENT_ID, '"externalTransactionId"']) assert.ok(!logged.includes(needle), `log leaked ${needle.slice(0, 12)}`);
});

test('body limit stays 100kb for this route: 413 above (before any verification work)', async () => {
  const { base, db } = await boot();
  const big = JSON.stringify({ type: 'identity_check_updated', pad: 'a'.repeat(101 * 1024) });
  assert.equal((await post(base, { body: big, header: moonPayHeader(big, KEY, NOW_SECONDS) })).status, 413);
  const ok = JSON.stringify({ type: 'identity_check_updated', pad: 'a'.repeat(50 * 1024) });
  assert.equal((await post(base, { body: ok, header: moonPayHeader(ok, KEY, NOW_SECONDS) })).status, 200);
  assert.equal(db.transactions, 0);
});

test('rate limiting: a MoonPay retry burst far above the global 120/min default is not throttled; a flood is still capped, and rejection stays cheap', async () => {
  const { base, db } = await boot();
  const good = signed(buyEvent({ status: 'pending' }));
  // 200 deliveries (duplicates / retries) from one address in a burst: all answered 200, none 429
  const burst = await Promise.all(Array.from({ length: 200 }, () => post(base, good)));
  assert.deepEqual([...new Set(burst.map((r) => r.status))], [200]);
  assert.equal(db.walletAuditEvent.rows.length, 1, 'duplicates stayed no-ops under the burst');
  // bad-signature requests are cheap: 401 without ever opening a database transaction
  const txBefore = db.transactions;
  const flood: number[] = [];
  for (let i = 0; i < MOONPAY_WEBHOOK_THROTTLE.limit; i += 100) {
    flood.push(...(await Promise.all(Array.from({ length: 100 }, () => post(base, { body: '{}', header: `t=${NOW_SECONDS},s=${'0'.repeat(64)}` })))).map((r) => r.status));
  }
  assert.ok(flood.includes(429), 'a sustained flood is eventually throttled');
  assert.ok(flood.every((s) => s === 401 || s === 429));
  assert.equal(db.transactions, txBefore, 'bad signatures never reached the database');
});
