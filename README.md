# Helix & Field Platform

Storefront, admin console and API for a research-use-only materials shop, plus a sandbox "Research Credits" wallet built on Solana devnet.

> **This is a pre-production preview. No real money moves, no real customers can sign in, and nothing here is approved to take a live order.** Read [Status](#status-what-is-real-and-what-is-not) before relying on any behavior.

The platform does not disguise merchant activity or bypass payment-provider controls. Products are research materials only; the code and copy make no medical, dosing or therapeutic claims.

## Repository layout

pnpm workspace (`pnpm-workspace.yaml`: `apps/*`, `packages/*`) orchestrated by Turborepo (`turbo.json`). `package.json` pins `pnpm@12.14.0` and requires Node >= 20.

| Path | Package | What it is |
|---|---|---|
| `apps/storefront` | `@helix-field/storefront` | Next.js 15 / React 19 / Tailwind storefront. Port **3000**. |
| `apps/admin` | `@helix-field/admin` | Next.js operations console. Port **3002**. Dev-only access gate (see Status). |
| `apps/api` | `@helix-field/api` | NestJS 10 modular monolith, Prisma 6 + PostgreSQL, BullMQ (Redis). Port **3001**, routes under `/v1`. |
| `packages/ui` | `@helix-field/ui` | Shared UI package. Currently an empty stub (`export {}`). |
| `packages/shared` | `@helix-field/shared` | Money types and an integer-cents `usd()` helper (four lines). |
| `packages/payment-sdk` | `@helix-field/payment-sdk` | Payment status types, transition guards and a `PaymentProvider` interface. |
| `packages/solana-sdk` | `@helix-field/solana-sdk` | Devnet USDC mint, invoice/transfer types, `assertDevnet`, and `MockDevnetSolanaUsdcAdapter`. Devnet only. |
| `packages/shipping-sdk` | `@helix-field/shipping-sdk` | `ShippingProvider` interface plus `MockShippingProvider` (fixed fake quotes, `mock-shipping.invalid` labels). No real carrier. |
| `tests/` | n/a | Cross-cutting test suites and `run-all.mjs`, the test runner. |
| `docs/` | n/a | Architecture, database, security, compliance, wallet and QA documents. |

The packages under `packages/` are TypeScript source (`main: src/index.ts`); their `build` and `lint` scripts are `tsc --noEmit`. **No app currently lists any `@helix-field/*` package as a dependency or imports from one**, so they are standalone scaffolding today.

## Getting started

Prerequisites: Node >= 20, pnpm 12 (the repo pins 12.14.0), PostgreSQL 16 and Redis. Postgres can come from Docker or from Homebrew; see [Local database](#local-database).

```sh
pnpm install            # also runs the postinstall hook below
cp .env.example .env    # local values only; .env is git-ignored. Never commit it.
```

`postinstall` runs `pnpm --filter=@helix-field/api prisma:generate`, so the Prisma client is regenerated on every install. Regenerate it manually after editing `apps/api/prisma/schema.prisma` with `pnpm db:generate`.

### Environment loading

Next.js and NestJS's `ConfigModule` look for `.env` in the directory they are started from, which is the app directory when you use `pnpm --filter`, not the repo root. To avoid ambiguity, load the root file into your shell before starting anything:

```sh
set -a; source .env; set +a
```

(This is standard framework behavior; I did not test every app against a root-only `.env`.)

### Commands

All commands run from the repo root and exist in `package.json` (root or the named package).

| Command | What it does |
|---|---|
| `pnpm dev` | `turbo dev --filter=@helix-field/storefront` (`next dev`, port 3000). |
| `pnpm dev:admin` | `turbo dev --filter=@helix-field/admin` (`next dev -p 3002`). |
| `pnpm dev:api` | `turbo dev --filter=@helix-field/api`. **Currently does nothing useful:** `apps/api` has no `dev` script (turbo's dry run reports its command as `<NONEXISTENT>`). Use the command in the next row. |
| `pnpm --filter @helix-field/api start:dev` | Runs the API with `nest start --watch` on port 3001 (override with `PORT`). |
| `pnpm build` | `turbo build` for every package (`next build`, `nest build`, `tsc --noEmit` for the packages). |
| `pnpm lint` | `turbo lint`. Every package's `lint` script is `tsc --noEmit`; there is no ESLint run. |
| `pnpm test` | `node tests/run-all.mjs`. See [Tests](#tests). |
| `pnpm db:generate` | `pnpm --filter=@helix-field/api prisma:generate`. |
| `pnpm --filter @helix-field/api prisma:migrate` | `prisma migrate dev`: creates and applies a migration. For local use only; see [CONTRIBUTING](docs/CONTRIBUTING.md#adding-a-prisma-migration-without-docker). |

Typical local session (three terminals, after the database is up and migrated):

```sh
pnpm dev                                    # http://localhost:3000
pnpm --filter @helix-field/api start:dev    # http://localhost:3001/v1, docs at /docs
pnpm dev:admin                              # http://localhost:3002
```

The storefront's wallet client calls `NEXT_PUBLIC_API_URL`, defaulting to `http://localhost:3001/v1`.

### API documentation

Swagger UI is served at **http://localhost:3001/docs** (OpenAPI JSON at `/docs-json`). Note that `/docs` is *not* under the `/v1` prefix. At the time of writing `apps/api/src/main.ts` serves it in every environment with no production gate; expect that to change before production, so do not treat `/docs` as a permanent public URL.

## Environment variables

Source of truth: [`.env.example`](.env.example). Only the exact string `true` enables a feature flag.

### Feature flags (all default to `false`)

| Variable | Effect when `true` |
|---|---|
| `ENABLE_REAL_MOONPAY` | Use the real MoonPay widget (needs `MOONPAY_*`). Otherwise on-ramp quotes are labeled sandbox simulations. |
| `ENABLE_SOLANA_MAINNET` | Allows the Solana adapter to run against mainnet (also needs `SOLANA_NETWORK=solana-mainnet` and `SOLANA_USDC_MINT`). |
| `ENABLE_LIVE_CRYPTO_PAYMENTS` | Required for mainnet checkout payments. |
| `ENABLE_DELEGATED_PAYMENTS` | Reserved for delegated payments (not built; see Status). |
| `ENABLE_LIVE_FULFILLMENT` | Lets checkout call the fulfillment port. That port is a logging no-op today. |

`tests/wallet/custody-invariants.test.ts` fails if `.env.example` declares any of these as anything but `false`, or if committed code assigns one to `true`.

### Other variables in `.env.example`

| Variable | Default / purpose |
|---|---|
| `DATABASE_URL` | `postgresql://helix:helix@localhost:5432/helix_field?schema=public`; matches `docker-compose.yml`. |
| `REDIS_HOST`, `REDIS_PORT` | `localhost`, `6379`. BullMQ connection (`app.module.ts`). |
| `STOREFRONT_ORIGIN` | `http://localhost:3000`. CORS allow-list (comma-separated). CORS is disabled when unset. |
| `SOLANA_USDC_TREASURY` | Empty. Merchant treasury address used by wallet checkout. |
| `WALLET_LINK_CHALLENGE_KEY` | Empty. Signs wallet-link challenges. Required (>= 32 chars) outside `NODE_ENV=development/test`; random per-process key in dev/test. |
| `ELIGIBILITY_REQUIRED` | `true`. Eligibility gate on checkout prepare/submit. `false` is honored only when `NODE_ENV` is exactly `development` or `test`; ignored (with a warning) elsewhere. |
| `WALLET_CHAIN_MODE` | `sandbox` (in-memory mock chain; refuses `NODE_ENV=production`) or `devnet` (real Solana RPC). |
| `SOLANA_NETWORK` | `solana-devnet` (default) or `solana-mainnet` (needs `ENABLE_SOLANA_MAINNET=true`). |
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com`. |
| `SOLANA_USDC_MINT` | Empty. Only needed for mainnet; devnet uses the built-in devnet USDC mint. |
| `MOONPAY_PUBLISHABLE_KEY`, `MOONPAY_SECRET_KEY` | Empty. Only used with `ENABLE_REAL_MOONPAY=true`. The secret signs widget URLs server-side; never expose or commit it. |
| `PRIVY_APP_ID` | Empty. Setting it alone does not integrate Privy. |

### Read by code but not listed in `.env.example`

| Variable | Used by |
|---|---|
| `PORT` | API listen port (default 3001). |
| `REDIS_URL` | Prepared-transaction store Redis client; wins over `REDIS_HOST`/`REDIS_PORT` for that client only. |
| `WALLET_PREPARED_STORE` | `redis` or `memory`. Production defaults to `redis` and refuses `memory`; elsewhere defaults to `memory`. |
| `WALLET_RECONCILE_INTERVAL_MS` | Checkout reconciliation timer (default 60000; `0` disables). |
| `SOLANA_USDC_MAINNET_MINT` | Read by checkout config for mainnet purchases. (The wallet adapter reads `SOLANA_USDC_MINT`; the two are not unified.) |
| `ADMIN_API_TOKEN` | Server token for `x-admin-token` on `/v1/admin/*` routes. Routes deny everything when unset. |
| `ADMIN_DEV_SESSION` | Set to `enabled` (admin app, `NODE_ENV=development` only) to allow the dev admin session. |
| `AUTH_BACKEND` | Production startup gate; see Status. The API refuses to boot with `NODE_ENV=production` regardless. |
| `NEXT_PUBLIC_API_URL` | Storefront wallet client base URL (default `http://localhost:3001/v1`). |
| `TEST_DATABASE_URL` | Enables the Postgres-backed integration suite. |

## Local database

The API needs PostgreSQL (system of record) and, for BullMQ, Redis. Migrations live in `apps/api/prisma/migrations/` and are applied with `prisma migrate deploy`.

### Without Docker (Homebrew)

```sh
brew install postgresql@16
export PATH="$(brew --prefix postgresql@16)/bin:$PATH"
```

**Option 1: a throwaway cluster.** Nothing is installed as a service; everything lives in a directory you delete afterwards. Verified on this repo with PostgreSQL 16.15 (on a different port; pick any free port):

```sh
export HF_PGDATA="$(mktemp -d)/pgdata"
initdb -D "$HF_PGDATA" -U helix --auth=trust -E UTF8
pg_ctl -D "$HF_PGDATA" -o "-p 54329 -c listen_addresses=127.0.0.1" -l "$HF_PGDATA/server.log" -w start
createdb -h 127.0.0.1 -p 54329 -U helix helix_field

export DATABASE_URL="postgresql://helix@127.0.0.1:54329/helix_field?schema=public"
pnpm --filter @helix-field/api exec prisma migrate deploy

# when finished
pg_ctl -D "$HF_PGDATA" -m fast stop && rm -rf "$HF_PGDATA"
```

`--auth=trust` is acceptable only because the server listens on `127.0.0.1`. Put the same `DATABASE_URL` in `.env` (or your shell) for the API.

**Option 2: Homebrew service on 5432** (not verified here; I did not start a service on this machine):

```sh
brew services start postgresql@16
psql postgres -c "CREATE ROLE helix LOGIN PASSWORD 'helix' CREATEDB"
createdb -O helix helix_field
pnpm --filter @helix-field/api exec prisma migrate deploy   # with the default DATABASE_URL from .env.example
```

**Redis** without Docker: `brew install redis && redis-server` (not verified; Redis is not installed on the machine this README was checked on, and I did not test whether the API boots without it). Wallet prepared-transaction state is in-memory outside production, so only the BullMQ-backed payment queue needs it in development.

Optional synthetic seed (two unpublished products, zero inventory), from `apps/api` after migrating: `pnpm exec ts-node prisma/seed.ts`. See [docs/database/migrations.md](docs/database/migrations.md).

### With docker-compose

```sh
docker compose up -d postgres redis
pnpm --filter @helix-field/api exec prisma migrate deploy
```

`docker-compose.yml` starts `postgres:16-alpine` (user/password `helix`, database `helix_field`, port 5432) and `redis:7-alpine` (6379), which match the defaults in `.env.example`.

Docker is not installed on the machine used to check this README, so the compose path is **unverified**. Do not use the compose `api` and `storefront` services yet: both Dockerfiles still install with `npm` and copy `package-lock.json`, which was removed in the move to pnpm, so they are stale. Run those two apps with the pnpm commands above.

## Tests

```sh
pnpm test                          # node tests/run-all.mjs: every *.test.ts under tests/ and apps/api/src
node tests/run-all.mjs wallet      # only suites whose path contains "wallet"
```

`tests/run-all.mjs` runs each suite under `ts-node --transpile-only` with `NODE_ENV=test`, prints real per-suite and aggregate counts, and exits non-zero on any failure. Suites use `node:test`; the runner parses its summary output. When last run (27 suites, 1 skipped) it reported 329 passed, 0 failed; treat those numbers as a snapshot, not a guarantee.

### Postgres-backed integration suite

`tests/wallet/e2e.integration.test.ts` exercises the real wallet, checkout and orders modules against real PostgreSQL. **When `TEST_DATABASE_URL` is unset the runner prints `SKIP  tests/wallet/e2e.integration.test.ts  (set TEST_DATABASE_URL to run)` and counts it as skipped, never as passed.**

The suite TRUNCATES tables and refuses to run unless the URL's host is `127.0.0.1` or `localhost` and the database name contains `helix` or `test`. Use a dedicated database, with migrations applied first:

```sh
createdb -h 127.0.0.1 -p 54329 -U helix helix_test      # using the throwaway cluster above
DATABASE_URL="postgresql://helix@127.0.0.1:54329/helix_test?schema=public" \
  pnpm --filter @helix-field/api exec prisma migrate deploy

TEST_DATABASE_URL="postgresql://helix@127.0.0.1:54329/helix_test?schema=public" \
  node tests/run-all.mjs e2e.integration
```

Status when I ran it against a freshly migrated throwaway database: 8 tests, 6 passed, **2 failed** (`authorization: the platform rejects unsigned, wrong-key, and tampered transactions` fails with `unknown signer`; `database enforces uniqueness the application relies on` fails the assertion `reference must be unique`). Those failures were not investigated or fixed here. The suite is not green yet.

### Browser QA harness

`tests/design/browser-qa.mjs` (storefront, Playwright, three viewports) and `tests/design/service-browser-qa.mjs` (API docs page and admin sign-in) run against already-running dev servers. They need Playwright installed outside the workspace and an explicit Chromium path, so setup is non-trivial. Follow [docs/testing/browser-integration-qa.md](docs/testing/browser-integration-qa.md) for the exact commands and latest results, and [docs/testing/browser-design-qa.md](docs/testing/browser-design-qa.md) for tooling setup and environment options (`QA_BASE_URL`, `QA_TOOLS`, `QA_BROWSER`, `QA_OUTPUT`).

## Status: what is real and what is not

Verified by reading the code in this repo, not by trusting older documents. Anything not listed is not built.

| Area | State | Evidence |
|---|---|---|
| **Catalog (storefront)** | **Local preview data.** 17 entries in `apps/storefront/lib/products.ts`, every one `publicationStatus: 'draft'`. Only GHK-Cu and TB-500 have SKU/CAS/formula/lot values (still unverified preview values); every other entry, including BPC-157, reads "Pending". **BAC Water is "coming soon" with no price.** "Available" means eligible for the mock bag, not that stock exists. | `products.ts` |
| **Catalog (API)** | Separate and empty by default. `GET /v1/products` returns only `active: true` rows from Postgres. The only seed data is two synthetic products with `active: false` and zero inventory. **The storefront catalog is not served by the API**, so the two do not match. | `catalog.service.ts`, `prisma/seed.ts` |
| **Checkout: "Prepare mock devnet payment"** | **Mock.** Validates the form and shows a confirmation message. No order, no payment, no API call. | `components/checkout-form.tsx` |
| **Checkout: "Pay with Research Credits"** | Targets the wallet API: resolves cart slugs against `/v1/products/:slug`, creates an order via `POST /v1/orders`, then runs `/v1/wallet/checkout/:orderId/*`. Because preview catalog slugs generally do not exist as active API products, it normally stops at "order unavailable". Devnet/sandbox only. | `components/wallet/credits-checkout.tsx` |
| **Storefront auth** | **Local-preview session in browser `localStorage`. This is not secure authentication.** Anyone can create any identity, "email verification" and "MFA" are toggles in that stored object. | `components/auth-provider.tsx` |
| **API auth** | Register, login, password reset, email verification, profile, address and MFA endpoints **return 503 by design**; no credential, token or session store exists. Account routes use a development-only `x-customer-email` identity header that is ignored in production, where they always return 401. `POST /v1/orders` itself has no authentication guard (the customer email comes from the request body). The API refuses to start with `NODE_ENV=production` (it requires `AUTH_BACKEND=configured`, which nothing can honestly back). | `auth/auth.service.ts`, `auth/session.guard.ts`, `auth/auth-startup.check.ts` |
| **Solana** | **Sandbox / devnet only.** `WALLET_CHAIN_MODE=sandbox` is an in-memory mock chain. `devnet` talks to Solana devnet RPC. Mainnet is behind `ENABLE_SOLANA_MAINNET` plus other flags; `docs/wallet/architecture.md` says no adapter has touched a real cluster, and I found nothing contradicting that. The legacy `payments` BullMQ processor always throws "Live Solana settlement is disabled". | `wallet/chain/*`, `payments/solana-usdc.processor.ts` |
| **Wallets** | The only wallet provider is a **sandbox browser wallet**: a throwaway devnet key generated in the browser and stored in `localStorage`; it is not for real funds and has no recovery. The platform stores public addresses only and never signs. | `lib/wallet/sandbox-signer.ts`, `wallet/wallet-providers.ts` |
| **MoonPay** | **Not integrated for real.** With `ENABLE_REAL_MOONPAY=false` quotes are labeled sandbox simulations and `POST /v1/wallet/onramp/:id/mock-complete` credits the in-memory chain. The real-URL code path exists but has never been called against MoonPay and has no webhook handler. | `wallet/onramp/*` |
| **Privy** | **Not integrated.** `PRIVY_APP_ID` only changes a descriptor; the API records the address a client reports and does not verify it came from Privy. | `wallet/wallet-providers.ts` |
| **Customer eligibility** | Persisted (`CustomerEligibility`, PENDING/APPROVED/REJECTED) with customer-facing status/review-request endpoints and an admin-token decision endpoint. **Wallet checkout enforces the gate**: `CheckoutService.prepare` and `submit` call `requireApprovedEligibility` (403 unless APPROVED; re-checked at submit and before the claim). `POST /v1/orders` does **not** require it. | `compliance/eligibility.gate.ts`, `wallet/checkout/checkout.service.ts` |
| **Admin app** | **Dev-only gate.** The dashboard is reachable only when `NODE_ENV=development` and `ADMIN_DEV_SESSION=enabled` and a dev cookie is set; otherwise it redirects to an "Access denied" page. The overview page shows **hard-coded sample numbers**. Production needs identity-provider auth, server-verified RBAC and MFA, none of which exist. | `apps/admin/app/page.tsx`, `app/sign-in`, `app/api/dev-session` |
| **Admin API** | Token-guarded (`x-admin-token` vs `ADMIN_API_TOKEN`, fails closed): wallet reporting (read-only GETs) and `POST /v1/admin/eligibility/:customerId/decision`. A shared static token, not per-user admin auth. | `wallet-admin/`, `compliance/eligibility-admin.controller.ts` |
| **Fulfillment / shipping** | **Mock adapters.** `MockPickPackWorkflow` and `InMemoryInventoryReservationAdapter` are in-memory and not registered in any Nest module. The checkout fulfillment port is a no-op that logs a warning and runs only when `ENABLE_LIVE_FULFILLMENT=true`. `shipping-sdk` ships only `MockShippingProvider` (fake quotes and labels). | `fulfillment/`, `inventory/`, `wallet/wallet.wiring.ts` |
| **Delegated payments** | Not built. `DelegatedPermission` exists in the schema and is not written by any code. | `docs/wallet/delegated-payments.md` |
| **Money** | **No real money flows.** No fiat processor, no mainnet traffic, no live fulfillment, no tax or shipping calculation. | n/a |

Production readiness work still outstanding is tracked in [docs/wallet/go-live-checklist.md](docs/wallet/go-live-checklist.md) and [docs/security/controls.md](docs/security/controls.md).

## Documentation

- [Architecture overview](docs/architecture/overview.md)
- [Contributing](docs/CONTRIBUTING.md)
- [Database migrations](docs/database/migrations.md)
- [Wallet and Research Credits](docs/wallet/architecture.md), [custody model](docs/wallet/custody-model.md), [providers](docs/wallet/providers.md)
- [Security controls](docs/security/controls.md), [research-use controls](docs/compliance/research-use.md)
- [Testing and QA](docs/testing/)
