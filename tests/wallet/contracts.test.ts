/**
 * (1) Pure-logic tests for apps/api/src/wallet/contracts.ts
 *
 * Run (from repo root):
 *   pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only ../../tests/wallet/contracts.test.ts
 */
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { test } from 'node:test';
import { FLAG_CAMEL_NAMES, FLAG_ENV_NAMES, WALLET_SRC, requireRepoModule } from './_helpers';

const contractsPath = path.join(WALLET_SRC, 'contracts.ts');
const contracts = () => requireRepoModule<typeof import('../../apps/api/src/wallet/contracts')>(contractsPath, 'wallet contracts module');

const ONE = 1_000_000n; // 1 USDC in base units

test('contracts: module exports the pure functions under test', () => {
  const c = contracts();
  for (const name of ['computeSpendable', 'centsToAtomic', 'loadFeatureFlags'] as const) {
    assert.equal(typeof c[name], 'function', `contracts.ts must export function ${name}`);
  }
  assert.equal(c.USDC_DECIMALS, 6, 'USDC has 6 decimals');
  assert.equal(c.USDC_BASE_UNITS_PER_USDC, ONE, 'base units per USDC must be 1_000_000n');
  assert.equal(10n ** BigInt(c.USDC_DECIMALS), c.USDC_BASE_UNITS_PER_USDC, 'USDC_DECIMALS and USDC_BASE_UNITS_PER_USDC must agree');
  assert.match(c.USDC_DEVNET_MINT, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'devnet mint must look like a base58 public key');
  assert.equal(c.SOLANA_NETWORK_DEVNET, 'solana-devnet');
});

/* ------------------------------- computeSpendable ------------------------------- */

test('computeSpendable: 12.999999 USDC floors to 12 RC and keeps exact atomic amounts', () => {
  const r = contracts().computeSpendable({ finalizedAtomic: 12_999_999n, pendingOutgoingAtomic: 0n, activeReservationsAtomic: 0n });
  assert.equal(r.researchCredits, 12n, 'credits must FLOOR, never round up (12.999999 -> 12)');
  assert.equal(r.spendableAtomic, 12_999_999n, 'spendable atomic must be preserved exactly');
  assert.equal(r.finalizedAtomic, 12_999_999n, 'finalized atomic must be preserved exactly');
  assert.equal(typeof r.researchCredits, 'bigint');
});

test('computeSpendable: 0.999999 USDC is 0 RC (never rounds up to 1)', () => {
  const r = contracts().computeSpendable({ finalizedAtomic: 999_999n, pendingOutgoingAtomic: 0n, activeReservationsAtomic: 0n });
  assert.equal(r.researchCredits, 0n);
  assert.equal(r.spendableAtomic, 999_999n);
});

test('computeSpendable: whole-USDC boundary and zero', () => {
  const { computeSpendable } = contracts();
  assert.equal(computeSpendable({ finalizedAtomic: 13_000_000n, pendingOutgoingAtomic: 0n, activeReservationsAtomic: 0n }).researchCredits, 13n);
  assert.equal(computeSpendable({ finalizedAtomic: 1_000_000n, pendingOutgoingAtomic: 0n, activeReservationsAtomic: 0n }).researchCredits, 1n);
  assert.equal(computeSpendable({ finalizedAtomic: 1n, pendingOutgoingAtomic: 0n, activeReservationsAtomic: 0n }).researchCredits, 0n);
  const zero = computeSpendable({ finalizedAtomic: 0n, pendingOutgoingAtomic: 0n, activeReservationsAtomic: 0n });
  assert.deepEqual([zero.finalizedAtomic, zero.spendableAtomic, zero.researchCredits], [0n, 0n, 0n]);
});

test('computeSpendable: pending outgoing is subtracted before flooring', () => {
  const r = contracts().computeSpendable({ finalizedAtomic: 20_000_000n, pendingOutgoingAtomic: 5_500_000n, activeReservationsAtomic: 0n });
  assert.equal(r.spendableAtomic, 14_500_000n);
  assert.equal(r.researchCredits, 14n);
  assert.equal(r.finalizedAtomic, 20_000_000n, 'finalized must stay the on-chain figure, not the spendable one');
});

test('computeSpendable: active reservations are subtracted before flooring', () => {
  const r = contracts().computeSpendable({ finalizedAtomic: 20_000_000n, pendingOutgoingAtomic: 0n, activeReservationsAtomic: 10_200_000n });
  assert.equal(r.spendableAtomic, 9_800_000n);
  assert.equal(r.researchCredits, 9n);
});

test('computeSpendable: pending outgoing AND reservations both subtract', () => {
  const r = contracts().computeSpendable({ finalizedAtomic: 50_000_000n, pendingOutgoingAtomic: 1_000_001n, activeReservationsAtomic: 2_000_000n });
  assert.equal(r.spendableAtomic, 46_999_999n);
  assert.equal(r.researchCredits, 46n);
});

test('computeSpendable: a single base unit of deduction crosses the credit boundary', () => {
  const { computeSpendable } = contracts();
  assert.equal(computeSpendable({ finalizedAtomic: 10_000_000n, pendingOutgoingAtomic: 1n, activeReservationsAtomic: 0n }).researchCredits, 9n);
  assert.equal(computeSpendable({ finalizedAtomic: 10_000_000n, pendingOutgoingAtomic: 0n, activeReservationsAtomic: 1n }).researchCredits, 9n);
});

test('computeSpendable: never negative when deductions exceed the balance', () => {
  const { computeSpendable } = contracts();
  const cases: [bigint, bigint, bigint][] = [
    [1_000_000n, 2_000_000n, 0n],
    [1_000_000n, 0n, 2_000_000n],
    [1_000_000n, 600_000n, 600_000n],
    [0n, 1n, 0n],
    [0n, 0n, 1n],
    [0n, 5n, 5n],
  ];
  for (const [finalizedAtomic, pendingOutgoingAtomic, activeReservationsAtomic] of cases) {
    const r = computeSpendable({ finalizedAtomic, pendingOutgoingAtomic, activeReservationsAtomic });
    assert.equal(r.spendableAtomic, 0n, `spendable must clamp to 0 for ${[finalizedAtomic, pendingOutgoingAtomic, activeReservationsAtomic]}`);
    assert.equal(r.researchCredits, 0n);
    assert.equal(r.finalizedAtomic, finalizedAtomic);
  }
});

test('computeSpendable: exact beyond Number.MAX_SAFE_INTEGER (no float round-trip)', () => {
  const big = 123_456_789_012_345_678_901_234_567_890n;
  const r = contracts().computeSpendable({ finalizedAtomic: big, pendingOutgoingAtomic: 7n, activeReservationsAtomic: 3n });
  assert.equal(r.spendableAtomic, big - 10n);
  assert.equal(r.researchCredits, (big - 10n) / ONE);
  assert.equal(r.finalizedAtomic, big);
});

test('computeSpendable: does not mutate its input', () => {
  const input = Object.freeze({ finalizedAtomic: 5_000_000n, pendingOutgoingAtomic: 1n, activeReservationsAtomic: 2n });
  assert.doesNotThrow(() => contracts().computeSpendable(input));
});

test('computeSpendable: rejects negative values in every field', () => {
  const { computeSpendable } = contracts();
  const ok = { finalizedAtomic: 5n, pendingOutgoingAtomic: 0n, activeReservationsAtomic: 0n };
  for (const field of Object.keys(ok) as (keyof typeof ok)[]) {
    assert.throws(() => computeSpendable({ ...ok, [field]: -1n }), RangeError, `negative ${field} must throw RangeError`);
  }
});

test('computeSpendable: rejects non-bigint values (number, string, float, null, undefined, object) in every field', () => {
  const { computeSpendable } = contracts();
  const ok = { finalizedAtomic: 5n, pendingOutgoingAtomic: 0n, activeReservationsAtomic: 0n };
  const bad: unknown[] = [0, 5, 1.5, NaN, Infinity, '5', '5n', null, undefined, {}, [], true];
  for (const field of Object.keys(ok) as (keyof typeof ok)[]) {
    for (const value of bad) {
      assert.throws(() => computeSpendable({ ...ok, [field]: value } as any), Error, `${field}=${String(value)} (${typeof value}) must be rejected`);
    }
  }
});

test('computeSpendable: rejects a missing field instead of treating it as zero', () => {
  const { computeSpendable } = contracts();
  assert.throws(() => computeSpendable({ finalizedAtomic: 5n, pendingOutgoingAtomic: 0n } as any), Error, 'missing activeReservationsAtomic');
  assert.throws(() => computeSpendable({ pendingOutgoingAtomic: 0n, activeReservationsAtomic: 0n } as any), Error, 'missing finalizedAtomic');
  assert.throws(() => computeSpendable({ finalizedAtomic: 5n, activeReservationsAtomic: 0n } as any), Error, 'missing pendingOutgoingAtomic');
});

test('computeSpendable: invariants hold over a deterministic pseudo-random sweep', () => {
  const { computeSpendable } = contracts();
  let state = 0x2545f491n;
  const next = (max: bigint) => { state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffff_ffff_ffff_ffffn; return (state >> 11n) % max; };
  for (let i = 0; i < 2000; i++) {
    const finalizedAtomic = next(200_000_000n);
    const pendingOutgoingAtomic = next(120_000_000n);
    const activeReservationsAtomic = next(120_000_000n);
    const r = computeSpendable({ finalizedAtomic, pendingOutgoingAtomic, activeReservationsAtomic });
    const ctx = `[${finalizedAtomic}, ${pendingOutgoingAtomic}, ${activeReservationsAtomic}]`;
    assert.ok(r.spendableAtomic >= 0n, `spendable negative for ${ctx}`);
    assert.ok(r.spendableAtomic <= finalizedAtomic, `spendable exceeds finalized for ${ctx}`);
    assert.ok(r.researchCredits * ONE <= r.spendableAtomic, `RC overstates spendable for ${ctx}`);
    assert.ok((r.researchCredits + 1n) * ONE > r.spendableAtomic, `RC not the floor for ${ctx}`);
    const raw = finalizedAtomic - pendingOutgoingAtomic - activeReservationsAtomic;
    assert.equal(r.spendableAtomic, raw > 0n ? raw : 0n, `wrong spendable for ${ctx}`);
  }
});

/* -------------------------------- centsToAtomic -------------------------------- */

test('centsToAtomic: exact conversion (1 cent = 10,000 base units)', () => {
  const { centsToAtomic } = contracts();
  assert.equal(centsToAtomic(1999), 19_990_000n);
  assert.equal(centsToAtomic(0), 0n);
  assert.equal(centsToAtomic(1), 10_000n);
  assert.equal(centsToAtomic(100), 1_000_000n);
  assert.equal(centsToAtomic(1250), 12_500_000n);
  assert.equal(typeof centsToAtomic(1), 'bigint');
});

test('centsToAtomic: exact at the largest safe integer', () => {
  const { centsToAtomic } = contracts();
  assert.equal(centsToAtomic(Number.MAX_SAFE_INTEGER), BigInt(Number.MAX_SAFE_INTEGER) * 10_000n);
});

test('centsToAtomic: rejects floats, NaN, Infinity', () => {
  const { centsToAtomic } = contracts();
  for (const bad of [19.99, 0.5, 1999.0000001, NaN, Infinity, -Infinity]) {
    assert.throws(() => centsToAtomic(bad), RangeError, `${bad} must be rejected`);
  }
});

test('centsToAtomic: rejects negatives', () => {
  const { centsToAtomic } = contracts();
  for (const bad of [-1, -1999, Number.MIN_SAFE_INTEGER]) {
    assert.throws(() => centsToAtomic(bad), RangeError, `${bad} must be rejected`);
  }
});

test('centsToAtomic: rejects unsafe integers (precision already lost)', () => {
  const { centsToAtomic } = contracts();
  for (const bad of [Number.MAX_SAFE_INTEGER + 1, 2 ** 53, 2 ** 60, 1e21]) {
    assert.throws(() => centsToAtomic(bad), RangeError, `${bad} must be rejected`);
  }
});

test('centsToAtomic: rejects non-number input (string, bigint, null, undefined)', () => {
  const { centsToAtomic } = contracts();
  for (const bad of ['1999', 1999n, null, undefined, {}, true] as unknown[]) {
    assert.throws(() => centsToAtomic(bad as any), Error, `${String(bad)} (${typeof bad}) must be rejected`);
  }
});

test('centsToAtomic composes with computeSpendable: $19.99 of funds is 19 RC, exact', () => {
  const { centsToAtomic, computeSpendable } = contracts();
  const r = computeSpendable({ finalizedAtomic: centsToAtomic(1999), pendingOutgoingAtomic: 0n, activeReservationsAtomic: 0n });
  assert.equal(r.researchCredits, 19n);
  assert.equal(r.spendableAtomic, 19_990_000n);
});

/* ------------------------------- loadFeatureFlags ------------------------------- */

const FLAG_MAP: [string, string][] = FLAG_ENV_NAMES.map((env, i) => [env, FLAG_CAMEL_NAMES[i]]);

test('feature flags: result has exactly the five documented flags', () => {
  const flags = contracts().loadFeatureFlags({});
  assert.deepEqual(Object.keys(flags).sort(), [...FLAG_CAMEL_NAMES].sort());
});

test('feature flags: every flag is false with an empty env', () => {
  const flags = contracts().loadFeatureFlags({}) as unknown as Record<string, unknown>;
  for (const key of FLAG_CAMEL_NAMES) assert.strictEqual(flags[key], false, `${key} must default to exactly false`);
});

test('feature flags: unrelated env does not enable anything', () => {
  const flags = contracts().loadFeatureFlags({ NODE_ENV: 'production', ENABLE_SOMETHING_ELSE: 'true', SOLANA_USDC_TREASURY: 'x' } as any) as unknown as Record<string, unknown>;
  for (const key of FLAG_CAMEL_NAMES) assert.strictEqual(flags[key], false, key);
});

test('feature flags: only the literal string "true" enables, and only that flag', () => {
  const { loadFeatureFlags } = contracts();
  for (const [envName, camel] of FLAG_MAP) {
    const flags = loadFeatureFlags({ [envName]: 'true' } as any) as unknown as Record<string, unknown>;
    for (const key of FLAG_CAMEL_NAMES) assert.strictEqual(flags[key], key === camel, `${envName}=true must set ${camel} only (checked ${key})`);
  }
});

test('feature flags: truthy-looking strings do NOT enable (1, TRUE, True, yes, on, y, padded, quoted, empty, false)', () => {
  const { loadFeatureFlags } = contracts();
  const lookalikes = ['1', 'TRUE', 'True', 'tRuE', 'yes', 'YES', 'on', 'y', 'Y', 't', ' true', 'true ', 'true\n', '"true"', "'true'", 'truee', 'enabled', '', 'false', '0', 'null', 'undefined'];
  for (const [envName, camel] of FLAG_MAP) {
    for (const value of lookalikes) {
      const flags = loadFeatureFlags({ [envName]: value } as any) as unknown as Record<string, unknown>;
      assert.strictEqual(flags[camel], false, `${envName}=${JSON.stringify(value)} must NOT enable ${camel}`);
    }
  }
});

test('feature flags: all five can be enabled together by the literal "true"', () => {
  const env = Object.fromEntries(FLAG_ENV_NAMES.map((n) => [n, 'true']));
  const flags = contracts().loadFeatureFlags(env as any) as unknown as Record<string, unknown>;
  for (const key of FLAG_CAMEL_NAMES) assert.strictEqual(flags[key], true, key);
});

test('feature flags: default argument reads process.env at call time (and is false when unset)', () => {
  const { loadFeatureFlags } = contracts();
  const saved: Record<string, string | undefined> = {};
  for (const n of FLAG_ENV_NAMES) { saved[n] = process.env[n]; delete process.env[n]; }
  try {
    const off = loadFeatureFlags() as unknown as Record<string, unknown>;
    for (const key of FLAG_CAMEL_NAMES) assert.strictEqual(off[key], false, `${key} must be false when process.env has no flags`);
    process.env.ENABLE_REAL_MOONPAY = 'true';
    const on = loadFeatureFlags() as unknown as Record<string, unknown>;
    assert.strictEqual(on.enableRealMoonpay, true, 'loadFeatureFlags() must read process.env when called, not at import time');
    assert.strictEqual(on.enableSolanaMainnet, false);
    process.env.ENABLE_REAL_MOONPAY = '1';
    assert.strictEqual((loadFeatureFlags() as any).enableRealMoonpay, false);
  } finally {
    for (const n of FLAG_ENV_NAMES) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
  }
});
