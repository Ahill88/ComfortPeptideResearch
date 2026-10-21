import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { redactText } from '../email.redact';
import type { OutboundEmail } from '../email.provider';
import { ConsoleEmailProvider } from '../providers/console.provider';
import { RESEND_SEND_URL, ResendEmailProvider } from '../providers/resend.provider';
import { captureLogs, TOKEN } from './email-support';

const KEY = 're_test_0123456789abcdefghij';
const FROM = 'Helix & Field <orders@example.com>';
const message: OutboundEmail = {
  id: 'cm9abc123', to: 'buyer@customer.example', template: 'password_reset', subject: 'Reset your password',
  text: `Reset: https://shop.example.com/reset-password?token=${TOKEN}\n`, html: '<p>hello</p>',
};

interface Call { url: string; init: RequestInit & { headers: Record<string, string> } }
function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: any) => {
    const call = { url, init } as Call;
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { calls, impl };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const resend = (fetchImpl: typeof fetch, extra: object = {}) => new ResendEmailProvider({ apiKey: KEY, from: FROM, fetchImpl, ...extra });

test('resend: request shape (endpoint, method, auth header, content type, idempotency key, body fields)', async () => {
  const { calls, impl } = fakeFetch(() => json(200, { id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' }));
  const result = await resend(impl).send(message);
  assert.deepEqual(result, { ok: true, providerMessageId: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(RESEND_SEND_URL, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'error', 'never follow a redirect with the Authorization header');
  assert.deepEqual(calls[0].init.headers, { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'helix-email-cm9abc123' });
  assert.deepEqual(JSON.parse(calls[0].init.body as string), { from: FROM, to: ['buyer@customer.example'], subject: 'Reset your password', text: message.text, html: '<p>hello</p>' });
  assert.ok(calls[0].init.signal, 'a timeout signal is attached');
});

test('resend: the idempotency key is stable across retries of the same outbox row and differs between rows', async () => {
  const { calls, impl } = fakeFetch(() => json(200, { id: 'x' }));
  const provider = resend(impl);
  await provider.send(message);
  await provider.send(message);
  await provider.send({ ...message, id: 'other' });
  assert.equal(calls[0].init.headers['Idempotency-Key'], calls[1].init.headers['Idempotency-Key']);
  assert.notEqual(calls[1].init.headers['Idempotency-Key'], calls[2].init.headers['Idempotency-Key']);
  assert.ok(calls[0].init.headers['Idempotency-Key'].length <= 256);
});

test('resend: 2xx without an id is still a success (message accepted)', async () => {
  const { impl } = fakeFetch(() => new Response('', { status: 202 }));
  assert.deepEqual(await resend(impl).send(message), { ok: true, providerMessageId: null });
});

test('resend: permanent failures for 4xx except 429 (and the retryable 408 / concurrent-409 cases)', async () => {
  const cases: [number, string, string][] = [
    [400, 'validation_error', 'invalid from'], [401, 'missing_api_key', 'Missing API Key'], [403, 'validation_error', 'The example.com domain is not verified'],
    [404, 'not_found', 'nope'], [409, 'invalid_idempotent_request', 'body changed'], [422, 'missing_required_field', 'missing to'],
  ];
  for (const [status, name, text] of cases) {
    const { impl } = fakeFetch(() => json(status, { statusCode: status, name, message: text }));
    const result = await resend(impl).send(message);
    assert.equal(result.ok, false);
    assert.equal((result as any).retryable, false, `${status} ${name}`);
    assert.match((result as any).error, new RegExp(`HTTP ${status} ${name}`));
  }
});

test('resend: 429, 5xx, 408, concurrent 409 and non-JSON error pages are retryable; Retry-After is honoured and capped', async () => {
  const retryable: [number, unknown, Record<string, string>][] = [
    [429, { name: 'rate_limit_exceeded', message: 'slow down' }, {}], [429, { name: 'daily_quota_exceeded', message: 'quota' }, {}],
    [500, { name: 'application_error', message: 'oops' }, {}], [503, { name: 'service_unavailable', message: 'down' }, {}], [502, 'bad gateway', {}], [408, {}, {}],
    [409, { name: 'concurrent_idempotent_requests', message: 'in progress' }, {}], [409, { name: 'resource_locked', message: 'busy' }, {}],
  ];
  for (const [status, body, headers] of retryable) {
    const { impl } = fakeFetch(() => (typeof body === 'string' ? new Response(body, { status }) : json(status, body, headers)));
    const result = await resend(impl).send(message);
    assert.equal(result.ok, false);
    assert.equal((result as any).retryable, true, `${status}`);
  }
  const { impl } = fakeFetch(() => json(429, { name: 'rate_limit_exceeded', message: 'x' }, { 'retry-after': '7' }));
  assert.equal(((await resend(impl).send(message)) as any).retryAfterMs, 7000);
  const huge = fakeFetch(() => json(429, { name: 'rate_limit_exceeded', message: 'x' }, { 'retry-after': '999999999' }));
  assert.equal(((await resend(huge.impl).send(message)) as any).retryAfterMs, 6 * 3_600_000);
});

test('resend: network errors and timeouts are retryable; the timeout aborts the request', async () => {
  const boom = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
  const net = await resend(boom).send(message);
  assert.deepEqual({ ok: net.ok, retryable: (net as any).retryable }, { ok: false, retryable: true });

  let aborted = false;
  const hang = ((_url: string, init: any) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')); });
  })) as unknown as typeof fetch;
  const started = Date.now();
  const timedOut = await resend(hang, { timeoutMs: 30 }).send(message);
  assert.equal(aborted, true);
  assert.ok(Date.now() - started < 2000);
  assert.equal((timedOut as any).retryable, true);
  assert.match((timedOut as any).error, /timed out after 30 ms/);
});

test('resend: the default timeout is 10 s', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { RESEND_TIMEOUT_MS } = require('../providers/resend.provider');
  assert.equal(RESEND_TIMEOUT_MS, 10_000);
});

test('resend: provider messages are redacted (key, addresses, tokens, links) and never echo the Authorization header', async () => {
  const hostile = `bad key ${KEY} for buyer@customer.example; see https://shop.example.com/reset-password?token=${TOKEN} Bearer ${KEY} ${TOKEN}`;
  const { impl } = fakeFetch(() => json(401, { name: 'validation_error', message: hostile }));
  const result = (await resend(impl).send(message)) as { error: string };
  for (const leaked of [KEY, 'buyer@customer.example', TOKEN, 'orders@example.com']) assert.ok(!result.error.includes(leaked), `leaked ${leaked}: ${result.error}`);
  const boom = (async () => { throw new Error(`connect failed with ${KEY} to buyer@customer.example`); }) as unknown as typeof fetch;
  const net = (await resend(boom).send(message)) as { error: string };
  assert.ok(!net.error.includes(KEY) && !net.error.includes('buyer@customer.example'), net.error);
});

test('redactText: keys, bearer values, token params, URLs queries, addresses, long opaque strings, control characters, length', () => {
  const out = redactText(`Bearer abc.def-ghi re_abcdefghij1234 token=SHORT1 key=abc123 a@b.example https://x.example/p?token=QQQ&z=1 ${'Ab1'.repeat(14)}\r\nforged line`);
  assert.doesNotMatch(out, /abc\.def|re_abcdefghij|SHORT1|abc123|a@b\.example|QQQ|Ab1Ab1Ab1|[\r\n]/);
  assert.ok(out.includes('forged line'), 'text is flattened, not dropped');
  assert.ok(redactText('x'.repeat(10)).length === 10, 'short ordinary text is preserved');
  assert.ok(redactText('word '.repeat(500)).length <= 303);
  assert.equal(redactText('plain failure: connection reset'), 'plain failure: connection reset');
  assert.ok(!redactText('the value hunter2hunter2 appears', ['hunter2hunter2']).includes('hunter2'));
  assert.equal(redactText(undefined), '');
  assert.equal(redactText('resend HTTP 409 invalid_idempotent_request: body changed'), 'resend HTTP 409 invalid_idempotent_request: body changed', 'snake_case error codes are kept');
});

test('console provider: ONE redacted line (template, recipient domain, id); no address, subject, link or token; no files outside dev/test', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helix-mail-test-'));
  const logs = captureLogs();
  try {
    const provider = new ConsoleEmailProvider({ devFiles: false, dir });
    const result = await provider.send(message);
    assert.deepEqual(result, { ok: true, providerMessageId: 'console:cm9abc123' });
    assert.equal(logs.lines.length, 1);
    assert.match(logs.lines[0], /template=password_reset toDomain=customer\.example id=cm9abc123/);
    for (const leaked of ['buyer', TOKEN, 'Reset your password', 'https://']) assert.ok(!logs.lines[0].includes(leaked), `leaked ${leaked}`);
    assert.deepEqual(readdirSync(dir), [], 'devFiles=false writes nothing');
    assert.equal(existsSync(join(dir, 'cm9abc123.txt')), false);
  } finally {
    logs.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('console provider (dev/test): writes the full rendered message to <dir>/<id>.txt with private permissions; the log line stays redacted', async () => {
  const base = mkdtempSync(join(tmpdir(), 'helix-mail-test-'));
  const dir = join(base, 'nested', 'mail');
  const logs = captureLogs();
  try {
    await new ConsoleEmailProvider({ devFiles: true, dir }).send(message);
    const file = join(dir, 'cm9abc123.txt');
    const body = readFileSync(file, 'utf8');
    assert.ok(body.includes(`https://shop.example.com/reset-password?token=${TOKEN}`), 'the developer can click the link');
    assert.match(body, /^To: buyer@customer\.example\nSubject: Reset your password\n/);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(logs.lines.length, 1);
    assert.ok(!logs.lines[0].includes(TOKEN) && !logs.lines[0].includes('buyer@'));
  } finally {
    logs.restore();
    rmSync(base, { recursive: true, force: true });
  }
});

test('console provider: rotates (keeps only the newest N files), refuses unsafe ids, and a write failure never fails the send', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helix-mail-test-'));
  const logs = captureLogs();
  try {
    const provider = new ConsoleEmailProvider({ devFiles: true, dir, maxFiles: 3 });
    for (let i = 0; i < 6; i += 1) {
      await provider.send({ ...message, id: `id${i}` });
      utimesSync(join(dir, `id${i}.txt`), new Date(2026, 0, 1, 0, 0, i), new Date(2026, 0, 1, 0, 0, i));
    }
    await provider.send({ ...message, id: 'id6' });
    assert.deepEqual(readdirSync(dir).sort(), ['id4.txt', 'id5.txt', 'id6.txt']);

    const unsafe = await provider.send({ ...message, id: '../../etc/evil' });
    assert.equal(unsafe.ok, true);
    assert.equal(existsSync(join(dir, '..', '..', 'etc', 'evil.txt')), false);
    assert.ok(logs.lines.some((l) => /could not be written/.test(l)));

    const blocked = await new ConsoleEmailProvider({ devFiles: true, dir: join(dir, 'id6.txt', 'sub') }).send({ ...message, id: 'zz' });
    assert.equal(blocked.ok, true, 'console delivery is best effort');
  } finally {
    logs.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});
