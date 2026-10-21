/**
 * DB-backed suite (REAL PostgreSQL, REAL SanctionsService/Screen/AdminSessionGuard/AdminAuditService, REAL HTTP download from a local
 * fixture server through the real fetcher). Needs TEST_DATABASE_URL on YOUR scratch schema (tests/run-all.mjs reports it SKIPPED without it).
 * It owns the SanctionsAddress/SanctionsListRun tables of that schema and empties them around every test, so it refuses public/dev.
 */
import { createHash, randomBytes } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { Global, Logger, Module, ServiceUnavailableException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminCoreModule } from '../../../admin/admin-core.module';
import { hashSessionToken } from '../../../admin/admin-session.guard';
import { PrismaService } from '../../../prisma.service';
import { SCREENING_NOT_READY_MESSAGE } from '../../../wallet/transfers/compliance-screen';
import { loadSanctionsConfig, SANCTIONS_SOURCE, type SanctionsConfig } from '../sanctions.config';
import { SanctionsModule } from '../sanctions.module';
import { SanctionsComplianceScreen } from '../sanctions.screen';
import { SanctionsService, STALE_RUN_MS } from '../sanctions.service';
import { fetchSdnList, type SanctionsFetcher } from '../sanctions-fetcher';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for the integration suites (run tests/run-all.mjs to see them reported as SKIPPED).');
const parsedUrl = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(parsedUrl.hostname) || !/helix|test/i.test(parsedUrl.pathname)) throw new Error('Refusing to run: not a local helix/test database.');
if (['public', 'dev'].includes(parsedUrl.searchParams.get('schema') ?? 'public')) throw new Error('Refusing to run the sanctions suite in the shared public/dev schema: set ?schema=<your own schema>.');
process.env.DATABASE_URL = url;

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name));
const sample = fixture('sdn-sample.xml');
const SAMPLE_ADDRESSES = [
  '1SyntheticFixtureXbtAddress0000001',
  'bc1qsyntheticfixturexbtaddress000000002',
  '0xFeedFace00000000000000000000000000000001',
  '0xabcdef0000000000000000000000000000000002',
  'FixtureSo1anaSanctionedAddressxxxxxxxxxxxx',
  'TSyntheticFixtureTronAddress0000003',
];

/** An SDN document with `count` synthetic XBT addresses (names/uids invented). */
function makeList(count: number, prefix = 'SYNTHLIST'): Buffer {
  const entries = Array.from({ length: count }, (_v, i) => {
    const address = `${prefix}${String(i).padStart(24, '0')}`;
    return `<sdnEntry><uid>${800000 + i}</uid><lastName>SYNTHETIC ${i}</lastName><sdnType>Entity</sdnType><idList><id><uid>${i}</uid><idType>Digital Currency Address - XBT</idType><idNumber>${address}</idNumber></id></idList></sdnEntry>`;
  });
  return Buffer.from(`<?xml version="1.0"?><sdnList>${entries.join('\n')}</sdnList>`);
}

const prisma = new PrismaService();
let server: Server;
let base = '';
let body: Buffer | null = sample;
let status = 200;
let hits = 0;
let gate: Promise<void> | null = null;

function config(overrides: Partial<SanctionsConfig> = {}): SanctionsConfig {
  return { ...loadSanctionsConfig({ NODE_ENV: 'test', SANCTIONS_LIST_URL: `${base}/list` }), ...overrides };
}
const service = (overrides: Partial<SanctionsConfig> = {}, fetcher?: SanctionsFetcher) => new SanctionsService(prisma, config(overrides), fetcher);
const wipe = async () => {
  await prisma.sanctionsAddress.deleteMany({});
  await prisma.sanctionsListRun.deleteMany({});
};

before(async () => {
  await prisma.$connect();
  server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    hits += 1;
    const respond = () => (body ? res.writeHead(status, { 'content-type': 'text/xml' }).end(body) : res.writeHead(status).end('maintenance'));
    if (gate) void gate.then(respond);
    else respond();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  body = sample;
  status = 200;
  hits = 0;
  gate = null;
  await wipe();
});
afterEach(wipe);
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

test('a successful run stores one row per unique address, records the run with the file sha256, and reports status', async () => {
  const svc = service();
  assert.equal(await svc.isReady(), false);
  const result = await svc.refresh({ trigger: 'admin' });
  assert.deepEqual(result, { outcome: 'OK', reason: null, entryCount: 6 });
  assert.equal(await svc.isReady(), true);

  const run = await prisma.sanctionsListRun.findFirstOrThrow({});
  assert.equal(run.status, 'OK');
  assert.equal(run.entryCount, 6);
  assert.equal(run.sha256, createHash('sha256').update(sample).digest('hex'));
  assert.equal(run.error, null);
  assert.equal(run.source, SANCTIONS_SOURCE);

  const rows = await prisma.sanctionsAddress.findMany({ orderBy: { address: 'asc' } });
  assert.deepEqual(rows.map((r) => r.address).sort(), [...SAMPLE_ADDRESSES].sort());
  assert.ok(rows.every((r) => r.runId === run.id && r.source === SANCTIONS_SOURCE));
  assert.equal(rows.find((r) => r.address === 'FixtureSo1anaSanctionedAddressxxxxxxxxxxxx')?.currency, 'SOL');
  assert.equal(rows.find((r) => r.address === '1SyntheticFixtureXbtAddress0000001')?.entryUid, '900002', 'first occurrence wins');

  const view = await svc.status();
  assert.equal(view.addressCount, 6);
  assert.equal(view.source, `${base}/list`);
  assert.equal(view.lastRun?.status, 'OK');
  assert.equal(view.lastRun?.entryCount, 6);
  assert.equal(view.lastRun?.error, null);
  assert.ok(view.lastRun?.fetchedAt instanceof Date);
});

test('matching: exact on every currency, case-sensitive for base58, case-insensitive for EVM-style, never partial or wildcard', async () => {
  const svc = service();
  await svc.refresh({ trigger: 'admin' });
  // every currency in the list counts: a listed address is a listed person (XBT, ETH, USDC-on-EVM, SOL, Tron-USDT)
  for (const address of SAMPLE_ADDRESSES) assert.equal(await svc.findListed([address]), true, address);
  assert.equal(await svc.findListed(['clean', SAMPLE_ADDRESSES[4]]), true, 'any listed address in the set blocks');
  // Solana base58 is case-sensitive: another case is a different address
  assert.equal(await svc.findListed(['FIXTURESO1ANASANCTIONEDADDRESSXXXXXXXXXXXX']), false);
  assert.equal(await svc.findListed(['fixtureso1anasanctionedaddressxxxxxxxxxxxx']), false);
  // bitcoin/tron strings are case-sensitive too
  assert.equal(await svc.findListed(['1syntheticfixturexbtaddress0000001']), false);
  // EVM-style: checksum casing is cosmetic
  assert.equal(await svc.findListed(['0xfeedface00000000000000000000000000000001']), true);
  assert.equal(await svc.findListed(['0XFEEDFACE00000000000000000000000000000001']), false, 'only the 0x form is EVM-style');
  assert.equal(await svc.findListed(['0xFEEDFACE00000000000000000000000000000001']), true);
  assert.equal(await svc.findListed(['0xABCDEF0000000000000000000000000000000002']), true);
  // no substring, prefix or wildcard behaviour
  assert.equal(await svc.findListed(['1SyntheticFixtureXbtAddress000000']), false);
  assert.equal(await svc.findListed(['%']), false);
  assert.equal(await svc.findListed(['_']), false);
  assert.equal(await svc.findListed(['1Synthetic%']), false);
  assert.equal(await svc.findListed(['0x%']), false);
  assert.equal(await svc.findListed(['']), false);
  assert.equal(await svc.findListed([]), false);
  assert.equal(await svc.findListed(['  1SyntheticFixtureXbtAddress0000001  ']), true, 'surrounding whitespace is trimmed');
});

test('atomic replace: old addresses disappear and new ones appear in one step', async () => {
  const svc = service();
  await svc.refresh({ trigger: 'admin' });
  body = makeList(5);
  assert.equal((await svc.refresh({ trigger: 'admin' })).outcome, 'OK');
  assert.equal(await svc.findListed([SAMPLE_ADDRESSES[0]]), false);
  assert.equal(await svc.findListed([`SYNTHLIST${String(3).padStart(24, '0')}`]), true);
  assert.equal(await prisma.sanctionsAddress.count(), 5);
  const ok = await prisma.sanctionsListRun.findMany({ where: { status: 'OK' } });
  assert.equal(ok.length, 2, 'both runs are kept as history');
});

test('atomic replace: a failure half way through the write rolls back, the previous set stays fully intact and readable', async () => {
  const svc = service();
  body = makeList(700);
  assert.equal((await svc.refresh({ trigger: 'admin' })).outcome, 'OK');
  const before = await prisma.sanctionsAddress.findMany({ select: { address: true, runId: true }, orderBy: { address: 'asc' } });
  assert.equal(before.length, 700);

  // 700 rows -> two insert batches; a NUL character is rejected by PostgreSQL text columns, in the LAST batch, after the delete and the first batch.
  const poisoned: SanctionsFetcher = async (options) => {
    const real = await fetchSdnList({ ...options });
    const addresses = real.addresses.map((a) => ({ ...a }));
    addresses[addresses.length - 1].address = 'POISON\u0000ADDRESS';
    return { ...real, addresses };
  };
  body = makeList(690, 'POISONSET');
  const failing = service({}, poisoned);
  const result = await failing.refresh({ trigger: 'admin' });
  assert.equal(result.outcome, 'FAILED');
  assert.match(result.reason ?? '', /previous data was kept/);

  const after = await prisma.sanctionsAddress.findMany({ select: { address: true, runId: true }, orderBy: { address: 'asc' } });
  assert.deepEqual(after, before, 'identical rows (same addresses, same run) after the rolled back replacement');
  assert.equal(await failing.findListed([`SYNTHLIST${String(10).padStart(24, '0')}`]), true);
  assert.equal(await failing.findListed([`POISONSET${String(10).padStart(24, '0')}`]), false);
  const last = await prisma.sanctionsListRun.findFirstOrThrow({ orderBy: { fetchedAt: 'desc' } });
  assert.equal(last.status, 'FAILED');
  assert.ok(last.error);
  assert.equal(await prisma.sanctionsListRun.count({ where: { status: 'RUNNING' } }), 0, 'no run is left RUNNING');
});

test('plausibility guard: zero entries and drops over 50% fail the run and keep the old data; force accepts a drop but never an empty list', async () => {
  const svc = service();
  body = makeList(600);
  assert.equal((await svc.refresh({ trigger: 'admin' })).outcome, 'OK');

  body = makeList(100, 'SMALLSET');
  const dropped = await svc.refresh({ trigger: 'schedule' });
  assert.equal(dropped.outcome, 'FAILED');
  assert.match(dropped.reason ?? '', /shrank implausibly/);
  assert.equal(await prisma.sanctionsAddress.count(), 600);
  assert.equal((await svc.status()).lastRun?.status, 'FAILED');
  assert.match((await svc.status()).lastRun?.error ?? '', /previous data was kept/);

  body = fixture('sdn-no-addresses.xml');
  for (const force of [false, true]) {
    const empty = await svc.refresh({ trigger: 'admin', force });
    assert.equal(empty.outcome, 'FAILED', `force=${force}`);
    assert.equal(await prisma.sanctionsAddress.count(), 600);
  }

  body = makeList(300, 'HALFSET');
  assert.equal((await svc.refresh({ trigger: 'admin' })).outcome, 'OK', 'exactly 50% is allowed');
  assert.equal(await prisma.sanctionsAddress.count(), 300);

  body = makeList(30, 'FORCEDSET');
  assert.equal((await svc.refresh({ trigger: 'admin' })).outcome, 'FAILED');
  assert.equal((await svc.refresh({ trigger: 'admin', force: true })).outcome, 'OK');
  assert.equal(await prisma.sanctionsAddress.count(), 30);
});

test('the first ever run has no baseline: any non-empty list is accepted', async () => {
  body = makeList(3);
  assert.equal((await service().refresh({ trigger: 'startup' })).outcome, 'OK');
});

test('download failures (HTTP 503, HTML page, truncated file) fail the run with a redacted reason and keep the old data', async () => {
  const svc = service();
  await svc.refresh({ trigger: 'admin' });
  const snapshot = await prisma.sanctionsAddress.count();
  const cases: Array<[string, () => void]> = [
    ['http', () => { status = 503; body = null; }],
    ['html', () => { status = 200; body = fixture('not-sdn.html'); }],
    ['truncated', () => { status = 200; body = fixture('sdn-truncated.xml'); }],
  ];
  for (const [name, arrange] of cases) {
    arrange();
    const result = await svc.refresh({ trigger: 'admin' });
    assert.equal(result.outcome, 'FAILED', name);
    assert.doesNotMatch(result.reason ?? '', /127\.0\.0\.1|maintenance|http:\/\//, name);
    assert.equal(await prisma.sanctionsAddress.count(), snapshot, name);
    assert.equal(await svc.isReady(), true, 'screening keeps using the last good list');
  }
});

test('single flight: 10 parallel refreshes on one instance share one download and one run', async () => {
  const svc = service();
  const results = await Promise.all(Array.from({ length: 10 }, () => svc.refresh({ trigger: 'admin' })));
  assert.equal(hits, 1);
  assert.ok(results.every((r) => r.outcome === 'OK'));
  assert.equal(await prisma.sanctionsListRun.count(), 1);
});

test('single flight across instances: 10 separate services (10 "processes") racing, exactly one downloads, the other nine are SKIPPED', async () => {
  let release!: () => void;
  gate = new Promise<void>((resolve) => (release = resolve));
  const services = Array.from({ length: 10 }, () => service());
  let settled = 0;
  const all = services.map((s) => s.refresh({ trigger: 'admin' }).then((r) => ((settled += 1), r)));
  // The nine losers return as soon as their claim is refused; the winner is held at the download by the gate.
  const deadline = Date.now() + 15_000;
  while (settled < 9 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, 9, 'nine claims were refused while the winner was still downloading');
  release();
  const results = await Promise.all(all);
  assert.equal(results.filter((r) => r.outcome === 'OK').length, 1);
  const skipped = results.filter((r) => r.outcome === 'SKIPPED');
  assert.equal(skipped.length, 9);
  assert.ok(skipped.every((r) => r.reason === 'A refresh is already running.'));
  assert.equal(hits, 1);
  assert.equal(await prisma.sanctionsListRun.count(), 1);
  assert.equal(await prisma.sanctionsAddress.count(), 6);
});

test('a RUNNING claim blocks others while fresh, and stops blocking once it is older than the stale limit', async () => {
  const svc = service();
  const stuck = await prisma.sanctionsListRun.create({ data: { source: SANCTIONS_SOURCE, status: 'RUNNING' } });
  assert.equal((await svc.refresh({ trigger: 'admin' })).outcome, 'SKIPPED');
  assert.equal(hits, 0);
  await prisma.sanctionsListRun.update({ where: { id: stuck.id }, data: { fetchedAt: new Date(Date.now() - STALE_RUN_MS - 1000) } });
  assert.equal((await svc.refresh({ trigger: 'admin' })).outcome, 'OK');
  const old = await prisma.sanctionsListRun.findUniqueOrThrow({ where: { id: stuck.id } });
  assert.equal(old.status, 'FAILED');
  assert.match(old.error ?? '', /did not finish/);
});

test('automatic triggers skip when the list is recent or a failure is recent; the admin trigger never skips for age', async () => {
  const svc = service();
  const hour = 3_600_000;
  assert.equal((await svc.refresh({ trigger: 'startup', minOkAgeMs: 24 * hour })).outcome, 'OK');
  assert.equal(hits, 1);
  const again = await svc.refresh({ trigger: 'schedule', minOkAgeMs: 24 * hour });
  assert.equal(again.outcome, 'SKIPPED');
  assert.equal(hits, 1, 'no download when a recent OK run exists (another instance may have done it)');

  await prisma.sanctionsListRun.updateMany({ data: { fetchedAt: new Date(Date.now() - 25 * hour) } });
  status = 503;
  body = null;
  assert.equal((await svc.refresh({ trigger: 'schedule', minOkAgeMs: 24 * hour, retryGapMs: 30 * 60_000 })).outcome, 'FAILED');
  assert.equal(hits, 2);
  const gap = await svc.refresh({ trigger: 'schedule', minOkAgeMs: 24 * hour, retryGapMs: 30 * 60_000 });
  assert.equal(gap.outcome, 'SKIPPED', 'retry gap after a failure');
  assert.equal(hits, 2);
  status = 200;
  body = sample;
  assert.equal((await svc.refresh({ trigger: 'admin' })).outcome, 'OK');
});

test('pruning keeps the run history bounded and never removes the run that owns the current addresses', async () => {
  const svc = service();
  for (let i = 0; i < 3; i += 1) await prisma.sanctionsListRun.create({ data: { source: SANCTIONS_SOURCE, status: 'FAILED', error: 'old', fetchedAt: new Date(Date.now() - (100 + i) * 3_600_000) } });
  for (let i = 0; i < 60; i += 1) await prisma.sanctionsListRun.create({ data: { source: SANCTIONS_SOURCE, status: 'FAILED', error: 'old', fetchedAt: new Date(Date.now() - (200 + i) * 3_600_000) } });
  await svc.refresh({ trigger: 'admin' });
  const runs = await prisma.sanctionsListRun.count();
  assert.ok(runs <= 51, `kept ${runs}`);
  const current = await prisma.sanctionsListRun.findFirstOrThrow({ where: { status: 'OK' } });
  assert.equal(await prisma.sanctionsAddress.count({ where: { runId: current.id } }), 6);
});

test('screen over the real database: never loaded -> open in development/test, 503 elsewhere; loaded -> listed refused, unlisted allowed in every runtime', async () => {
  const svc = service();
  const screen = new SanctionsComplianceScreen(svc, config());
  const input = (address: string) => ({ customerId: 'c', sourceAddress: address, destinationAddress: address, amountAtomic: 0n, mint: '' });
  for (const nodeEnv of ['development', 'test']) {
    screen.env = { NODE_ENV: nodeEnv };
    assert.deepEqual(await screen.screen(input(SAMPLE_ADDRESSES[0])), { allowed: true });
  }
  for (const nodeEnv of ['production', undefined, 'staging']) {
    screen.env = { NODE_ENV: nodeEnv };
    await assert.rejects(screen.screen(input(SAMPLE_ADDRESSES[0])), (e: unknown) => e instanceof ServiceUnavailableException && (e.getResponse() as { message: string }).message === SCREENING_NOT_READY_MESSAGE);
  }
  // A FAILED-only history is still "never loaded".
  status = 503;
  body = null;
  await svc.refresh({ trigger: 'admin' });
  screen.env = { NODE_ENV: 'production' };
  await assert.rejects(screen.screen(input(SAMPLE_ADDRESSES[0])), ServiceUnavailableException);

  status = 200;
  body = sample;
  await svc.refresh({ trigger: 'admin' });
  for (const nodeEnv of ['development', 'test', 'production', undefined]) {
    screen.env = { NODE_ENV: nodeEnv };
    assert.equal((await screen.screen(input(SAMPLE_ADDRESSES[4]))).allowed, false, String(nodeEnv));
    assert.equal((await screen.screen(input('SomeUnlistedAddress11111111111111111111111'))).allowed, true, String(nodeEnv));
  }
});

test('logging: counts only. No listed address (or a long fragment of one) appears in any log line at any level, including a blocked screen', async () => {
  const lines: string[] = [];
  const originals = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) => [level, Logger.prototype[level]] as const);
  for (const [level] of originals) (Logger.prototype as any)[level] = function (message: unknown) { lines.push(`${level}: ${String(message)}`); };
  try {
    const svc = service();
    await svc.refresh({ trigger: 'admin' });
    const screen = new SanctionsComplianceScreen(svc, config());
    await screen.screen({ customerId: 'c', sourceAddress: SAMPLE_ADDRESSES[4], destinationAddress: SAMPLE_ADDRESSES[0], amountAtomic: 0n, mint: '' });
    status = 503;
    body = null;
    await svc.refresh({ trigger: 'admin' });
  } finally {
    for (const [level, original] of originals) (Logger.prototype as any)[level] = original;
  }
  assert.ok(lines.some((l) => /^log: Sanctions list refreshed: 6 addresses/.test(l)), lines.join('\n'));
  const text = lines.join('\n');
  for (const address of SAMPLE_ADDRESSES) assert.ok(!text.includes(address.slice(0, 10)), `a fragment of ${address.slice(0, 4)}... was logged`);
});

// ------------------------------------------------------------------ admin HTTP
test('admin endpoints: auth, roles, shape, audit, 503 with a redacted reason, force', async () => {
  const savedEnv = { url: process.env.SANCTIONS_LIST_URL, refresh: process.env.SANCTIONS_REFRESH_HOURS };
  process.env.SANCTIONS_LIST_URL = `${base}/list`;
  @Global()
  @Module({ providers: [{ provide: PrismaService, useValue: prisma }], exports: [PrismaService] })
  class RealPrismaModule {}
  const tag = `sanc${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  const adminIds: string[] = [];
  const mkAdmin = async (key: string, role: 'OWNER' | 'STAFF') => {
    const row = await prisma.adminUser.create({ data: { email: `${tag}-${key}@example.test`, name: key, role, passwordHash: 'x', mfaSeedEnc: 'x' } });
    adminIds.push(row.id);
    const token = randomBytes(32).toString('base64url');
    await prisma.adminSession.create({ data: { adminId: row.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3_600_000) } });
    return { id: row.id, token };
  };
  const owner = await mkAdmin('owner', 'OWNER');
  const staff = await mkAdmin('staff', 'STAFF');
  const moduleRef = await Test.createTestingModule({ imports: [RealPrismaModule, AdminCoreModule, SanctionsModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  const api = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const call = async (method: string, path: string, token: string | null, json?: unknown) => {
    const res = await fetch(`${api}/v1${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json === undefined ? {} : { 'content-type': 'application/json' }) },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    return { status: res.status, headers: res.headers, body: (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : null };
  };
  try {
    assert.equal((await call('GET', '/admin/compliance/sanctions', null)).status, 401);
    assert.equal((await call('POST', '/admin/compliance/sanctions/refresh', null)).status, 401);

    const empty = await call('GET', '/admin/compliance/sanctions', staff.token);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, { source: `${base}/list`, lastRun: null, addressCount: 0 });
    assert.equal(empty.headers.get('cache-control'), 'no-store');

    assert.equal((await call('POST', '/admin/compliance/sanctions/refresh', staff.token, {})).status, 403, 'STAFF cannot refresh');
    assert.equal(hits, 0);

    const refreshed = await call('POST', '/admin/compliance/sanctions/refresh', owner.token, {});
    assert.equal(refreshed.status, 200);
    assert.deepEqual(Object.keys(refreshed.body).sort(), ['addressCount', 'lastRun', 'source']);
    assert.equal(refreshed.body.addressCount, 6);
    assert.deepEqual(Object.keys(refreshed.body.lastRun).sort(), ['entryCount', 'error', 'fetchedAt', 'status']);
    assert.equal(refreshed.body.lastRun.status, 'OK');
    assert.equal(refreshed.body.lastRun.entryCount, 6);
    assert.equal(refreshed.body.lastRun.error, null);
    assert.ok(!Number.isNaN(Date.parse(refreshed.body.lastRun.fetchedAt)));
    assert.ok(!JSON.stringify(refreshed.body).includes('FixtureSo1ana'), 'the response carries no addresses');
    assert.deepEqual((await call('GET', '/admin/compliance/sanctions', staff.token)).body, refreshed.body);

    // Failing refresh: 503 + redacted reason; the old data stays.
    status = 503;
    body = null;
    const failed = await call('POST', '/admin/compliance/sanctions/refresh', owner.token);
    assert.equal(failed.status, 503);
    assert.match(failed.body.message, /answered HTTP 503/);
    assert.doesNotMatch(JSON.stringify(failed.body), /127\.0\.0\.1|maintenance/);
    const afterFail = await call('GET', '/admin/compliance/sanctions', staff.token);
    assert.equal(afterFail.body.addressCount, 6);
    assert.equal(afterFail.body.lastRun.status, 'FAILED');
    assert.ok(afterFail.body.lastRun.error);

    // Force: a >50% drop is refused unless the OWNER forces it.
    status = 200;
    body = makeList(2);
    const refused = await call('POST', '/admin/compliance/sanctions/refresh', owner.token, {});
    assert.equal(refused.status, 503);
    assert.match(refused.body.message, /shrank implausibly/);
    assert.equal((await call('POST', '/admin/compliance/sanctions/refresh', owner.token, { force: 'yes' })).status, 400, 'force must be a boolean');
    const forced = await call('POST', '/admin/compliance/sanctions/refresh', owner.token, { force: true });
    assert.equal(forced.status, 200);
    assert.equal(forced.body.addressCount, 2);

    // Audit: every attempt by an OWNER is recorded as sanctions.refresh, with no address in it.
    const audits = await prisma.adminAuditEvent.findMany({ where: { adminId: owner.id, action: 'sanctions.refresh' }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(audits.map((a) => (a.detail as any).outcome), ['OK', 'FAILED', 'FAILED', 'OK']);
    assert.deepEqual(audits.map((a) => (a.detail as any).force), [false, false, false, true]);
    assert.ok(audits.every((a) => a.targetType === 'sanctions'));
    assert.ok(!JSON.stringify(audits).includes('SYNTHLIST') && !JSON.stringify(audits).includes('Fixture'));
    assert.equal(await prisma.adminAuditEvent.count({ where: { adminId: staff.id, action: 'sanctions.refresh' } }), 0, 'a refused STAFF call changes nothing');
  } finally {
    await prisma.adminAuditEvent.deleteMany({ where: { adminId: { in: adminIds } } });
    await prisma.adminSession.deleteMany({ where: { adminId: { in: adminIds } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: adminIds } } });
    await app.close();
    if (savedEnv.url === undefined) delete process.env.SANCTIONS_LIST_URL;
    else process.env.SANCTIONS_LIST_URL = savedEnv.url;
    if (savedEnv.refresh === undefined) delete process.env.SANCTIONS_REFRESH_HOURS;
    else process.env.SANCTIONS_REFRESH_HOURS = savedEnv.refresh;
  }
});
