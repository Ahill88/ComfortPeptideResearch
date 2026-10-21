# Architecture overview

Helix & Field is a pnpm + Turborepo monorepo. Three deployable apps share a few small TypeScript packages. This document describes what the code does today; where something is a mock or a plan, it says so. For setup and commands see the root [README](../../README.md).

## Monorepo

```text
apps/
  storefront/   Next.js 15 storefront                  :3000
  admin/        Next.js operations console             :3002
  api/          NestJS 10 modular monolith (/v1)       :3001
packages/
  ui, shared, payment-sdk, solana-sdk, shipping-sdk    TypeScript source packages (main: src/index.ts)
tests/          cross-cutting suites + run-all.mjs
docs/           this folder
```

Apps import nothing from each other, and **no app currently depends on or imports any `@helix-field/*` package**: the packages are standalone scaffolding (small shared types, `MockShippingProvider`, `MockDevnetSolanaUsdcAdapter`) not yet wired into any flow. The wallet code in `apps/api` and the storefront defines its own types.

## API: a modular monolith

`apps/api/src/app.module.ts` composes the following Nest modules. Modules talk to each other in-process through injected services; they share one PostgreSQL database through the global `PrismaModule`.

| Module | Path | Responsibility | State |
|---|---|---|---|
| Catalog | `catalog/` | `GET /v1/products`, `GET /v1/products/:slug`. Returns only `active: true` products with their lots. | Real code, empty data: the DB holds nothing but optional synthetic seed rows, which are inactive. |
| Orders | `orders/` | `POST /v1/orders` with a required idempotency key and research-use acknowledgement; prices come from active database products, not the client. The route has no authentication guard; the customer email is taken from the request body. | Real code. |
| Payments | `payments/` | Legacy `solana-usdc` payment-intent flow plus a `payment-confirmation` BullMQ queue. | **Disabled by design**: the queue processor always throws until exact RPC verification exists. Not used by wallet checkout. |
| Auth | `auth/` | Register, login, password-reset, email-verification, profile, address and MFA endpoints, plus `SessionGuard` for account routes. | **Endpoints return 503 by design** (no credential or session store). `SessionGuard` accepts a development-only `x-customer-email` identity outside production and always denies in production. The module's `onModuleInit` makes the API refuse to start with `NODE_ENV=production` unless `AUTH_BACKEND=configured`, which nothing can honestly back yet. |
| Compliance | `compliance/` | Customer eligibility (`CustomerEligibility`): status, review requests, and an admin-token decision endpoint. | Endpoints real; wallet checkout (`prepare` and `submit`) enforces `requireApprovedEligibility`. `POST /v1/orders` does not. |
| Wallet | `wallet/` | `/v1/wallet/*`: link a customer-owned address, derived Research Credits balance, on-ramp quotes, external USDC transfers (platform builds an unsigned transaction; the customer signs), chain adapters, feature flags. | Sandbox/devnet. See below. |
| Wallet checkout | `wallet/checkout/` | `/v1/wallet/checkout/:orderId/{prepare,submit,status}`; verification (re-reads the transfer from chain and settles once) and reconciliation. Registered in `AppModule` as `CheckoutModule.register(...)`, with its ports satisfied by `wallet/wallet.wiring.ts`. | Sandbox/devnet. The fulfillment port is a logging no-op. |
| Wallet admin | `wallet-admin/` | Read-only reporting under `/v1/admin/wallets/*` behind `AdminTokenGuard` (`x-admin-token` must equal `ADMIN_API_TOKEN`; denies everything when unset). | Real code; shared static token, not per-user admin auth. |

Not Nest modules: `fulfillment/` (`MockPickPackWorkflow`) and `inventory/` (`InMemoryInventoryReservationAdapter`) are plain in-memory adapters with interfaces, exercised by tests but not registered anywhere in `AppModule`. Operations concerns beyond what is listed above (carrier integration, inventory persistence, refunds) are not built.

`main.ts` sets the global prefix `v1`, a validation pipe (`whitelist`, `transform`), CORS from `STOREFRONT_ORIGIN`, and Swagger UI at `/docs` (outside the prefix, currently ungated).

### Wallet and custody

The platform never holds customer private keys. It stores public addresses (`CustomerWallet`), derives a spendable balance (finalized chain balance minus pending outgoing transfers and active reservations), and relays customer-signed transactions. "Research Credits" are a display unit (1 RC = 1 USDC of spendable value), not a stored balance. The chain is behind a `SolanaChain` port: `sandbox` (in-memory mock, refuses `NODE_ENV=production`) or `devnet` (RPC). Five `ENABLE_*` flags, all `false` by default, guard everything mainnet-, MoonPay- or fulfillment-related. Details: [wallet/architecture.md](../wallet/architecture.md), [wallet/custody-model.md](../wallet/custody-model.md). The rule that no key material enters non-test code is enforced by `tests/wallet/custody-invariants.test.ts`; see [CONTRIBUTING](../CONTRIBUTING.md#custody-rule-no-key-material-in-non-test-code).

## Data

PostgreSQL is the system of record (Prisma schema in `apps/api/prisma/schema.prisma`, three committed migrations). Models: `Customer`, `Product`, `Lot`, `Order`, `OrderItem`, `Payment`, `LedgerEntry`, `CustomerWallet`, `BalanceSnapshot`, `OnRampIntent`, `CryptoTransaction`, `CreditReservation`, `DelegatedPermission`, `WalletAuditEvent`, `CustomerEligibility`. `BalanceSnapshot` and `DelegatedPermission` are not written by any code today. See [database/migrations.md](../database/migrations.md).

Redis backs BullMQ (the payment-confirmation queue). In production the wallet's prepared-transaction and prepared-message stores must also be Redis (`WALLET_PREPARED_STORE`; `memory` is refused with `NODE_ENV=production`); in development they default to in-memory. Redis is never the financial source of truth.

A single-process timer (`ReconciliationScheduler`, default every 60 s, `WALLET_RECONCILE_INTERVAL_MS=0` disables) advances in-flight wallet purchases. With more than one API instance it should move to a repeatable BullMQ job.

## Storefront and admin

- **Storefront** catalog is local preview data in `apps/storefront/lib/products.ts` (17 draft entries), not served by the API. Cart and the "local preview" session live in browser `localStorage`. The mock checkout button does nothing server-side; "Pay with Research Credits" calls the API (`/products/:slug`, `/orders`, `/wallet/checkout/*`) with the development `x-customer-email` identity, and the browser wallet holds a throwaway devnet key in `localStorage`.
- **Admin** is gated by `NODE_ENV=development` + `ADMIN_DEV_SESSION=enabled` + a dev cookie. The overview page renders hard-coded sample data; the `/wallets/*` pages are the read-only reports.

## Cross-cutting rules

- Money is integer cents (USD) or `bigint` USDC base units (6 decimals); never floats.
- Settlement happens only after server-side verification of the transfer; a client-supplied signature alone never settles anything.
- Feature flags default off and only the exact string `true` enables them.
- No secrets in the repo; `.env` is local only. Controls and gaps are listed in [security/controls.md](../security/controls.md) and [wallet/go-live-checklist.md](../wallet/go-live-checklist.md).
- Research-use positioning and publication controls: [compliance/research-use.md](../compliance/research-use.md).

## Extraction

Modules communicate through typed services and, where durable, BullMQ jobs, so they can be split into separate services later without changing external API contracts. That is a design intent; nothing has been extracted.
