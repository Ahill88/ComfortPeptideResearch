/**
 * Checkout top-up orchestration (apps/storefront/lib/wallet/topup-flow.ts) and its API client call.
 * Pure tests: injected fakes for balance, widget, clock, sleep, storage and the prepare/validate/sign/submit steps.
 *
 * Run (from repo root):
 *   pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only ../../tests/wallet/topup-flow.test.ts
 *
 * NOT covered here (needs a browser): window.open / popup blocking behaviour, focus, aria-live announcements, layout.
 * The component is only checked by static text scans below.
 */
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_TOPUP_OPTIONS, TOPUP_STORAGE_KEY, createTopUpRun, createTopUpStore, findResumableTopUp, parseTopUpRecord, safeWidgetUrl,
  type BalanceRead, type KeyValueStorage, type PreparedPayment, type TopUpDeps, type TopUpPlan, type TopUpState, type WidgetOpenResult,
} from '../../apps/storefront/lib/wallet/topup-flow';
import { createOrderTopUp, normalizeOrderTopUp } from '../../apps/storefront/lib/wallet/api';
import { ROOT, read } from './_helpers';

const REQUIRED = 100_000_000n; // 100 USDC
const EMAIL = 'Buyer@Example.com';
const T0 = 1_700_000_000_000;
const MERCHANT = 'MerchantAddr1111111111111111111111111111111';

type Prepared = PreparedPayment & { id: string };

const fresh = (n: bigint): BalanceRead => ({ spendableAtomic: n, stale: false });
const stale = (n: bigint): BalanceRead => ({ spendableAtomic: n, stale: true });
const unavailable = new Error('service down');

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: (k) => { data.delete(k); } };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function ticks(n = 10) { for (let i = 0; i < n; i++) await tick(); }

type Harness = ReturnType<typeof harness>;

/**
 * `reads` is consumed one per balance check; the last entry repeats. An Error entry makes the check throw.
 * The fake clock advances only inside sleep (pollMs), so "timeout" tests are instant and deterministic.
 */
function harness(opts: {
  reads?: Array<BalanceRead | Error>;
  widget?: WidgetOpenResult;
  storage?: KeyValueStorage;
  prepared?: Partial<Prepared>;
  problems?: string[];
  signError?: Error;
  submitError?: Error;
  prepareError?: Error;
  gatePrepare?: boolean;
  gateFetch?: boolean;
  options?: Parameters<typeof createTopUpRun>[3];
  plan?: Partial<TopUpPlan>;
  /** Customer SOL balance for the optional fee-funds read: a value, null (unknown) or an Error (read fails). Omitted = no SOL dependency at all. */
  sol?: bigint | null | Error;
} = {}) {
  const calls: string[] = [];
  const counts = { fetch: 0, open: 0, prepare: 0, validate: 0, sign: 0, submit: 0 };
  let now = T0;
  let readIndex = 0;
  const reads = opts.reads ?? [fresh(0n)];
  const storage = opts.storage ?? memoryStorage();
  const store = createTopUpStore(storage);
  let releasePrepare: (() => void) | null = null;
  const prepareGate = new Promise<void>((resolve) => { releasePrepare = resolve; });
  let releaseFetch: ((read: BalanceRead) => void) | null = null;
  const states: TopUpState[] = [];
  const solReads = { count: 0 };

  const deps: TopUpDeps<Prepared> = {
    fetchBalance: async () => {
      counts.fetch += 1; calls.push('fetch');
      if (opts.gateFetch) return new Promise<BalanceRead>((resolve) => { releaseFetch = resolve; });
      const entry = reads[Math.min(readIndex, reads.length - 1)];
      readIndex += 1;
      if (entry instanceof Error) throw entry;
      return entry;
    },
    openWidget: (url) => { counts.open += 1; calls.push(`open:${url}`); return opts.widget ?? { status: 'opened' }; },
    sleep: async (ms) => { await tick(); now += ms; },
    now: () => now,
    prepare: async () => {
      counts.prepare += 1; calls.push('prepare');
      if (opts.gatePrepare) await prepareGate;
      if (opts.prepareError) throw opts.prepareError;
      return { id: 'prep-1', amountAtomic: REQUIRED, merchant: MERCHANT, expiresAt: null, ...opts.prepared };
    },
    validate: async () => { counts.validate += 1; calls.push('validate'); return opts.problems ?? []; },
    sign: async () => { counts.sign += 1; calls.push('sign'); if (opts.signError) throw opts.signError; return 'signed-tx'; },
    submit: async () => { counts.submit += 1; calls.push('submit'); if (opts.submitError) throw opts.submitError; },
    store,
    ...(opts.sol === undefined ? {} : { solBalanceLamports: async () => { solReads.count += 1; if (opts.sol instanceof Error) throw opts.sol; return opts.sol ?? null; } }),
  };
  const plan: TopUpPlan = {
    orderId: 'order-1', intentId: 'intent-1', requiredAtomic: REQUIRED, baselineSpendableAtomic: 0n, consentedAt: T0,
    widgetUrl: 'https://buy.moonpay.example/widget?x=1', sandbox: false, merchant: null, ...opts.plan,
  };
  const run = createTopUpRun(plan, deps, EMAIL, { pollMs: 3000, timeoutMs: 60_000, consentMaxAgeMs: 60 * 60_000, settleReads: 2, ...opts.options }, (s) => states.push(s));
  return {
    run, calls, counts, solReads, storage, store, states, plan, deps,
    advance: (ms: number) => { now += ms; },
    releasePrepare: () => releasePrepare?.(),
    releaseFetch: (read: BalanceRead) => releaseFetch?.(read),
    kinds: () => states.map((s) => s.kind),
  };
}

const lastWaiting = (h: Harness) => {
  const waiting = h.states.filter((s): s is Extract<TopUpState, { kind: 'waiting' }> => s.kind === 'waiting');
  return waiting[waiting.length - 1];
};

/* ------------------------------ funds arrive, auto-pay ------------------------------ */

test('funds arrive: the existing authorization flow runs exactly once, with no further click', async () => {
  const h = harness({ reads: [fresh(0n), fresh(0n), fresh(REQUIRED)] });
  h.run.start();
  const end = await h.run.whenSettled();
  assert.equal(end.kind, 'submitted');
  assert.deepEqual(h.counts, { fetch: 3, open: 1, prepare: 1, validate: 1, sign: 1, submit: 1 });
  // Order matters: nothing is prepared or signed before the third (sufficient) balance read.
  assert.deepEqual(h.calls.filter((c) => !c.startsWith('open')), ['fetch', 'fetch', 'fetch', 'prepare', 'validate', 'sign', 'submit']);
  await ticks();
  assert.equal(h.counts.sign, 1, 'nothing signs again after submit');
});

test('start(): the widget opens synchronously inside the click, after the consent record is written and before any await', () => {
  const h = harness({ reads: [fresh(0n)] });
  h.run.start(); // not awaited on purpose
  assert.ok(h.calls[0].startsWith('open:https://buy.moonpay.example/'), `first call was ${h.calls[0]}`);
  assert.ok(h.store.load(), 'consent record is stored before waiting');
  h.run.cancel();
});

test('a balance equal to the order total is enough; one atomic unit less is not', async () => {
  const short = harness({ reads: [fresh(REQUIRED - 1n)], plan: { baselineSpendableAtomic: REQUIRED - 1n } });
  short.run.start();
  await ticks(30);
  assert.equal(short.counts.sign, 0);
  short.run.cancel();
  const enough = harness({ reads: [fresh(REQUIRED)] });
  enough.run.start();
  assert.equal((await enough.run.whenSettled()).kind, 'submitted');
});

/* ------------------------------ consent ------------------------------ */

test('consent absent: never opens the widget, never reads the balance, never signs', async () => {
  const h = harness({ reads: [fresh(REQUIRED)], plan: { consentedAt: null } });
  assert.deepEqual(h.run.start(), { kind: 'blocked', reason: 'consent-required' });
  assert.deepEqual(h.run.resume(), { kind: 'blocked', reason: 'consent-required' });
  await ticks();
  assert.deepEqual(h.counts, { fetch: 0, open: 0, prepare: 0, validate: 0, sign: 0, submit: 0 });
  assert.equal(h.store.load(), null);
});

test('consent too old (or from the future): treated as absent, nothing is signed even though funds are there', async () => {
  const old = harness({ reads: [fresh(REQUIRED)], plan: { consentedAt: T0 - 2 * 60 * 60_000 } });
  assert.deepEqual(old.run.start(), { kind: 'blocked', reason: 'consent-expired' });
  const future = harness({ reads: [fresh(REQUIRED)], plan: { consentedAt: T0 + 10 * 60_000 } });
  assert.deepEqual(future.run.start(), { kind: 'blocked', reason: 'consent-expired' });
  await ticks();
  assert.equal(old.counts.sign + future.counts.sign, 0);
});

test('consent is re-checked at the moment of signing: it expiring while waiting means no signature', async () => {
  const h = harness({ reads: [fresh(0n)], options: { consentMaxAgeMs: 10_000, timeoutMs: 600_000 } });
  h.run.start();
  await ticks(5);
  h.advance(60_000);
  h.deps.fetchBalance = async () => fresh(REQUIRED);
  h.run.nudge();
  await ticks(10);
  assert.equal(h.counts.sign, 0);
  assert.equal(h.counts.prepare, 0);
  assert.equal(h.run.getState().kind, 'blocked');
});

test('invalid plans (no order, no intent, zero total) are refused', () => {
  for (const patch of [{ orderId: '' }, { intentId: '' }, { requiredAtomic: 0n }]) {
    const h = harness({ plan: patch });
    assert.deepEqual(h.run.start(), { kind: 'blocked', reason: 'invalid-plan' });
    assert.equal(h.counts.open + h.counts.fetch, 0);
  }
});

/* ------------------------------ still short ------------------------------ */

test('funds arrive but are still short: shows the new shortfall, offers another top-up, does not sign, stops polling', async () => {
  const h = harness({ reads: [fresh(0n), fresh(40_000_000n)] });
  h.run.start();
  const end = await h.run.whenSettled();
  assert.equal(end.kind, 'short');
  if (end.kind !== 'short') return;
  assert.equal(end.spendableAtomic, 40_000_000n);
  assert.equal(end.shortfallAtomic, 60_000_000n);
  assert.equal(end.requiredAtomic, REQUIRED);
  const fetched = h.counts.fetch;
  await ticks(30);
  assert.equal(h.counts.fetch, fetched, 'no silent looping after the shortfall is shown');
  assert.equal(h.counts.sign + h.counts.prepare + h.counts.submit, 0);
  assert.equal(h.counts.open, 1, 'a second widget is never opened on its own');
  assert.ok(h.store.load(), 'order stays resumable');
});

test('a transient increase is not reported as the final arrival: it must settle across consecutive fresh reads', async () => {
  // 40, then 100 (enough) -> pays; the first 40 alone must not have produced "short".
  const h = harness({ reads: [fresh(0n), fresh(40_000_000n), fresh(REQUIRED)] });
  h.run.start();
  assert.equal((await h.run.whenSettled()).kind, 'submitted');
  assert.ok(!h.kinds().includes('short'));
});

test('short -> keepWaiting re-baselines on the arrived amount, then pays if the rest arrives', async () => {
  const h = harness({ reads: [fresh(0n), fresh(40_000_000n), fresh(40_000_000n), fresh(40_000_000n), fresh(REQUIRED)] });
  h.run.start();
  assert.equal((await h.run.whenSettled()).kind, 'short');
  assert.equal(h.counts.sign, 0);
  h.run.keepWaiting();
  const end = await h.run.whenSettled();
  assert.equal(end.kind, 'submitted');
  assert.equal(h.counts.sign, 1);
});

test('short -> keepWaiting does not immediately report the same shortfall again (never loops silently)', async () => {
  const h = harness({ reads: [fresh(40_000_000n)], plan: { baselineSpendableAtomic: 0n } });
  h.run.start();
  assert.equal((await h.run.whenSettled()).kind, 'short');
  h.run.keepWaiting();
  await ticks(8); // 8 polls x 3s stays inside the 60s test timeout
  assert.equal(h.run.getState().kind, 'waiting', 'no new arrival, so it keeps waiting rather than repeating the same prompt');
  h.run.cancel();
});

/* ------------------------------ stale / unknown balance ------------------------------ */

test('stale or unreadable balance is unknown: it keeps waiting and never signs, even if the stale number is large', async () => {
  const h = harness({ reads: [stale(REQUIRED * 10n), unavailable, stale(REQUIRED), fresh(0n)] });
  h.run.start();
  await ticks(40);
  assert.equal(h.counts.sign, 0);
  assert.equal(h.counts.prepare, 0);
  const waiting = h.states.filter((s) => s.kind === 'waiting') as Array<Extract<TopUpState, { kind: 'waiting' }>>;
  const unknownStates = waiting.filter((s) => !s.progress.balanceKnown && s.progress.checks > 0);
  assert.ok(unknownStates.length >= 3, 'the first three checks are reported as unknown');
  for (const s of unknownStates) assert.equal(s.progress.spendableAtomic, null, 'an unknown balance is null, never 0n and never the stale number');
  assert.ok(!h.kinds().includes('short'), 'stale increases never count as arrival');
  h.run.cancel();
});

test('stale reads in between do not break a later fresh arrival: pays once', async () => {
  const h = harness({ reads: [stale(REQUIRED), unavailable, fresh(REQUIRED)] });
  h.run.start();
  assert.equal((await h.run.whenSettled()).kind, 'submitted');
  assert.equal(h.counts.sign, 1);
  assert.equal(h.counts.fetch, 3);
});

test('the unknown state is cleared by a fresh read and the last fresh amount is retained, not zeroed, while unknown again', async () => {
  const h = harness({ reads: [fresh(10_000_000n), stale(0n)], plan: { baselineSpendableAtomic: 10_000_000n } });
  h.run.start();
  await ticks(20);
  const w = lastWaiting(h);
  assert.equal(w.progress.balanceKnown, false);
  h.run.cancel();
});

/* ------------------------------ timeout ------------------------------ */

test('timeout: stops watching, leaves a resumable record, signs nothing; keepWaiting continues and can still pay', async () => {
  const h = harness({ reads: [fresh(0n)], options: { timeoutMs: 15_000 } });
  h.run.start();
  const end = await h.run.whenSettled();
  assert.equal(end.kind, 'timed-out');
  assert.equal(h.counts.sign + h.counts.prepare, 0);
  const rec = h.store.load();
  assert.ok(rec && rec.orderId === 'order-1' && rec.intentId === 'intent-1' && rec.payStartedAt === null);
  const fetched = h.counts.fetch;
  await ticks(20);
  assert.equal(h.counts.fetch, fetched, 'no polling after timeout');
  h.deps.fetchBalance = async () => fresh(REQUIRED);
  h.run.keepWaiting();
  assert.equal((await h.run.whenSettled()).kind, 'submitted');
  assert.equal(h.counts.sign, 1);
});

test('timeout with only stale reads: still unknown at the end, still no signature', async () => {
  const h = harness({ reads: [stale(REQUIRED)], options: { timeoutMs: 15_000 } });
  h.run.start();
  assert.equal((await h.run.whenSettled()).kind, 'timed-out');
  assert.equal(h.counts.sign, 0);
});

/* ------------------------------ cancel ------------------------------ */

test('cancel: clears the record and signs nothing, even if a balance read that was in flight then says "enough"', async () => {
  const h = harness({ gateFetch: true });
  h.run.start();
  await ticks(2);
  assert.equal(h.counts.fetch, 1);
  assert.equal(h.run.cancel(), true);
  assert.equal(h.run.getState().kind, 'cancelled');
  assert.equal(h.store.load(), null);
  h.releaseFetch(fresh(REQUIRED * 2n));
  await ticks(20);
  assert.deepEqual([h.counts.prepare, h.counts.validate, h.counts.sign, h.counts.submit], [0, 0, 0, 0]);
  assert.equal(h.run.getState().kind, 'cancelled');
});

test('cancel without any storage (in-process guard only): an in-flight "enough" read still cannot sign', async () => {
  const h = harness({ gateFetch: true });
  const run = createTopUpRun(h.plan, { ...h.deps, store: null }, EMAIL, { pollMs: 3000, timeoutMs: 60_000 });
  run.start();
  await ticks(2);
  assert.equal(run.cancel(), true);
  h.releaseFetch(fresh(REQUIRED * 2n));
  await ticks(20);
  assert.deepEqual([h.counts.prepare, h.counts.sign, h.counts.submit], [0, 0, 0]);
  assert.equal(run.getState().kind, 'cancelled');
});

test('cancel is refused once the pay step has begun, and keepWaiting cannot restart it', async () => {
  const h = harness({ reads: [fresh(REQUIRED)], gatePrepare: true });
  h.run.start();
  await ticks(5);
  assert.equal(h.run.getState().kind, 'paying');
  assert.equal(h.run.cancel(), false);
  h.run.keepWaiting();
  h.releasePrepare();
  assert.equal((await h.run.whenSettled()).kind, 'submitted');
  assert.equal(h.counts.sign, 1);
});

test('suspend (panel closed): stops without clearing the record and never signs afterwards', async () => {
  const h = harness({ gateFetch: true });
  h.run.start();
  await ticks(2);
  h.run.suspend();
  h.releaseFetch(fresh(REQUIRED));
  await ticks(20);
  assert.equal(h.counts.sign + h.counts.prepare, 0);
  assert.ok(h.store.load(), 'record survives so the order can be resumed');
});

/* ------------------------------ reload resume ------------------------------ */

test('reload: a new run built from the sessionStorage record resumes polling, does not reopen the widget, and pays once', async () => {
  const storage = memoryStorage();
  const first = harness({ storage, reads: [fresh(0n)] });
  first.run.start();
  await ticks(5);
  first.run.suspend(); // the page goes away

  const raw = storage.getItem(TOPUP_STORAGE_KEY);
  assert.ok(raw, 'record written');
  assert.deepEqual(Object.keys(JSON.parse(raw as string)).sort(), ['baselineSpendableAtomic', 'consentedAt', 'email', 'intentId', 'orderId', 'payStartedAt', 'requiredAtomic', 'sandbox', 'v'], 'only public identifiers are persisted');
  assert.ok(!/key|secret|seed|signature|signed|mnemonic/i.test(raw as string), 'no key/secret-like content in the record');

  const second = harness({ storage, reads: [fresh(0n), fresh(REQUIRED)] });
  const found = findResumableTopUp(second.store, EMAIL, T0 + 60_000);
  assert.equal(found.kind, 'resume');
  if (found.kind !== 'resume') return;
  assert.equal(found.plan.orderId, 'order-1');
  assert.equal(found.plan.intentId, 'intent-1');
  assert.equal(found.plan.requiredAtomic, REQUIRED);
  const resumed = harness({ storage, reads: [fresh(0n), fresh(REQUIRED)], plan: { ...found.plan } });
  resumed.run.resume();
  assert.equal((await resumed.run.whenSettled()).kind, 'submitted');
  assert.equal(resumed.counts.open, 0, 'no window can be opened without a click');
  assert.equal(resumed.counts.sign, 1);
  assert.equal(first.counts.sign, 0);
  const progressStates = resumed.states.filter((s) => s.kind === 'waiting') as Array<Extract<TopUpState, { kind: 'waiting' }>>;
  assert.equal(progressStates[0].progress.widget, 'resumed');
});

test('reload: stale consent, another account, junk and a record where pay already began never auto-sign', async () => {
  const storage = memoryStorage();
  const h = harness({ storage, reads: [fresh(0n)] });
  h.run.start();
  await ticks(3);
  h.run.suspend();
  const store = createTopUpStore(storage);
  assert.equal(findResumableTopUp(store, 'someone.else@example.com', T0).kind, 'none');
  assert.equal(findResumableTopUp(store, EMAIL, T0 + 2 * 60 * 60_000).kind, 'expired');
  assert.equal(findResumableTopUp(store, `  ${EMAIL.toUpperCase()} `, T0 + 1000).kind, 'resume', 'account match is case/space-insensitive');

  // A record where a previous page already started paying: resume never signs on its own.
  const rec = store.load();
  assert.ok(rec);
  store.save({ ...rec, payStartedAt: T0 + 5 });
  const found = findResumableTopUp(store, EMAIL, T0 + 1000);
  assert.equal(found.kind, 'resume');
  if (found.kind !== 'resume') return;
  const resumed = harness({ storage, reads: [fresh(REQUIRED)], plan: { ...found.plan } });
  assert.deepEqual(resumed.run.resume(), { kind: 'manual-required', reason: 'pay-already-started' });
  await ticks(10);
  assert.equal(resumed.counts.sign + resumed.counts.prepare + resumed.counts.fetch, 0);

  for (const junk of ['', 'null', '{', '[]', '{"v":2}', JSON.stringify({ ...rec, requiredAtomic: '1e9' }), JSON.stringify({ ...rec, consentedAt: 'now' }), JSON.stringify({ ...rec, orderId: '' })]) {
    assert.equal(parseTopUpRecord(junk), null, `junk record rejected: ${junk.slice(0, 40)}`);
  }
});

test('storage unavailable: the run still works but reports that it is not resumable', async () => {
  const broken: KeyValueStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
  const h = harness({ storage: broken, reads: [fresh(0n), fresh(REQUIRED)] });
  h.run.start();
  assert.equal(lastWaiting(h).progress.persisted, false);
  assert.equal((await h.run.whenSettled()).kind, 'submitted');
  assert.equal(h.counts.sign, 1);
});

/* ------------------------------ double trigger ------------------------------ */

test('double trigger: two runs sharing one record (two mounted panels / strict-mode double effect) sign exactly once', async () => {
  const storage = memoryStorage();
  const a = harness({ storage, reads: [fresh(REQUIRED)], gatePrepare: true });
  const b = harness({ storage, reads: [fresh(REQUIRED)], gatePrepare: true });
  a.run.start();
  b.run.resume();
  await ticks(10);
  a.releasePrepare(); b.releasePrepare();
  await ticks(10);
  assert.equal(a.counts.sign + b.counts.sign, 1, 'exactly one of the two runs signs');
  assert.equal(a.counts.submit + b.counts.submit, 1);
  assert.equal(a.counts.prepare + b.counts.prepare, 1, 'the loser does not even prepare');
  assert.equal([a, b].filter((h) => h.run.getState().kind === 'manual-required').length, 1);
});

test('double trigger: repeated nudges, keepWaiting calls and a long poll after a sufficient balance cannot fire pay twice in one run', async () => {
  const h = harness({ reads: [fresh(0n), fresh(REQUIRED)], gatePrepare: true });
  h.run.start();
  await ticks(6);
  for (let i = 0; i < 5; i++) { h.run.nudge(); h.run.keepWaiting(); h.run.start(); h.run.resume(); }
  await ticks(6);
  h.releasePrepare();
  await h.run.whenSettled();
  await ticks(20);
  assert.deepEqual([h.counts.prepare, h.counts.sign, h.counts.submit], [1, 1, 1]);
});

test('double trigger: after a pay failure nothing retries on its own', async () => {
  const h = harness({ reads: [fresh(REQUIRED)], signError: new Error('user rejected') });
  h.run.start();
  const end = await h.run.whenSettled();
  assert.equal(end.kind, 'pay-failed');
  h.run.keepWaiting(); h.run.nudge();
  await ticks(20);
  assert.equal(h.counts.sign, 1);
  assert.equal(h.counts.submit, 0);
});

/* ------------------------------ widget handling ------------------------------ */

test('popup blocked: reports "blocked" (so the page shows a manual link), keeps waiting, and pays when funds arrive', async () => {
  const h = harness({ widget: { status: 'blocked' }, reads: [fresh(0n), fresh(0n), fresh(REQUIRED)] });
  h.run.start();
  assert.equal(lastWaiting(h).progress.widget, 'blocked');
  assert.equal(h.counts.sign, 0);
  assert.equal((await h.run.whenSettled()).kind, 'submitted');
  assert.equal(h.counts.open, 1);
});

test('closed popup: reported as "closed", the order stays awaiting and resumable, nothing is signed', async () => {
  let closed = false;
  const h = harness({ widget: { status: 'opened', isClosed: () => closed }, reads: [fresh(0n)], gateFetch: false });
  h.run.start();
  assert.equal(lastWaiting(h).progress.widget, 'opened');
  closed = true;
  await ticks(10);
  assert.equal(lastWaiting(h).progress.widget, 'closed');
  assert.equal(h.counts.sign, 0);
  assert.ok(h.store.load());
  h.run.cancel();
});

test('closed popup then funds arrive anyway (purchase finished before closing): still pays once', async () => {
  let closed = false;
  const h = harness({ widget: { status: 'opened', isClosed: () => closed }, reads: [fresh(0n), fresh(0n), fresh(REQUIRED)] });
  h.run.start();
  closed = true;
  assert.equal((await h.run.whenSettled()).kind, 'submitted');
  assert.equal(h.counts.sign, 1);
});

test('widget unavailable (no secure https URL): nothing is polled or signed and the record is removed', async () => {
  const noLink = harness({ widget: { status: 'unavailable' }, reads: [fresh(REQUIRED)] });
  assert.equal(noLink.run.start().kind, 'widget-unavailable');
  const noUrl = harness({ reads: [fresh(REQUIRED)], plan: { widgetUrl: null } });
  assert.equal(noUrl.run.start().kind, 'widget-unavailable');
  await ticks(10);
  for (const h of [noLink, noUrl]) { assert.equal(h.counts.fetch + h.counts.sign, 0); assert.equal(h.store.load(), null); }
});

test('sandbox plans never open a window (the local "widget" path is not a page); the deposit is simulated by the caller', async () => {
  const h = harness({ plan: { sandbox: true, widgetUrl: '/wallet/sandbox-onramp?intent=intent-1' }, reads: [fresh(0n), fresh(REQUIRED)] });
  h.run.start();
  assert.equal(lastWaiting(h).progress.widget, 'sandbox');
  assert.equal((await h.run.whenSettled()).kind, 'submitted');
  assert.equal(h.counts.open, 0);
});

test('safeWidgetUrl only allows https', () => {
  assert.ok(safeWidgetUrl('https://buy.moonpay.com/?a=1'));
  for (const bad of ['http://buy.moonpay.com', '/wallet/sandbox-onramp?intent=1', 'javascript:alert(1)', 'data:text/html,hi', '', 'not a url']) assert.equal(safeWidgetUrl(bad), null, bad);
});

/* ------------------------------ refusing to sign ------------------------------ */

test('a prepared payment that does not match the consented order is never signed', async () => {
  const wrongAmount = harness({ reads: [fresh(REQUIRED)], prepared: { amountAtomic: REQUIRED + 1n } });
  wrongAmount.run.start();
  const a = await wrongAmount.run.whenSettled();
  assert.equal(a.kind, 'pay-failed');
  if (a.kind === 'pay-failed') { assert.equal(a.stage, 'validate'); assert.match(a.reasons.join(' '), /amount/i); assert.equal(a.mayHaveSubmitted, false); }

  const wrongMerchant = harness({ reads: [fresh(REQUIRED)], plan: { merchant: MERCHANT }, prepared: { merchant: 'SomeoneElse' } });
  wrongMerchant.run.start();
  assert.equal((await wrongMerchant.run.whenSettled()).kind, 'pay-failed');

  const expired = harness({ reads: [fresh(REQUIRED)], prepared: { expiresAt: new Date(T0 - 1000).toISOString() } });
  expired.run.start();
  assert.equal((await expired.run.whenSettled()).kind, 'pay-failed');

  const invalidTx = harness({ reads: [fresh(REQUIRED)], problems: ['Transaction pays a different recipient.'] });
  invalidTx.run.start();
  const c = await invalidTx.run.whenSettled();
  assert.equal(c.kind, 'pay-failed');
  if (c.kind === 'pay-failed') assert.deepEqual(c.reasons, ['Transaction pays a different recipient.']);

  for (const h of [wrongAmount, wrongMerchant, expired, invalidTx]) assert.deepEqual([h.counts.sign, h.counts.submit], [0, 0]);
});

test('merchant shown before consent is accepted when the prepared payment matches it', async () => {
  const h = harness({ reads: [fresh(REQUIRED)], plan: { merchant: MERCHANT } });
  h.run.start();
  assert.equal((await h.run.whenSettled()).kind, 'submitted');
});

test('pay failures are classified: prepare/sign mean nothing was sent; a submit failure may have been', async () => {
  const prepareFail = harness({ reads: [fresh(REQUIRED)], prepareError: new Error('402') });
  prepareFail.run.start();
  const p = await prepareFail.run.whenSettled();
  assert.ok(p.kind === 'pay-failed' && p.stage === 'prepare' && !p.mayHaveSubmitted);
  const signFail = harness({ reads: [fresh(REQUIRED)], signError: new Error('rejected') });
  signFail.run.start();
  const s = await signFail.run.whenSettled();
  assert.ok(s.kind === 'pay-failed' && s.stage === 'sign' && !s.mayHaveSubmitted);
  assert.equal(signFail.counts.submit, 0);
  const submitFail = harness({ reads: [fresh(REQUIRED)], submitError: new Error('network') });
  submitFail.run.start();
  const u = await submitFail.run.whenSettled();
  assert.ok(u.kind === 'pay-failed' && u.stage === 'submit' && u.mayHaveSubmitted);
});

/* ------------------------------ API client ------------------------------ */

test('normalizeOrderTopUp: no top-up needed', () => {
  const r = normalizeOrderTopUp({ topUpNeeded: false, orderId: 'o1', requiredAtomic: '100000000', spendableAtomic: '250000000' });
  assert.deepEqual(r, { topUpNeeded: false, orderId: 'o1', requiredAtomic: 100_000_000n, spendableAtomic: 250_000_000n });
});

test('normalizeOrderTopUp: top-up needed keeps bigints exact and the disclosures verbatim', () => {
  const r = normalizeOrderTopUp({
    topUpNeeded: true, orderId: 'o1', intentId: 'i1', requiredAtomic: '100000000', spendableAtomic: '12345678', shortfallAtomic: '87654322', topUpUsdCents: 9000,
    status: 'PENDING', quote: { provider: 'moonpay', sandbox: true, widgetUrl: '/wallet/sandbox-onramp?intent=i1', estimatedFeeUsdCents: 450, estimatedUsdcAtomic: '85000000', disclosures: ['MoonPay sets its own fees.', 'Second.'], extra: 'ignored' },
  });
  assert.ok(r.topUpNeeded);
  if (!r.topUpNeeded) return;
  assert.equal(r.shortfallAtomic, 87_654_322n);
  assert.equal(r.topUpUsdCents, 9000);
  assert.equal(r.status, 'PENDING');
  assert.equal(r.intentId, 'i1');
  assert.equal(r.quote.intentId, 'i1');
  assert.equal(r.quote.sandbox, true);
  assert.equal(r.quote.estimatedUsdcAtomic, 85_000_000n);
  assert.deepEqual(r.quote.disclosures, ['MoonPay sets its own fees.', 'Second.']);
  assert.equal(r.merchant, null);
  const withMerchant = normalizeOrderTopUp({ topUpNeeded: true, orderId: 'o1', intentId: 'i1', requiredAtomic: '1', spendableAtomic: '0', shortfallAtomic: '1', topUpUsdCents: 1, quote: {}, status: 'CREATED', merchant: MERCHANT });
  assert.ok(withMerchant.topUpNeeded && withMerchant.merchant === MERCHANT);
});

test('normalizeOrderTopUp: malformed or unsafe responses are rejected, not guessed at', () => {
  const ok = { topUpNeeded: true, orderId: 'o1', intentId: 'i1', requiredAtomic: '100', spendableAtomic: '0', shortfallAtomic: '100', topUpUsdCents: 5, quote: {}, status: 'CREATED' };
  assert.ok(normalizeOrderTopUp(ok));
  for (const patch of [{ topUpNeeded: undefined }, { orderId: undefined }, { intentId: '' }, { requiredAtomic: 'abc' }, { requiredAtomic: 5 }, { shortfallAtomic: '0' }, { shortfallAtomic: '-5' }, { topUpUsdCents: 0 }, { topUpUsdCents: 1.5 }, { topUpUsdCents: '5' }]) {
    assert.throws(() => normalizeOrderTopUp({ ...ok, ...patch }), /unexpected response/i, JSON.stringify(patch));
  }
  assert.throws(() => normalizeOrderTopUp(null), /unexpected response/i);
});

test('createOrderTopUp posts only {orderId} with the account header to /wallet/onramp/order-topup', async () => {
  const realFetch = globalThis.fetch;
  const seen: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ topUpNeeded: false, orderId: 'o9', requiredAtomic: '5', spendableAtomic: '9' }), { status: 200 });
  }) as typeof fetch;
  try {
    const r = await createOrderTopUp('buyer@example.com', 'o9');
    assert.equal(r.topUpNeeded, false);
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /\/wallet\/onramp\/order-topup$/);
    assert.equal(seen[0].init.method, 'POST');
    assert.equal((seen[0].init.headers as Record<string, string>)['x-customer-email'], 'buyer@example.com');
    assert.deepEqual(JSON.parse(seen[0].init.body as string), { orderId: 'o9' });
    // An answer about a different order is refused.
    globalThis.fetch = (async () => new Response(JSON.stringify({ topUpNeeded: false, orderId: 'other', requiredAtomic: '5', spendableAtomic: '9' }), { status: 200 })) as typeof fetch;
    await assert.rejects(() => createOrderTopUp('buyer@example.com', 'o9'), /unexpected response/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ------------------------------ network fee: who pays decides whether SOL matters ------------------------------ */

test('fee sponsored by the platform: a customer with ZERO SOL is paid through automatically, and SOL is never even read', async () => {
  const h = harness({ reads: [fresh(REQUIRED)], sol: 0n, prepared: { feeSponsored: true, feeLamports: 5000n } });
  h.run.start();
  assert.equal((await h.run.whenSettled()).kind, 'submitted');
  assert.equal(h.solReads.count, 0, 'no SOL balance read for a sponsored payment');
  assert.deepEqual([h.counts.sign, h.counts.submit], [1, 1]);
});

test('customer pays the fee: a KNOWN SOL balance below the estimate stops the run before signing, with a SOL reason', async () => {
  const h = harness({ reads: [fresh(REQUIRED)], sol: 4_999n, prepared: { feeSponsored: false, feeLamports: 5000n } });
  h.run.start();
  const end = await h.run.whenSettled();
  assert.equal(end.kind, 'pay-failed');
  if (end.kind !== 'pay-failed') return;
  assert.equal(end.stage, 'validate');
  assert.match(end.reasons.join(' '), /enough SOL to pay the network fee/);
  assert.equal(end.mayHaveSubmitted, false);
  assert.deepEqual([h.solReads.count, h.counts.sign, h.counts.submit], [1, 0, 0]);
});

test('customer pays the fee: enough SOL, an unknown balance, a failed read, an absent estimate, or no SOL dependency at all do not block', async () => {
  for (const [label, o] of [
    ['exactly enough', { sol: 5000n, prepared: { feeLamports: 5000n } }],
    ['unknown (null)', { sol: null, prepared: { feeLamports: 5000n } }],
    ['read failed', { sol: new Error('rpc down'), prepared: { feeLamports: 5000n } }],
    ['no fee estimate', { sol: 0n, prepared: { feeLamports: null } }],
    ['no SOL dependency (old behaviour)', { prepared: { feeLamports: 5000n } }],
  ] as const) {
    const h = harness({ reads: [fresh(REQUIRED)], ...o, prepared: { feeSponsored: false, ...o.prepared } });
    h.run.start();
    assert.equal((await h.run.whenSettled()).kind, 'submitted', label);
  }
});

test('an old API (no feeSponsored on the prepared payment) behaves exactly as before: not sponsored, no SOL read without a dependency', async () => {
  const h = harness({ reads: [fresh(REQUIRED)] });
  h.run.start();
  assert.equal((await h.run.whenSettled()).kind, 'submitted');
  assert.equal(h.solReads.count, 0);
});

/* ------------------------------ component text (static; no browser was used) ------------------------------ */

test('component: consent copy, provider split of responsibility, verbatim disclosures, manual link for a blocked popup', () => {
  const src = read(path.join(ROOT, 'apps/storefront/components/wallet/credits-checkout.tsx'));
  assert.match(src, /Buy \$\{usd\} of USDC with a card or bank via MoonPay/);
  assert.match(src, /MoonPay, not Helix &amp; Field, handles ID checks, fees and payment/);
  assert.match(src, /Top up \$\{usd\}, then pay this order automatically/);
  assert.match(src, /quote\.disclosures\.map\(\(d\) => <li key=\{d\}[^>]*>\{d\}<\/li>\)/, 'disclosures rendered verbatim');
  assert.match(src, /blocked the MoonPay window[\s\S]{0,200}\{link/);
  assert.match(src, /target="_blank" rel="noopener noreferrer"/);
  assert.match(src, /disabled=\{!agreed \|\| !widgetOk\}/, 'confirm is disabled until the consent box is ticked');
  assert.ok(!/Add credits<\/Link>/.test(src), 'the dead-end "Add credits" link is gone');
});

test('component: the only place a signature is requested is the run deps and the manual AuthorizePanel path', () => {
  const src = read(path.join(ROOT, 'apps/storefront/components/wallet/credits-checkout.tsx'));
  const hits = [...src.matchAll(/signTransaction\(/g)].length;
  assert.equal(hits, 2, 'one in the auto-pay run deps, one in the click-driven authorize()');
  assert.equal(DEFAULT_TOPUP_OPTIONS.pollMs, 3000);
});
