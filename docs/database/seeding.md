# Seeding the local preview catalog

The storefront catalog (`apps/storefront/lib/products.ts`, 17 draft preview entries) is not served by the API. "Pay with Research Credits" resolves each cart slug with `GET /v1/products/:slug`, takes `product.id` and `product.lots[0].code`, and creates the order with `POST /v1/orders` against real `Product` / `Lot` rows. Without matching rows the checkout ends at "order unavailable". `apps/api/prisma/seed.ts` creates those rows for **local development and tests only**.

## Command

Apply migrations first ([migrations.md](migrations.md)). There is no `prisma.seed` entry in any `package.json` (it was not wired before and is not wired now), so `prisma db seed` and `migrate reset` do **not** run it. Run it explicitly from the repository root:

```sh
# Safe default: 17 products, all UNPUBLISHED (active=false), inventory 0
NODE_ENV=development DATABASE_URL='postgresql://helix@127.0.0.1:54329/helix_field?schema=public' \
  pnpm --filter @helix-field/api exec ts-node prisma/seed.ts

# Sandbox demo: the 16 priced products are created PUBLISHED with inventory 100
NODE_ENV=development SEED_PUBLISH_PREVIEW=true DATABASE_URL='postgresql://helix@127.0.0.1:54329/helix_field?schema=public' \
  pnpm --filter @helix-field/api exec ts-node prisma/seed.ts
```

(`cd apps/api && pnpm exec ts-node prisma/seed.ts` is equivalent.) `DATABASE_URL` and `NODE_ENV` must be in the process environment; the seed does not read `.env` files for its safety checks.

## Refusals (checked before any connection is made)

The seed exits non-zero and writes nothing unless **all** hold:

1. `NODE_ENV` is exactly `development` or `test`. Unset, empty, `production`, `prod`, `Production`, `staging` and every other value are refused. This replicates `isNonProductionRuntime` from `apps/api/src/config/runtime.ts`; `seed.ts` cannot import Nest config, so the allowlist is copied and `tests/catalog-db-sync.test.ts` checks both agree.
2. `DATABASE_URL` is set, is a `postgresql://`/`postgres://` URL, and its host is `localhost` or `127.0.0.1`. URLs with a `host`, `hostaddr` or `socket` query parameter (which could redirect the connection) and multi-host URLs are refused. The validated URL is the one passed to Prisma.
3. `SEED_PUBLISH_PREVIEW` is unset, `false` or `true`; `SEED_PREVIEW_INVENTORY` is unset or a non-negative integer.

## What it creates

For each entry of `apps/api/prisma/seed-data.ts` (a plain data module mirroring the storefront catalog; `tests/catalog-db-sync.test.ts` fails if slugs, names, size labels, `priceCents`, comingSoon/no-price handling or real-vs-draft SKUs drift from `products.ts`):

| Field | Value |
|---|---|
| `slug`, `name` | the storefront's. The size label (`5mg`, `10mg`, ...) is kept in `seed-data.ts` only: `Product` has no size column. |
| `priceCents` | the storefront's **discounted** price (what the bag charges), integer cents. |
| `sku` | The storefront's real SKU only for GHK-Cu (`HF-GHK-005`) and TB-500 (`HF-TB5-005`). Every other product gets `DRAFT-<SLUG-UPPER>` (e.g. `DRAFT-BPC-157`, `DRAFT-MOTS-C`). **A `DRAFT-` SKU is an internal database uniqueness key. It is not a supplier SKU and must not be presented as one.** |
| `active` | `false` (unpublished). Project rule: all products stay unpublished until approved by an authorized administrator. `true` only with `SEED_PUBLISH_PREVIEW=true`. |
| `inventory` | `0`; `100` when `SEED_PUBLISH_PREVIEW=true`; or exactly `SEED_PREVIEW_INVENTORY` when set. |
| Lot | exactly one placeholder: code `PREVIEW-<SKU>` (e.g. `PREVIEW-HF-GHK-005`, `PREVIEW-DRAFT-KPV`), `coaKey` `PENDING-NO-COA`, `purity` `0.00`. |

### Placeholder lots contain no analytical data

`Lot.purity` is a required `Decimal(5,2)` and `Lot.coaKey` a required string, but no analytical testing exists for these materials and the platform must not invent results. `purity` `0.00` therefore means **no analytical data; placeholder**, not a measured purity, and `PENDING-NO-COA` is not an object-storage key (there is no certificate). `GET /v1/products/:slug` returns these values as-is (`purity: "0"`); consumers must not display them as test results. Replace the lot with a real one (real code, COA key and purity) before any real use.

### BAC Water

BAC Water has no price on the storefront (`priceCents: null`, comingSoon). `Product.priceCents` is a required `Int`, so the seed creates the row **inactive with `priceCents` 0 and no lot**, inventory 0, even with `SEED_PUBLISH_PREVIEW=true`. It is never orderable: it is inactive, the order service rejects inactive products, and with no lot the storefront cannot resolve a lot code. Do not activate it: a `0` price is the schema's stand-in for "no price", not a real price. This is the one deliberate exception to "one placeholder lot per product".

## Publishing banner

With `SEED_PUBLISH_PREVIEW=true` the seed prints a banner to stderr stating these are unapproved preview products with placeholder lots and no analytical data. Publishing means "visible in `GET /v1/products` and purchasable in the sandbox flow". It is not an approval.

## Idempotency and what is never overwritten

Re-running is safe: products are upserted by `slug` with an **empty update**, so an existing row's `active`, `priceCents`, `inventory`, `name` and `sku` are never touched, and nothing is deleted. A product's placeholder lot is only created when that product has **no** lots; lots an administrator changed, added or replaced are left alone and a deleted placeholder is not recreated next to a real lot.

Consequences:

- Re-running with `SEED_PUBLISH_PREVIEW=true` does **not** publish products created earlier unpublished (an administrator decision). To demo the sandbox flow on a database seeded earlier, drop the preview rows or use a fresh database/schema.
- Re-running after `seed-data.ts` changes a price does not update existing rows. Price changes in the database are an administrator action.

## Known limits

- Inventory is **not decremented by orders** today and the order service does not check stock, so `inventory` is informational. The `100` default only keeps previewed items looking in stock.
- `GET /v1/products/:slug` returns a product by slug even when `active` is `false` (only the list endpoint filters on `active`). `POST /v1/orders` rejects inactive products (`Unavailable product in order`).
- The old synthetic seed (`synthetic-peptide-standard-a/b`) is gone; rows it created in an existing database are left as they are.

## Verified on a throwaway schema

Against local PostgreSQL 16 with `?schema=seedtest` (`prisma migrate deploy`, seed twice, schema dropped afterwards): first run 17 products + 16 lots, second run 0 created; default run `active=false` for all 17 and inventory 0; with `SEED_PUBLISH_PREVIEW=true` 16 active, BAC Water inactive with no lot, total inventory 1600. An existing product whose price/active/inventory, lot purity/coaKey and name an admin changed was left unchanged by a re-run; a deleted placeholder lot was recreated only because the product had no lots.
