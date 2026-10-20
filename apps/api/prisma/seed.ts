/**
 * Local PREVIEW seed: mirrors the storefront draft catalog (prisma/seed-data.ts) into Product + Lot rows so the
 * sandbox "Pay with Research Credits" flow can resolve cart slugs. See docs/database/seeding.md.
 *
 * Honesty rules enforced here:
 *  - Refuses to run unless NODE_ENV is exactly "development" or "test" AND DATABASE_URL points at localhost/127.0.0.1.
 *  - Products are created UNPUBLISHED (active=false). Project rule: products stay unpublished until approved by an
 *    authorized administrator. Only SEED_PUBLISH_PREVIEW=true publishes them (sandbox demos), with a loud banner.
 *  - No analytical data exists. Every lot is a placeholder: coaKey PENDING-NO-COA, purity 0.00 ("no data", not a result).
 *  - Draft SKUs (DRAFT-<SLUG>) are internal uniqueness keys, not supplier SKUs.
 *  - Idempotent and non-destructive: existing rows are never updated; only missing rows are created.
 *
 * seed.ts cannot use Nest, so the non-production allowlist of src/config/runtime.ts (isNonProductionRuntime) is
 * replicated below on purpose. Keep the two in sync (tests/catalog-db-sync.test.ts checks the behaviour).
 */
import {
  PLACEHOLDER_COA_KEY,
  PLACEHOLDER_PURITY,
  SEED_PRODUCTS,
  placeholderLotCode,
  type SeedProduct,
} from './seed-data';

type EnvLike = Record<string, string | undefined>;

export class SeedRefusal extends Error {}

/** Replica of isNonProductionRuntime in src/config/runtime.ts: exact strings only. */
export function isNonProductionRuntime(env: EnvLike): boolean {
  return env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1'];
const MAX_INT32 = 2_147_483_647;

export type SeedConfig = { databaseUrl: string; publish: boolean; inventory: number };

/** Throws SeedRefusal unless it is safe to seed. Returns the validated configuration. */
export function resolveSeedConfig(env: EnvLike): SeedConfig {
  if (!isNonProductionRuntime(env)) {
    throw new SeedRefusal(
      `Refusing to seed: NODE_ENV must be exactly "development" or "test" (got ${JSON.stringify(env.NODE_ENV ?? null)}). ` +
        'Unset, misspelled or custom values are treated as production.',
    );
  }
  const raw = env.DATABASE_URL;
  if (!raw || raw.trim() === '') throw new SeedRefusal('Refusing to seed: DATABASE_URL is not set in the environment.');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SeedRefusal('Refusing to seed: DATABASE_URL is not a parseable URL.');
  }
  if (!['postgresql:', 'postgres:'].includes(url.protocol)) {
    throw new SeedRefusal(`Refusing to seed: DATABASE_URL protocol "${url.protocol}" is not postgresql.`);
  }
  if (!LOCAL_HOSTS.includes(url.hostname)) {
    throw new SeedRefusal(`Refusing to seed: database host "${url.hostname}" is not localhost or 127.0.0.1.`);
  }
  // libpq-style query parameters can silently redirect the connection to another host.
  for (const key of ['host', 'hostaddr', 'socket']) {
    if (url.searchParams.has(key)) {
      throw new SeedRefusal(`Refusing to seed: DATABASE_URL must not set the "${key}" query parameter.`);
    }
  }

  const publish = env.SEED_PUBLISH_PREVIEW === 'true';
  if (env.SEED_PUBLISH_PREVIEW !== undefined && env.SEED_PUBLISH_PREVIEW !== 'true' && env.SEED_PUBLISH_PREVIEW !== 'false' && env.SEED_PUBLISH_PREVIEW !== '') {
    throw new SeedRefusal('Refusing to seed: SEED_PUBLISH_PREVIEW must be "true" or unset/"false".');
  }

  let inventory = publish ? 100 : 0;
  const rawInventory = env.SEED_PREVIEW_INVENTORY;
  if (rawInventory !== undefined && rawInventory.trim() !== '') {
    if (!/^\d+$/.test(rawInventory.trim()) || Number(rawInventory.trim()) > MAX_INT32) {
      throw new SeedRefusal('Refusing to seed: SEED_PREVIEW_INVENTORY must be a non-negative integer.');
    }
    inventory = Number(rawInventory.trim());
  }
  return { databaseUrl: raw, publish, inventory };
}

export type PlannedProduct = {
  slug: string;
  name: string;
  sku: string;
  priceCents: number;
  active: boolean;
  inventory: number;
  /** null: no lot is created (not orderable). */
  lot: { code: string; coaKey: string; purity: string } | null;
};

/** Pure plan of what a first run creates. */
export function planSeed(config: Pick<SeedConfig, 'publish' | 'inventory'>, catalog: readonly SeedProduct[] = SEED_PRODUCTS): PlannedProduct[] {
  return catalog.map((product) => {
    // Never orderable: no price, so no lot (the order service rejects a product without the lot code and the storefront
    // cannot resolve one), inactive even with SEED_PUBLISH_PREVIEW=true, inventory 0. priceCents is a required Int
    // column, so 0 is the schema's stand-in for "no price". It is NOT a real price: do not activate this row.
    if (product.priceCents === null || product.comingSoon) {
      return { slug: product.slug, name: product.name, sku: product.sku, priceCents: 0, active: false, inventory: 0, lot: null };
    }
    return {
      slug: product.slug,
      name: product.name,
      sku: product.sku,
      priceCents: product.priceCents,
      active: config.publish,
      inventory: config.inventory,
      // purity is a REQUIRED Decimal column. There is no analytical data, so 0.00 means "no data; placeholder".
      lot: { code: placeholderLotCode(product.sku), coaKey: PLACEHOLDER_COA_KEY, purity: PLACEHOLDER_PURITY },
    };
  });
}

const BANNER = [
  '############################################################################################',
  '# SEED_PUBLISH_PREVIEW=true: NEW preview products are created PUBLISHED (active=true).     #',
  '# These products are NOT approved by an authorized administrator.                          #',
  '# Prices are draft pricing-sheet values. Lots are placeholders with NO COA and             #',
  '# NO analytical data (purity 0.00 = no data). Sandbox / local use ONLY.                    #',
  '############################################################################################',
].join('\n');

async function main() {
  const config = resolveSeedConfig(process.env);
  const plan = planSeed(config);

  // Lazy require so importing this file (tests) never needs a generated client or a database.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });

  if (config.publish) console.error(`${BANNER}\n`);
  const host = new URL(config.databaseUrl);
  console.log(`Seeding ${plan.length} draft preview products into ${host.hostname}:${host.port || '5432'}${host.pathname} (NODE_ENV=${process.env.NODE_ENV}).`);

  const counts = { productsCreated: 0, productsExisting: 0, lotsCreated: 0, lotsExisting: 0 };
  try {
    for (const item of plan) {
      const existing = await prisma.product.findUnique({ where: { slug: item.slug }, select: { id: true } });
      // Empty update: an existing product (active flag, price, inventory, name, sku) is never modified.
      const product = await prisma.product.upsert({
        where: { slug: item.slug },
        update: {},
        create: { slug: item.slug, name: item.name, sku: item.sku, priceCents: item.priceCents, active: item.active, inventory: item.inventory },
      });
      if (existing) counts.productsExisting += 1;
      else counts.productsCreated += 1;

      if (!item.lot) continue;
      // Only add the placeholder when the product has no lots at all, so an admin-managed lot set is never extended
      // or reordered by a re-run (and a deleted placeholder is not resurrected next to a real lot).
      if ((await prisma.lot.count({ where: { productId: product.id } })) > 0) {
        counts.lotsExisting += 1;
        continue;
      }
      await prisma.lot.upsert({
        where: { code: item.lot.code },
        update: {},
        create: { code: item.lot.code, productId: product.id, coaKey: item.lot.coaKey, purity: item.lot.purity },
      });
      counts.lotsCreated += 1;
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(
    `Products: ${counts.productsCreated} created, ${counts.productsExisting} already present. ` +
      `Placeholder lots: ${counts.lotsCreated} created, ${counts.lotsExisting} product(s) already had lots.`,
  );
  if (counts.productsCreated === 0) console.log('Nothing new to create; no existing row was modified.');
  else console.log(
    config.publish
      ? `New orderable products were published (active=true) with inventory ${config.inventory}. Existing rows were left unchanged.`
      : 'New products were created UNPUBLISHED (active=false). Publishing requires administrator approval. Existing rows were left unchanged.',
  );
  console.log('bac-water has no price: created inactive with priceCents 0 and no lot; it is not orderable.');
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof SeedRefusal ? error.message : error);
    process.exit(1);
  });
}
