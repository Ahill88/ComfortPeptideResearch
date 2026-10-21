import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { DEFAULT_SANCTIONS_LIST_URL, describeListSource, loadSanctionsConfig, type SanctionsConfig } from '../sanctions.config';
import { RETRY_GAP_MS, SanctionsScheduler } from '../sanctions.scheduler';
import { SanctionsComplianceScreen } from '../sanctions.screen';
import type { SanctionsService } from '../sanctions.service';
import { SCREENING_NOT_READY_MESSAGE } from '../../../wallet/transfers/compliance-screen';

/** In-memory stand-in for SanctionsService (the DB-backed one is covered by the integration suite). */
class FakeSanctions {
  ready = true;
  listed = new Set<string>();
  fail = false;
  async isReady() {
    if (this.fail) throw new Error('db down');
    return this.ready;
  }
  async findListed(addresses: readonly string[]) {
    return addresses.some((a) => this.listed.has(a));
  }
}
const asService = (fake: FakeSanctions) => fake as unknown as SanctionsService;
const config = (env: Record<string, string | undefined> = {}): SanctionsConfig => loadSanctionsConfig({ NODE_ENV: 'test', ...env });
const input = (source: string, destination = source) => ({ customerId: 'c1', sourceAddress: source, destinationAddress: destination, amountAtomic: 0n, mint: '' });

function captureWarnings() {
  const warnings: string[] = [];
  const original = Logger.prototype.warn;
  Logger.prototype.warn = function (message: unknown) {
    warnings.push(String(message));
  };
  return { warnings, restore: () => void (Logger.prototype.warn = original) };
}

test('a listed address is refused with code SANCTIONS; an unlisted one is allowed', async () => {
  const fake = new FakeSanctions();
  fake.listed.add('LISTED1');
  const screen = new SanctionsComplianceScreen(asService(fake), config());
  assert.deepEqual(await screen.screen(input('LISTED1')), { allowed: false, code: 'SANCTIONS', reason: 'sanctions-list-match' });
  assert.deepEqual(await screen.screen(input('CLEAN1', 'LISTED1')), { allowed: false, code: 'SANCTIONS', reason: 'sanctions-list-match' }, 'destination is screened too');
  assert.deepEqual(await screen.screen(input('CLEAN1', 'CLEAN2')), { allowed: true });
});

// ---- fail-open / fail-closed matrix over NODE_ENV (list never loaded) ----
const MATRIX: Array<{ nodeEnv: string | undefined; failsOpen: boolean }> = [
  { nodeEnv: 'development', failsOpen: true },
  { nodeEnv: 'test', failsOpen: true },
  { nodeEnv: 'production', failsOpen: false },
  { nodeEnv: undefined, failsOpen: false },
  { nodeEnv: '', failsOpen: false },
  { nodeEnv: 'staging', failsOpen: false },
  { nodeEnv: 'prod', failsOpen: false },
  { nodeEnv: 'Production', failsOpen: false },
  { nodeEnv: 'Development', failsOpen: false },
  { nodeEnv: 'production ', failsOpen: false },
];
for (const { nodeEnv, failsOpen } of MATRIX) {
  test(`list never loaded, NODE_ENV=${JSON.stringify(nodeEnv)}: ${failsOpen ? 'fails OPEN with a warning' : 'fails CLOSED with 503'}`, async () => {
    const fake = new FakeSanctions();
    fake.ready = false;
    const screen = new SanctionsComplianceScreen(asService(fake), config());
    screen.env = { NODE_ENV: nodeEnv };
    const capture = captureWarnings();
    try {
      if (failsOpen) {
        assert.deepEqual(await screen.screen(input('ANY')), { allowed: true });
        assert.equal(capture.warnings.length, 1);
        assert.match(capture.warnings[0], /has not loaded/);
      } else {
        await assert.rejects(screen.screen(input('ANY')), (error: unknown) => {
          assert.ok(error instanceof ServiceUnavailableException);
          assert.equal(error.getStatus(), 503);
          assert.equal((error.getResponse() as { message: string }).message, SCREENING_NOT_READY_MESSAGE);
          return true;
        });
      }
    } finally {
      capture.restore();
    }
  });
}

test('the "not loaded" warning is rate limited and never contains an address', async () => {
  const fake = new FakeSanctions();
  fake.ready = false;
  const screen = new SanctionsComplianceScreen(asService(fake), config());
  screen.env = { NODE_ENV: 'development' };
  let now = 1_000_000;
  screen.clock = () => now;
  const capture = captureWarnings();
  try {
    await screen.screen(input('SeedLookingAddress1111111111111111'));
    await screen.screen(input('SeedLookingAddress1111111111111111'));
    assert.equal(capture.warnings.length, 1);
    now += 61_000;
    await screen.screen(input('x'));
    assert.equal(capture.warnings.length, 2);
    assert.ok(capture.warnings.every((w) => !w.includes('LookingAddress')));
  } finally {
    capture.restore();
  }
});

test('once a list has loaded, every runtime enforces it (production included)', async () => {
  const fake = new FakeSanctions();
  fake.listed.add('LISTED1');
  for (const nodeEnv of ['development', 'test', 'production', undefined, 'staging']) {
    const screen = new SanctionsComplianceScreen(asService(fake), config());
    screen.env = { NODE_ENV: nodeEnv };
    assert.equal((await screen.screen(input('LISTED1'))).allowed, false, String(nodeEnv));
  }
});

test('a database error while deciding is a 503, never "allowed" (even in development)', async () => {
  const fake = new FakeSanctions();
  fake.fail = true;
  const screen = new SanctionsComplianceScreen(asService(fake), config());
  screen.env = { NODE_ENV: 'development' };
  await assert.rejects(screen.screen(input('ANY')), (error: unknown) => error instanceof ServiceUnavailableException);
});

// ---- SANCTIONS_SCREENING=off ----
test('SANCTIONS_SCREENING=off is honoured in development and test only', async () => {
  for (const nodeEnv of ['development', 'test']) {
    const cfg = loadSanctionsConfig({ NODE_ENV: nodeEnv, SANCTIONS_SCREENING: 'off' });
    assert.equal(cfg.mode, 'off', nodeEnv);
    assert.equal(cfg.offIgnored, false);
    const fake = new FakeSanctions();
    fake.listed.add('LISTED1');
    assert.equal((await new SanctionsComplianceScreen(asService(fake), cfg).screen(input('LISTED1'))).allowed, true);
  }
});

test('SANCTIONS_SCREENING=off is IGNORED (with a startup warning) in every production-like runtime', async () => {
  for (const nodeEnv of ['production', undefined, '', 'staging', 'prod', 'Production', 'Test', 'development ']) {
    const cfg = loadSanctionsConfig({ NODE_ENV: nodeEnv, SANCTIONS_SCREENING: 'off' });
    assert.equal(cfg.mode, 'enforce', String(nodeEnv));
    assert.equal(cfg.offIgnored, true);
    const fake = new FakeSanctions();
    fake.listed.add('LISTED1');
    const screen = new SanctionsComplianceScreen(asService(fake), cfg);
    screen.env = { NODE_ENV: nodeEnv };
    assert.equal((await screen.screen(input('LISTED1'))).allowed, false, `listed address still refused for ${String(nodeEnv)}`);

    const capture = captureWarnings();
    try {
      new SanctionsScheduler(asService(fake), { ...cfg, autoRefreshAllowed: false }).onApplicationBootstrap();
      assert.ok(capture.warnings.some((w) => /off is IGNORED/.test(w)), 'startup warning');
    } finally {
      capture.restore();
    }
  }
});

test('config defaults, parsing and validation', () => {
  const defaults = loadSanctionsConfig({ NODE_ENV: 'production' });
  assert.equal(defaults.mode, 'enforce');
  assert.equal(defaults.refreshHours, 24);
  assert.equal(defaults.listUrl, DEFAULT_SANCTIONS_LIST_URL);
  assert.equal(defaults.allowInsecureUrl, false);
  assert.equal(defaults.autoRefreshAllowed, true);
  assert.equal(loadSanctionsConfig({ NODE_ENV: 'production', SANCTIONS_REFRESH_HOURS: '0' }).refreshHours, 0);
  assert.equal(loadSanctionsConfig({ NODE_ENV: 'production', SANCTIONS_REFRESH_HOURS: '6' }).refreshHours, 6);
  for (const bad of ['-1', '1.5', 'abc', '99999']) assert.throws(() => loadSanctionsConfig({ NODE_ENV: 'production', SANCTIONS_REFRESH_HOURS: bad }), /SANCTIONS_REFRESH_HOURS/);
  assert.throws(() => loadSanctionsConfig({ NODE_ENV: 'production', SANCTIONS_LIST_URL: 'http://example.test/x.xml' }), /https/);
  assert.throws(() => loadSanctionsConfig({ NODE_ENV: 'production', SANCTIONS_LIST_URL: 'not a url' }), /SANCTIONS_LIST_URL/);
  assert.equal(loadSanctionsConfig({ NODE_ENV: 'test', SANCTIONS_LIST_URL: 'http://127.0.0.1:1/x.xml' }).allowInsecureUrl, true);
  assert.equal(loadSanctionsConfig({ NODE_ENV: 'test', SANCTIONS_SCREENING: 'bogus' }).invalidMode, 'bogus');
  assert.equal(loadSanctionsConfig({ NODE_ENV: 'test', SANCTIONS_SCREENING: 'bogus' }).mode, 'enforce');
  assert.equal(loadSanctionsConfig({ NODE_ENV: 'test' }).autoRefreshAllowed, false, 'test boots must not call the network');
  assert.equal(loadSanctionsConfig({ NODE_ENV: 'test', SANCTIONS_REFRESH_IN_TEST: 'true' }).autoRefreshAllowed, true);
});

test('the source shown to admins carries no credentials, query or fragment', () => {
  assert.equal(describeListSource('https://user:pw@example.test/path/list.xml?token=abc#frag'), 'https://example.test/path/list.xml');
  assert.equal(describeListSource(DEFAULT_SANCTIONS_LIST_URL), DEFAULT_SANCTIONS_LIST_URL);
});

// ---- scheduler ----
class RecordingService {
  calls: Array<Record<string, unknown>> = [];
  throwOnRefresh = false;
  async refresh(options: Record<string, unknown>) {
    this.calls.push(options);
    if (this.throwOnRefresh) throw new Error('boom');
    return { outcome: 'OK', reason: null, entryCount: 1 };
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('scheduler: startup refresh is fire-and-forget (boot returns first), then the timer is cleaned up on destroy', async () => {
  const service = new RecordingService();
  const scheduler = new SanctionsScheduler(service as unknown as SanctionsService, { ...config({ SANCTIONS_REFRESH_IN_TEST: 'true' }) });
  scheduler.onApplicationBootstrap();
  assert.equal(service.calls.length, 0, 'nothing runs synchronously during boot');
  await sleep(20);
  assert.equal(service.calls.length, 1);
  assert.equal(service.calls[0].trigger, 'startup');
  assert.equal(service.calls[0].minOkAgeMs, 24 * 3_600_000);
  assert.equal(service.calls[0].retryGapMs, RETRY_GAP_MS);
  assert.equal(service.calls[0].force, undefined, 'automatic runs can never force');
  scheduler.onModuleDestroy();
});

test('scheduler: a refresh that throws never escapes (boot and timers survive)', async () => {
  const service = new RecordingService();
  service.throwOnRefresh = true;
  const scheduler = new SanctionsScheduler(service as unknown as SanctionsService, config({ SANCTIONS_REFRESH_IN_TEST: 'true' }));
  const capture = captureWarnings();
  try {
    await scheduler.tick('schedule');
    assert.equal(capture.warnings.length, 1);
  } finally {
    capture.restore();
  }
});

test('scheduler: SANCTIONS_REFRESH_HOURS=0, SANCTIONS_SCREENING=off and the plain test runtime start nothing', async () => {
  for (const env of [{ SANCTIONS_REFRESH_IN_TEST: 'true', SANCTIONS_REFRESH_HOURS: '0' }, { SANCTIONS_REFRESH_IN_TEST: 'true', SANCTIONS_SCREENING: 'off' }, {}]) {
    const service = new RecordingService();
    const scheduler = new SanctionsScheduler(service as unknown as SanctionsService, config(env));
    scheduler.onApplicationBootstrap();
    await sleep(20);
    scheduler.onModuleDestroy();
    assert.equal(service.calls.length, 0, JSON.stringify(env));
  }
});
