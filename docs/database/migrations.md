# Database Migrations

Migrations live in `apps/api/prisma/migrations/` and are applied with Prisma. Committed migrations:

| Migration | Adds |
|---|---|
| `20261020000000_init` | Baseline commerce schema: customers, products, lots, orders, payments, ledger entries. |
| `20261020120000_wallet_credits` | Wallet and Research Credits tables (`CustomerWallet`, `OnRampIntent`, `CryptoTransaction`, `CreditReservation`, `BalanceSnapshot`, `DelegatedPermission`, `WalletAuditEvent`). |
| `20261020150000_customer_eligibility` | `CustomerEligibility`. |
| `20261020160000_order_idempotency` | `Order.idempotencyKey` / `Order.requestHash` and a unique `(customerId, idempotencyKey)` index. |

Applying all of them to an empty PostgreSQL 16 database and then diffing the live database against `schema.prisma` (`prisma migrate diff --from-schema-datasource ... --to-schema-datamodel ...`) produced an empty migration when this was checked, i.e. the migrations and the schema agree.

The directory currently has **no `migration_lock.toml`**. `migrate deploy` does not need it, but the next `prisma migrate dev` will create it; commit that file with your migration.

For local database setup (with or without Docker) see the root [README](../../README.md#local-database); for creating a migration see [CONTRIBUTING](../CONTRIBUTING.md#adding-a-prisma-migration-without-docker).

## Apply Migrations

Set `DATABASE_URL` to the target PostgreSQL database. From the repository root, apply committed migrations with:

```sh
pnpm --filter @helix-field/api exec prisma migrate deploy --schema prisma/schema.prisma
```

`migrate deploy` only applies committed migrations; it never creates one, resets the database or prompts. For local development, create a new migration after changing the schema with the following (needs a database where Prisma may create a shadow database; the throwaway-cluster recipe in the README qualifies):

```sh
pnpm --filter @helix-field/api exec prisma migrate dev --schema prisma/schema.prisma --name <short_snake_case_description>
```

Generate the client without connecting to a database with:

```sh
pnpm --filter @helix-field/api exec prisma generate --schema prisma/schema.prisma
```

## Seed Data

The seed mirrors the storefront's draft preview catalog into `Product` and `Lot` rows, **unpublished by default**. It is documented in [seeding.md](seeding.md) (command, safety refusals, flags, idempotency, what it does not do). It does not create customers, orders, payments, or ledger records.
