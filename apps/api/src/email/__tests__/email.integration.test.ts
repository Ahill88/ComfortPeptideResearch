/**
 * DB-backed email suite (skipped by tests/run-all.mjs without TEST_DATABASE_URL). REAL PostgreSQL, REAL AdminSessionGuard and
 * AdminAuditService. Refuses non-local databases and the shared public/dev schemas. Every row it creates is tagged by recipient
 * domain and removed afterwards; nothing is truncated.
 */
import { strict as assert } from 'node:assert';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for the integration suites (run tests/run-all.mjs to see them reported as SKIPPED).');
const parsed = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || !/helix|test/i.test(parsed.pathname)) throw new Error(`Refusing to run: ${parsed.hostname}${parsed.pathname} is not a local helix/test database.`);
if (['public', 'dev'].includes(parsed.searchParams.get('schema') ?? 'public')) throw new Error('Refusing to run the email suite in the shared public/dev schema: set ?schema=<your own schema>.');
process.env.DATABASE_URL = url;
process.env.NODE_ENV = 'test';

import { Global, Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminCoreModule } from '../../admin/admin-core.module';
import { hashSessionToken } from '../../admin/admin-session.guard';
import { PrismaService } from '../../prisma.service';
import { EmailModule } from '../email.module';
import { EmailService } from '../email.service';
import { EMAIL_PORT } from '../email.types';
import { EmailWorker, LEASE_MS } from '../email.worker';
import { captureLogs, FakeClock, FakeProvider, TOKEN, testConfig } from './email-support';

const tag = `it${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const domain = `${tag}.example`;
const addr = (name: string) => `${name}@${domain}`;
const DAY = 86_400_000;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

let prisma: PrismaService;
let second: PrismaService;
let app: INestApplication;
let base = '';
const tokens = { owner: '', staff: '' };
const adminIds: string[] = [];

const mkRow = (fields: Record<string, unknown> = {}) =>
  prisma.emailOutbox.create({
    data: { toEmail: addr(`r${randomBytes(3).toString('hex')}`), template: 'order_confirmation', data: { orderId: 'o1', totalCents: 100, currency: 'USD' }, ...fields } as any,
  });
const mine = () => prisma.emailOutbox.findMany({ where: { toEmail: { endsWith: `@${domain}` } }, orderBy: { createdAt: 'asc' } });
const cleanRows = () => prisma.emailOutbox.deleteMany({ where: { toEmail: { endsWith: `@${domain}` } } });

async function call(method: string, path: string, token: string | null, json?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json === undefined ? {} : { 'content-type': 'application/json' }) },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  return { status: res.status, text, body: text && (res.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) : null, headers: res.headers };
}

before(async () => {
  prisma = new PrismaService();
  await prisma.$connect();
  second = new PrismaService(); // a second connection pool = a second API instance
  await second.$connect();
  @Global()
  @Module({ providers: [{ provide: PrismaService, useValue: prisma }], exports: [PrismaService] })
  class RealPrismaModule {}
  process.env.EMAIL_WORKER_INTERVAL_MS = '0';
  const moduleRef = await Test.createTestingModule({ imports: [RealPrismaModule, AdminCoreModule, EmailModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  for (const role of ['OWNER', 'STAFF'] as const) {
    const admin = await prisma.adminUser.create({ data: { email: `${tag}-${role}@example.test`, name: role, role, passwordHash: 'x', mfaSeedEnc: 'x' } });
    adminIds.push(admin.id);
    const token = randomBytes(32).toString('base64url');
    await prisma.adminSession.create({ data: { adminId: admin.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3_600_000) } });
    tokens[role === 'OWNER' ? 'owner' : 'staff'] = token;
  }
});

after(async () => {
  await cleanRows();
  await prisma.adminAuditEvent.deleteMany({ where: { adminId: { in: adminIds } } });
  await prisma.adminSession.deleteMany({ where: { adminId: { in: adminIds } } });
  await prisma.adminUser.deleteMany({ where: { id: { in: adminIds } } });
  await app.close();
  await second.$disconnect();
  await prisma.$disconnect();
});

test('EMAIL_PORT resolves to the real EmailService in the booted application', () => {
  assert.ok(app.get(EMAIL_PORT) instanceof EmailService);
});

test('enqueue: 10 parallel calls with one dedupeKey insert exactly ONE row and none throws (real unique index)', async () => {
  const email = new EmailService(prisma);
  const key = `${tag}:parallel`;
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) => email.enqueue({ to: addr('parallel'), template: 'order_confirmation', data: { orderId: `o${i}`, totalCents: i, currency: 'USD' }, dedupeKey: key })),
  );
  assert.deepEqual(results.map((r) => r.status), Array(10).fill('fulfilled'));
  const rows = await prisma.emailOutbox.findMany({ where: { dedupeKey: key } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'PENDING');
  assert.equal(rows[0].attempts, 0);
  await prisma.emailOutbox.deleteMany({ where: { dedupeKey: key } });
});

test('enqueue: stores the normalised JSON payload; duplicates across two connections are also idempotent; non-key dups are separate rows', async () => {
  const a = new EmailService(prisma);
  const b = new EmailService(second);
  const key = `${tag}:two-pools`;
  await Promise.all([
    a.enqueue({ to: addr('pool'), template: 'email_verification', data: { link: 'https://shop.example.com/verify-email?token=abc', name: 'Ada' }, dedupeKey: key }),
    b.enqueue({ to: addr('pool'), template: 'email_verification', data: { link: 'https://shop.example.com/verify-email?token=abc', name: 'Ada' }, dedupeKey: key }),
  ]);
  const rows = await prisma.emailOutbox.findMany({ where: { dedupeKey: key } });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].data, { link: 'https://shop.example.com/verify-email?token=abc', name: 'Ada' });
  await a.enqueue({ to: addr('nokey'), template: 'password_reset', data: { link: 'https://a.example/x' } });
  await a.enqueue({ to: addr('nokey'), template: 'password_reset', data: { link: 'https://a.example/x' } });
  assert.equal((await prisma.emailOutbox.findMany({ where: { toEmail: addr('nokey') } })).length, 2);
  await cleanRows();
  await prisma.emailOutbox.deleteMany({ where: { dedupeKey: key } });
});

test('two worker instances (separate connection pools) claim every row exactly once', async () => {
  const clock = new FakeClock(new Date());
  const ids: string[] = [];
  for (let i = 0; i < 30; i += 1) ids.push((await mkRow({ nextAttemptAt: new Date(clock.now().getTime() - 1000) })).id);
  const pa = new FakeProvider();
  const pb = new FakeProvider();
  pa.delayMs = 2;
  pb.delayMs = 2;
  const a = new EmailWorker(prisma, testConfig(), pa, clock.now);
  const b = new EmailWorker(second, testConfig(), pb, clock.now);
  for (let round = 0; round < 3; round += 1) await Promise.all([a.tick(), b.tick()]);
  const sent = [...pa.sent, ...pb.sent].map((m) => m.id).filter((id) => ids.includes(id));
  assert.equal(sent.length, 30, 'all rows sent');
  assert.equal(new Set(sent).size, 30, 'no row sent twice');
  assert.ok(pa.sent.length > 0 && pb.sent.length > 0, `work was shared (${pa.sent.length}/${pb.sent.length})`);
  const rows = await prisma.emailOutbox.findMany({ where: { id: { in: ids } } });
  assert.ok(rows.every((r) => r.status === 'SENT' && r.attempts === 1 && r.sentAt && r.providerMessageId));
  await cleanRows();
});

test('backoff schedule against Postgres with an injected clock, then FAILED at attempt 8', async () => {
  const clock = new FakeClock(new Date(Date.now()));
  const provider = new FakeProvider();
  provider.behavior = () => ({ ok: false, retryable: true, error: 'HTTP 503 unavailable' });
  const worker = new EmailWorker(prisma, testConfig(), provider, clock.now);
  const row = await mkRow({ nextAttemptAt: new Date(clock.now().getTime() - 1) });
  const delays = [30_000, 120_000, 600_000, 3_600_000, 21_600_000, 21_600_000, 21_600_000];
  for (let n = 1; n <= 7; n += 1) {
    const before = clock.now().getTime();
    await worker.tick();
    const current = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(current.status, 'PENDING');
    assert.equal(current.attempts, n);
    assert.equal(current.nextAttemptAt.getTime(), before + delays[n - 1]);
    clock.advance(delays[n - 1]);
  }
  await worker.tick();
  const done = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(done.status, 'FAILED');
  assert.equal(done.attempts, 8);
  assert.match(done.lastError ?? '', /503/);
  assert.equal(provider.sent.filter((m) => m.id === row.id).length, 8);
  await cleanRows();
});

test('permanent failure is FAILED at once; the stored lastError holds no key, address or token', async () => {
  const key = 're_test_0123456789abcdefghij';
  const clock = new FakeClock(new Date());
  const provider = new FakeProvider();
  const to = addr('perm');
  provider.behavior = () => ({ ok: false, retryable: false, error: `HTTP 403 ${key} ${to} https://shop.example.com/reset-password?token=${TOKEN}` });
  const worker = new EmailWorker(prisma, testConfig({ apiKey: key }), provider, clock.now);
  const row = await mkRow({ toEmail: to, template: 'password_reset', data: { link: `https://shop.example.com/reset-password?token=${TOKEN}` }, nextAttemptAt: new Date(clock.now().getTime() - 1) });
  const logs = captureLogs();
  try {
    await worker.tick();
    const current = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(current.status, 'FAILED');
    assert.equal(current.attempts, 1);
    for (const leaked of [key, to, TOKEN]) {
      assert.ok(!(current.lastError ?? '').includes(leaked), `lastError leaked ${leaked}`);
      assert.ok(logs.lines.every((l) => !l.includes(leaked)), `log leaked ${leaked}`);
    }
  } finally {
    logs.restore();
  }
  await cleanRows();
});

test('stale SENDING rows (lease older than 5 minutes) are re-claimed by a real conditional update; fresh leases are left alone', async () => {
  const clock = new FakeClock(new Date());
  const now = clock.now().getTime();
  const stale = await mkRow({ status: 'SENDING', attempts: 1, nextAttemptAt: new Date(now - 1) });
  const fresh = await mkRow({ status: 'SENDING', attempts: 1, nextAttemptAt: new Date(now + LEASE_MS) });
  const provider = new FakeProvider();
  await new EmailWorker(prisma, testConfig(), provider, clock.now).tick();
  const ids = provider.sent.map((m) => m.id);
  assert.ok(ids.includes(stale.id));
  assert.ok(!ids.includes(fresh.id));
  const after = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: stale.id } });
  assert.equal(after.status, 'SENT');
  assert.equal(after.attempts, 2);
  assert.equal((await prisma.emailOutbox.findUniqueOrThrow({ where: { id: fresh.id } })).status, 'SENDING');
  await cleanRows();
});

test('a worker that lost its lease cannot overwrite the new owner (compare-and-set against Postgres)', async () => {
  const clock = new FakeClock(new Date());
  const row = await mkRow({ nextAttemptAt: new Date(clock.now().getTime() - 1) });
  let release: () => void = () => undefined;
  const slow = new FakeProvider();
  slow.behavior = (m) => (m.id === row.id ? new Promise((resolve) => { release = () => resolve({ ok: false, retryable: false, error: 'late failure' }); }) : { ok: true, providerMessageId: 'x' });
  const first = new EmailWorker(prisma, testConfig(), slow, clock.now);
  const stuck = first.tick();
  for (let i = 0; i < 100 && (await prisma.emailOutbox.findUniqueOrThrow({ where: { id: row.id } })).status !== 'SENDING'; i += 1) await new Promise((r) => setTimeout(r, 10));
  clock.advance(LEASE_MS + 1);
  const fast = new FakeProvider();
  await new EmailWorker(second, testConfig(), fast, clock.now).tick();
  assert.ok(fast.sent.some((m) => m.id === row.id));
  release();
  await stuck;
  const final = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(final.status, 'SENT');
  assert.equal(final.attempts, 2);
  assert.equal(final.lastError, null);
  await cleanRows();
});

test('retention: SENT rows older than 90 days are removed in the worker sweep; others stay', async () => {
  const clock = new FakeClock(new Date());
  const old = await mkRow({ status: 'SENT', sentAt: new Date(clock.now().getTime() - 91 * DAY) });
  const young = await mkRow({ status: 'SENT', sentAt: new Date(clock.now().getTime() - 89 * DAY) });
  const failed = await mkRow({ status: 'FAILED', createdAt: new Date(clock.now().getTime() - 200 * DAY) });
  await new EmailWorker(prisma, testConfig(), new FakeProvider(), clock.now).sweepRetention(true);
  const left = (await mine()).map((r) => r.id);
  assert.ok(!left.includes(old.id));
  assert.ok(left.includes(young.id) && left.includes(failed.id));
  await cleanRows();
});

test('admin: unauthenticated 401, STAFF 403 on both routes, malformed input 400', async () => {
  const row = await mkRow({ status: 'FAILED', attempts: 8 });
  assert.equal((await call('GET', '/v1/admin/email/outbox', null)).status, 401);
  assert.equal((await call('POST', `/v1/admin/email/outbox/${row.id}/retry`, null)).status, 401);
  assert.equal((await call('GET', '/v1/admin/email/outbox', tokens.staff)).status, 403);
  assert.equal((await call('POST', `/v1/admin/email/outbox/${row.id}/retry`, tokens.staff)).status, 403);
  assert.equal((await prisma.emailOutbox.findUniqueOrThrow({ where: { id: row.id } })).status, 'FAILED', 'STAFF retry changed nothing');
  for (const qs of ['status=BOGUS', 'limit=0', 'limit=101', 'limit=abc', 'cursor=!!!', 'cursor=e30']) assert.equal((await call('GET', `/v1/admin/email/outbox?${qs}`, tokens.owner)).status, 400, qs);
  await cleanRows();
});

test('admin: OWNER list shows the documented fields, the recipient DOMAIN only, no PII or links anywhere in the response', async () => {
  await cleanRows();
  const to = addr('Jane.Doe');
  const failed = await mkRow({ toEmail: to, template: 'password_reset', data: { link: `https://shop.example.com/reset-password?token=${TOKEN}` }, status: 'FAILED', attempts: 3, lastError: 'HTTP 403 validation_error' });
  const sent = await mkRow({ toEmail: addr('sent'), status: 'SENT', attempts: 1, sentAt: new Date() });
  const res = await call('GET', '/v1/admin/email/outbox?limit=50', tokens.owner);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(res.body).sort(), ['items', 'nextCursor']);
  const mineItems = res.body.items.filter((i: any) => i.toDomain === domain);
  assert.equal(mineItems.length, 2);
  for (const item of mineItems) assert.deepEqual(Object.keys(item).sort(), ['attempts', 'createdAt', 'id', 'lastError', 'sentAt', 'status', 'template', 'toDomain']);
  const f = mineItems.find((i: any) => i.id === failed.id);
  assert.deepEqual({ status: f.status, attempts: f.attempts, lastError: f.lastError, sentAt: f.sentAt, template: f.template }, { status: 'FAILED', attempts: 3, lastError: 'HTTP 403 validation_error', sentAt: null, template: 'password_reset' });
  assert.equal(typeof mineItems.find((i: any) => i.id === sent.id).sentAt, 'string');
  for (const leaked of ['Jane', 'jane', TOKEN, `@${domain}`, 'reset-password', 'toEmail', 'data']) assert.ok(!res.text.includes(leaked), `response leaked ${leaked}`);
  assert.equal((await call('GET', '/v1/admin/email/outbox?status=FAILED', tokens.owner)).body.items.every((i: any) => i.status === 'FAILED'), true);
  await cleanRows();
});

test('admin: keyset pagination over Postgres has no gaps or repeats', async () => {
  await cleanRows();
  const ids: string[] = [];
  for (let i = 0; i < 7; i += 1) ids.push((await mkRow({ createdAt: new Date(Date.now() - 100_000 + (i < 3 ? 0 : i * 1000)) })).id);
  const seen: string[] = [];
  let cursor = '';
  for (let guard = 0; guard < 400; guard += 1) {
    const res = await call('GET', `/v1/admin/email/outbox?limit=100${cursor ? `&cursor=${cursor}` : ''}`, tokens.owner);
    seen.push(...res.body.items.map((i: any) => i.id));
    if (!res.body.nextCursor) break;
    cursor = res.body.nextCursor;
  }
  assert.equal(new Set(seen).size, seen.length, 'no repeats');
  for (const id of ids) assert.ok(seen.includes(id), 'no gaps');
  const small: string[] = [];
  cursor = '';
  for (let guard = 0; guard < 400; guard += 1) {
    const res = await call('GET', `/v1/admin/email/outbox?limit=2&status=PENDING${cursor ? `&cursor=${cursor}` : ''}`, tokens.owner);
    assert.ok(res.body.items.length <= 2);
    small.push(...res.body.items.map((i: any) => i.id));
    if (!res.body.nextCursor) break;
    cursor = res.body.nextCursor;
  }
  for (const id of ids) assert.ok(small.includes(id));
  await cleanRows();
});

test('admin: OWNER retry moves FAILED -> PENDING, resets attempts, writes an audit event without PII; other states 409; unknown 404', async () => {
  const to = addr('retry');
  const row = await mkRow({ toEmail: to, status: 'FAILED', attempts: 8, lastError: 'HTTP 403', nextAttemptAt: new Date(Date.now() + DAY) });
  const res = await call('POST', `/v1/admin/email/outbox/${row.id}/retry`, tokens.owner);
  assert.equal(res.status, 200);
  assert.deepEqual({ id: res.body.id, status: res.body.status, attempts: res.body.attempts, lastError: res.body.lastError, toDomain: res.body.toDomain }, { id: row.id, status: 'PENDING', attempts: 0, lastError: null, toDomain: domain });
  assert.ok(!res.text.includes(to));
  const stored = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: row.id } });
  assert.deepEqual({ status: stored.status, attempts: stored.attempts, lastError: stored.lastError }, { status: 'PENDING', attempts: 0, lastError: null });
  assert.ok(stored.nextAttemptAt.getTime() <= Date.now() + 1000, 'due immediately');
  const audits = await prisma.adminAuditEvent.findMany({ where: { action: 'email.retry', targetId: row.id } });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].targetType, 'email_outbox');
  assert.equal(audits[0].adminId, adminIds[0]);
  assert.ok(!JSON.stringify(audits[0].detail).includes(to));

  assert.equal((await call('POST', `/v1/admin/email/outbox/${row.id}/retry`, tokens.owner)).status, 409, 'now PENDING');
  const sent = await mkRow({ status: 'SENT', sentAt: new Date() });
  assert.equal((await call('POST', `/v1/admin/email/outbox/${sent.id}/retry`, tokens.owner)).status, 409);
  assert.equal((await prisma.emailOutbox.findUniqueOrThrow({ where: { id: sent.id } })).status, 'SENT');
  assert.equal((await call('POST', '/v1/admin/email/outbox/doesnotexist/retry', tokens.owner)).status, 404);
  assert.equal(await prisma.adminAuditEvent.count({ where: { action: 'email.retry', targetId: { in: [sent.id, 'doesnotexist'] } } }), 0);

  const parallel = await mkRow({ status: 'FAILED', attempts: 8 });
  const both = await Promise.all([call('POST', `/v1/admin/email/outbox/${parallel.id}/retry`, tokens.owner), call('POST', `/v1/admin/email/outbox/${parallel.id}/retry`, tokens.owner)]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
  assert.equal(await prisma.adminAuditEvent.count({ where: { action: 'email.retry', targetId: parallel.id } }), 1);
  await cleanRows();
});

test('retried row is then sent by the worker (end to end through Postgres)', async () => {
  const clock = new FakeClock(new Date());
  const row = await mkRow({ status: 'FAILED', attempts: 8, lastError: 'HTTP 403' });
  assert.equal((await call('POST', `/v1/admin/email/outbox/${row.id}/retry`, tokens.owner)).status, 200);
  const provider = new FakeProvider();
  clock.advance(1000);
  await new EmailWorker(prisma, testConfig(), provider, clock.now).tick();
  assert.ok(provider.sent.some((m) => m.id === row.id));
  assert.equal((await prisma.emailOutbox.findUniqueOrThrow({ where: { id: row.id } })).status, 'SENT');
  await cleanRows();
});
