import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { loadMoonPayWebhookConfig, parseToleranceSeconds } from '../moonpay-webhook.config';
import { parseSignatureHeader, verifyMoonPaySignature } from '../moonpay-webhook.signature';
import { moonPayHeader } from './moonpay-webhook.helpers';

const KEY = 'test-webhook-key-123';
const NOW = 1_800_000_000;
const verify = (header: string | undefined, rawBody: string | Buffer, over: Partial<Parameters<typeof verifyMoonPaySignature>[0]> = {}) =>
  verifyMoonPaySignature({ header, rawBody: Buffer.from(rawBody), key: KEY, nowSeconds: NOW, toleranceSeconds: 300, ...over });

test('signature vector: openssl-computed HMAC for t=1492774577 and a fixed body is accepted (independent of node:crypto)', () => {
  const body = '{"type":"transaction_updated","data":{"id":"a"}}';
  const header = 't=1492774577,s=1da7c4b12e328a4b23aab0401530b7ac6afbfc9d2d3885c6b08ef81e7f8f9539';
  assert.deepEqual(verify(header, body, { nowSeconds: 1492774577 }), { ok: true, timestamp: 1492774577 });
});

test('signature vector: computed per the documented algorithm (hex HMAC-SHA256 over "<t>.<raw body>" keyed with the webhook key)', () => {
  const body = '{"type":"transaction_created","data":{"id":"x","status":"waitingPayment"},"externalCustomerId":"c1"}';
  const t = NOW - 5;
  const mac = createHmac('sha256', KEY).update(String(t) + '.' + body).digest('hex');
  assert.equal(mac.length, 64);
  assert.deepEqual(verify(`t=${t},s=${mac}`, body), { ok: true, timestamp: t });
  // uppercase hex is the same MAC
  assert.deepEqual(verify(`t=${t},s=${mac.toUpperCase()}`, body), { ok: true, timestamp: t });
  // the helper used by the other suites agrees with the literal algorithm
  assert.equal(moonPayHeader(body, KEY, t), `t=${t},s=${mac}`);
});

test('the signed message is the exact raw bytes: whitespace / key order changes break it, multibyte bodies work', () => {
  const raw = '{"type": "transaction_updated",  "data":{"id":"é€"}}';
  const t = NOW;
  const header = moonPayHeader(raw, KEY, t);
  assert.equal(verify(header, raw).ok, true);
  assert.equal(verify(header, JSON.stringify(JSON.parse(raw))).ok, false, 're-serialised body must fail');
  assert.equal(verify(header, raw + ' ').ok, false);
  assert.equal(verify(header, Buffer.from(raw, 'utf8').subarray(0, 10)).ok, false);
});

test('wrong key, wrong timestamp binding, and signature copied between bodies are all mismatches', () => {
  const body = '{"a":1}';
  const header = moonPayHeader(body, KEY, NOW);
  assert.deepEqual(verify(header, body, { key: KEY + 'x' }), { ok: false, reason: 'mismatch' });
  // swapping t while keeping s: the MAC covers the timestamp
  assert.deepEqual(verify(header.replace(`t=${NOW}`, `t=${NOW + 1}`), body), { ok: false, reason: 'mismatch' });
  assert.deepEqual(verify(header, '{"a":2}'), { ok: false, reason: 'mismatch' });
  // the legacy header format (no t) is not accepted as V2
  const legacy = createHmac('sha256', KEY).update(body).digest('base64');
  assert.equal(verify(legacy, body).ok, false);
});

test('missing and malformed headers fail closed (never throw)', () => {
  const body = '{}';
  const good = moonPayHeader(body, KEY, NOW);
  const mac = good.split('s=')[1];
  assert.deepEqual(verify(undefined, body), { ok: false, reason: 'missing' });
  assert.deepEqual(verify('', body), { ok: false, reason: 'missing' });
  const malformed = [
    `s=${mac}`, // no timestamp
    `t=${NOW}`, // no signature
    `t=${NOW},s=${mac},v=1`, // extra element
    `t=${NOW},t=${NOW},s=${mac}`, // duplicate t
    `t=${NOW},s=${mac},s=${mac}`, // duplicate s
    `t=${NOW}, s=${mac}`, // space before prefix
    `t=${NOW},s=${mac.slice(0, 62)}`, // short MAC: timingSafeEqual would throw on unequal lengths
    `t=${NOW},s=${mac}00`, // long MAC
    `t=${NOW},s=${mac.slice(0, 63)}g`, // not hex
    `t=${NOW},s=`, // empty
    `t=,s=${mac}`,
    `t=-1,s=${mac}`,
    `t=1.5,s=${mac}`,
    `t=0x10,s=${mac}`,
    `t=${'9'.repeat(40)},s=${mac}`,
    `t${NOW},s${mac}`,
    `=,=`,
    ',',
    `${good},${'a'.repeat(300)}`,
  ];
  for (const header of malformed) assert.deepEqual(verify(header, body), { ok: false, reason: 'malformed' }, header.slice(0, 80));
  // a duplicated HTTP header arrives as a string[] in some stacks
  assert.deepEqual(verifyMoonPaySignature({ header: [good, good] as unknown as string, rawBody: Buffer.from(body), key: KEY, nowSeconds: NOW, toleranceSeconds: 300 }), { ok: false, reason: 'malformed' });
  assert.equal(parseSignatureHeader(good) !== 'malformed', true);
});

test('timestamp tolerance is symmetric and inclusive; stale is reported only for authentic MACs', () => {
  const body = '{}';
  const at = (t: number) => verify(moonPayHeader(body, KEY, t), body);
  assert.equal(at(NOW - 300).ok, true, 'exactly 5 minutes old is accepted');
  assert.equal(at(NOW + 300).ok, true, 'exactly 5 minutes in the future is accepted');
  assert.deepEqual(at(NOW - 301), { ok: false, reason: 'stale', ageSeconds: 301 });
  assert.deepEqual(at(NOW + 301), { ok: false, reason: 'stale', ageSeconds: -301 });
  assert.equal(verify(moonPayHeader(body, KEY, NOW - 100), body, { toleranceSeconds: 60 }).ok, false);
  assert.equal(verify(moonPayHeader(body, KEY, NOW - 100), body, { toleranceSeconds: 600 }).ok, true);
  // an old timestamp with a WRONG mac is a plain mismatch, so unauthenticated senders cannot reach the "stale" log line
  const forged = `t=${NOW - 10_000},s=${'0'.repeat(64)}`;
  assert.deepEqual(verify(forged, body), { ok: false, reason: 'mismatch' });
});

test('config: tolerance defaults to 300, accepts 1..86400, and invalid values fall back to the default (never to "no check")', () => {
  assert.equal(parseToleranceSeconds(undefined), 300);
  assert.equal(parseToleranceSeconds(''), 300);
  assert.equal(parseToleranceSeconds('900'), 900);
  assert.equal(parseToleranceSeconds(' 60 '), 60);
  for (const bad of ['0', '-5', '1.5', 'abc', '86401', '99999999999999999999', 'Infinity']) assert.equal(parseToleranceSeconds(bad), 300, bad);
});

test('config: the webhook key comes only from MOONPAY_WEBHOOK_KEY; blank is unset; the widget URL-signing variable is never used as a fallback', () => {
  assert.equal(loadMoonPayWebhookConfig({}).webhookKey, null);
  assert.equal(loadMoonPayWebhookConfig({ MOONPAY_WEBHOOK_KEY: '   ' }).webhookKey, null);
  assert.equal(loadMoonPayWebhookConfig({ MOONPAY_WEBHOOK_KEY: ' abc ' }).webhookKey, 'abc');
  const other = ['MOONPAY', 'SECRET', 'KEY'].join('_'); // assembled so this file never spells the other credential's name
  assert.equal(loadMoonPayWebhookConfig({ [other]: 'url-signing-value', MOONPAY_PUBLISHABLE_KEY: 'pk_test_1' }).webhookKey, null);
  assert.equal(loadMoonPayWebhookConfig({ MOONPAY_WEBHOOK_TOLERANCE_SECONDS: '120' }).toleranceSeconds, 120);
});
