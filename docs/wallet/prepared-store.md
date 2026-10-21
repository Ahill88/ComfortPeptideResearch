# Prepared-message stores

The platform keeps the exact compiled message it asked the customer to sign (checkout: `PreparedMessageStore`; transfers: `PreparedTransactionStore`) so submit can prove the signed bytes are that message. If the entry is missing, submit fails closed (409) and the customer prepares again.

## Selection (`apps/api/src/wallet/stores/prepared-store.factory.ts`)

`WALLET_PREPARED_STORE` = `postgres` | `redis` | `memory` (case and whitespace insensitive; anything else throws at startup).

| Situation | Store |
| --- | --- |
| Variable unset/blank and `DATABASE_URL` set | `postgres` (any NODE_ENV) |
| Unset, no `DATABASE_URL` | legacy default: `redis` when production-like, `memory` in development/test |
| `postgres` or `redis` | as asked, in every runtime |
| `memory` in development/test | in-memory (one process only, lost on restart) |
| `memory` in any production-like runtime (NODE_ENV anything other than exactly `development` or `test`) | refused: startup throws |

So in development/test the in-memory store is used only when asked for (or when there is no database). Postgres mode without a database client is a startup error, never a silent fallback.

## Postgres store (`postgres-prepared-stores.ts`)

- Table `PreparedMessage` (`key`, `kind`, `payload jsonb`, `expiresAt`). Keys are `msg:<reference>` (checkout) and `tx:<transactionId>` (transfers); every statement also filters on `kind`, so the two stores never read each other's rows.
- The payload is the existing codec's document (`codec.ts`): bytes as base64, bigint as decimal strings, so values round-trip exactly. Decoders reject anything not exactly the shape written, and the embedded id must equal the key.
- `put`/`save` is one upsert (re-prepare replaces the earlier message). `get` returns nothing once `expiresAt` has passed. Checkout entries live 1 hour from `createdAtMs`, transfer entries until the record's `expiresAt` (never more than 24 hours).
- `take(id)` (both stores) is a single `DELETE ... RETURNING`: of any number of concurrent callers, in any number of instances, exactly one gets the entry. The `get` + `delete` interface the services use is unchanged; they do not need `take` today.
- Size cap: an encoded entry over `PREPARED_STORE_MAX_PAYLOAD_BYTES` (default 8192; a compiled message is at most about 1.2 KB) is refused before any SQL and nothing is written.
- Failures surface as `PreparedStoreUnavailableError` (503, generic text). Payloads are never logged; warnings carry no keys or values.

## Expiry sweep

Each store deletes its own expired rows every `PREPARED_STORE_SWEEP_INTERVAL_MS` (default 300000; `0` disables; anything that is not a non-negative integer stops startup). The sweep deletes in batches of 500 with `FOR UPDATE SKIP LOCKED` and repeats the expiry test on the `DELETE`, so several instances can sweep at once without double-deleting or touching live rows. Expiry is also enforced on every read, so a disabled or late sweep only costs disk space.

## Tests

- `stores/__tests__/postgres-prepared-stores.test.ts`: size cap, env parsing, namespacing, error mapping, timer behaviour (no database).
- `stores/__tests__/prepared-store-postgres-matrix.test.ts`: NODE_ENV x `WALLET_PREPARED_STORE` x `DATABASE_URL` selection matrix.
- `stores/__tests__/postgres-prepared-stores.integration.test.ts` (scratch schema): round trips of real checkout and transfer messages, TTL, sweep, 20 parallel takers, two instances, simulated restart through the real checkout and transfers services.
- `tests/wallet/e2e.integration.test.ts` (end of file): prepare, rebuild the Nest app over the same database, submit and settle.
