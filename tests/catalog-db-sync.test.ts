import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { products as storefront } from '../apps/storefront/lib/products';
import { PLACEHOLDER_COA_KEY, PLACEHOLDER_PURITY, SEED_PRODUCTS, draftSku, placeholderLotCode } from '../apps/api/prisma/seed-data';
import { SeedRefusal, planSeed, resolveSeedConfig } from '../apps/api/prisma/seed';
import { isNonProductionRuntime as runtimeIsNonProduction } from '../apps/api/src/config/runtime';

const root = join(__dirname, '..');
const seedSource = readFileSync(join(root, 'apps/api/prisma/seed.ts'), 'utf8');
const LOCAL_URL = 'postgresql://helix@127.0.0.1:54329/helix_field?schema=public';
const okEnv = { NODE_ENV: 'test', DATABASE_URL: LOCAL_URL };

// ---- seed data never drifts from the storefront catalog -------------------------------------------------------

test('seed data covers exactly the storefront catalog: same slugs, same order, no extras', () => {
  assert.deepEqual(SEED_PRODUCTS.map((p) => p.slug), storefront.map((p) => p.slug));
  assert.equal(new Set(SEED_PRODUCTS.map((p) => p.slug)).size, SEED_PRODUCTS.length);
  assert.equal(SEED_PRODUCTS.length, 17);
});

test('names, size labels and integer-cent discounted prices match the storefront', () => {
  for (const shop of storefront) {
    const seed = SEED_PRODUCTS.find((p) => p.slug === shop.slug);
    assert.ok(seed, `${shop.slug} missing from seed data`);
    assert.equal(seed.name, shop.name, `${shop.slug} name`);
    assert.equal(seed.sizeLabel, shop.sizeLabel, `${shop.slug} sizeLabel`);
    assert.equal(seed.priceCents, shop.priceCents, `${shop.slug} priceCents (discounted price, not originalPriceCents)`);
    if (seed.priceCents !== null) assert.ok(Number.isInteger(seed.priceCents) && seed.priceCents > 0, `${shop.slug} price must be positive integer cents`);
  }
});

test('comingSoon / no-price handling matches: unpriced entries are comingSoon and only those', () => {
  for (const shop of storefront) {
    const seed = SEED_PRODUCTS.find((p) => p.slug === shop.slug)!;
    assert.equal(seed.comingSoon, shop.availability === 'comingSoon', `${shop.slug} comingSoon`);
    assert.equal(seed.comingSoon, shop.priceCents === null, `${shop.slug} comingSoon iff no price`);
  }
  assert.deepEqual(SEED_PRODUCTS.filter((p) => p.priceCents === null).map((p) => p.slug), ['bac-water']);
});

test('SKUs: real storefront SKU only where the storefront has one, otherwise an internal DRAFT-<SLUG> SKU', () => {
  for (const shop of storefront) {
    const seed = SEED_PRODUCTS.find((p) => p.slug === shop.slug)!;
    if (shop.sku !== 'Pending') {
      assert.equal(seed.sku, shop.sku, `${shop.slug} must keep its real storefront SKU`);
      assert.equal(seed.skuIsDraft, false);
    } else {
      assert.equal(seed.sku, `DRAFT-${shop.slug.toUpperCase()}`, `${shop.slug} draft SKU`);
      assert.equal(seed.skuIsDraft, true);
    }
  }
  assert.deepEqual(SEED_PRODUCTS.filter((p) => !p.skuIsDraft).map((p) => p.slug).sort(), ['ghk-cu', 'tb-500']);
  assert.equal(new Set(SEED_PRODUCTS.map((p) => p.sku)).size, SEED_PRODUCTS.length, 'SKUs must be unique');
  assert.equal(draftSku('mots-c'), 'DRAFT-MOTS-C');
});

test('seed-data.ts is a plain data module: no imports and no calls out of the module', () => {
  const text = readFileSync(join(root, 'apps/api/prisma/seed-data.ts'), 'utf8');
  assert.doesNotMatch(text, /^\s*import\s/m);
  assert.doesNotMatch(text, /\brequire\(/);
  assert.doesNotMatch(text, /from\s+['"][^'"]*storefront/);
});

// ---- the plan (what a first run creates) -------------------------------------------------------------------------

test('default plan: 17 products, all unpublished, zero inventory, one placeholder lot each except BAC Water', () => {
  const plan = planSeed(resolveSeedConfig(okEnv));
  assert.equal(plan.length, 17);
  assert.ok(plan.every((p) => p.active === false && p.inventory === 0));
  assert.equal(plan.filter((p) => p.lot).length, 16);
});

test('SEED_PUBLISH_PREVIEW=true publishes the 16 priced products with inventory 100 and never BAC Water', () => {
  const config = resolveSeedConfig({ ...okEnv, SEED_PUBLISH_PREVIEW: 'true' });
  assert.deepEqual({ publish: config.publish, inventory: config.inventory }, { publish: true, inventory: 100 });
  const plan = planSeed(config);
  assert.equal(plan.filter((p) => p.active).length, 16);
  const bac = plan.find((p) => p.slug === 'bac-water')!;
  assert.deepEqual({ active: bac.active, priceCents: bac.priceCents, inventory: bac.inventory, lot: bac.lot }, { active: false, priceCents: 0, inventory: 0, lot: null });
  for (const p of plan.filter((x) => x.slug !== 'bac-water')) {
    const shop = storefront.find((s) => s.slug === p.slug)!;
    assert.equal(p.priceCents, shop.priceCents, `${p.slug} plan price`);
    assert.ok(p.priceCents > 0);
  }
});

test('SEED_PREVIEW_INVENTORY overrides the default; invalid values are refused', () => {
  assert.equal(resolveSeedConfig({ ...okEnv, SEED_PREVIEW_INVENTORY: '5' }).inventory, 5);
  assert.equal(resolveSeedConfig({ ...okEnv, SEED_PUBLISH_PREVIEW: 'true', SEED_PREVIEW_INVENTORY: '0' }).inventory, 0);
  for (const bad of ['-1', '1.5', 'abc', '1e3', '99999999999']) {
    assert.throws(() => resolveSeedConfig({ ...okEnv, SEED_PREVIEW_INVENTORY: bad }), SeedRefusal, bad);
  }
  assert.throws(() => resolveSeedConfig({ ...okEnv, SEED_PUBLISH_PREVIEW: 'yes' }), SeedRefusal);
});

test('placeholder lots carry no analytical data and use the PREVIEW-<SKU> code', () => {
  assert.equal(PLACEHOLDER_COA_KEY, 'PENDING-NO-COA');
  assert.equal(PLACEHOLDER_PURITY, '0.00');
  const plan = planSeed(resolveSeedConfig(okEnv));
  for (const p of plan.filter((x) => x.lot)) {
    assert.deepEqual(p.lot, { code: `PREVIEW-${p.sku}`, coaKey: 'PENDING-NO-COA', purity: '0.00' });
  }
  assert.equal(placeholderLotCode('HF-GHK-005'), 'PREVIEW-HF-GHK-005');
  assert.equal(new Set(plan.filter((x) => x.lot).map((x) => x.lot!.code)).size, 16, 'lot codes unique');
  assert.match(seedSource, /no analytical data/i);
});

// ---- refusal rules --------------------------------------------------------------------------------------------

test('refuses unless NODE_ENV is exactly development or test (same allowlist as src/config/runtime.ts)', () => {
  for (const nodeEnv of [undefined, '', 'production', 'prod', 'Production', 'Development', 'staging', ' test', 'test ']) {
    const env = { NODE_ENV: nodeEnv, DATABASE_URL: LOCAL_URL };
    assert.throws(() => resolveSeedConfig(env), SeedRefusal, String(nodeEnv));
    assert.equal(runtimeIsNonProduction(env), false, `runtime.ts agrees for ${JSON.stringify(nodeEnv)}`);
  }
  for (const nodeEnv of ['development', 'test']) {
    assert.doesNotThrow(() => resolveSeedConfig({ NODE_ENV: nodeEnv, DATABASE_URL: LOCAL_URL }));
    assert.equal(runtimeIsNonProduction({ NODE_ENV: nodeEnv }), true);
  }
});

test('refuses unless DATABASE_URL is a local PostgreSQL host', () => {
  for (const url of [
    undefined, '', 'not a url',
    'postgresql://u@db.example.com:5432/x',
    'postgresql://u@10.0.0.5:5432/x',
    'postgresql://u@127.0.0.1.evil.com:5432/x',
    'postgresql://localhost@evil.com:5432/x',
    'postgresql://u@[::1]:5432/x',
    'postgresql://u@127.0.0.1:5432/x?host=db.example.com',
    'postgresql://u@127.0.0.1:5432/x?hostaddr=10.0.0.5',
    'postgresql://u@127.0.0.1,db.example.com:5432/x',
    'mysql://u@127.0.0.1:3306/x',
  ]) {
    assert.throws(() => resolveSeedConfig({ NODE_ENV: 'test', DATABASE_URL: url }), SeedRefusal, String(url));
  }
  assert.doesNotThrow(() => resolveSeedConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://u:p@localhost:5432/x' }));
  assert.doesNotThrow(() => resolveSeedConfig({ NODE_ENV: 'development', DATABASE_URL: 'postgres://u@127.0.0.1/x' }));
});

// ---- idempotent and non-destructive by construction ----------------------------------------------------------------

test('seed.ts only creates missing rows: every upsert has an empty update and nothing is overwritten or deleted', () => {
  const upserts = seedSource.match(/\.upsert\(\{[\s\S]*?\n\s{6}\}\);/g) ?? [];
  assert.equal(upserts.length, 2, 'one product upsert and one lot upsert');
  for (const block of upserts) assert.match(block, /update:\s*\{\}/, 'update must be empty');
  assert.doesNotMatch(seedSource, /\.(update|updateMany|delete|deleteMany)\(/);
  assert.doesNotMatch(seedSource, /executeRaw|queryRaw|TRUNCATE/i);
  assert.match(seedSource, /where:\s*\{\s*slug:\s*item\.slug\s*\}/, 'product upsert is keyed by slug');
});

test('seed.ts only runs main() when executed directly and never at import time', () => {
  assert.match(seedSource, /if \(require\.main === module\)/);
});
