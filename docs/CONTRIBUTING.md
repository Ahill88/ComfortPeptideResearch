# Contributing

This is a pre-production repository: nothing here takes real money, and several subsystems are deliberately mocks (see the README's [Status](../README.md#status-what-is-real-and-what-is-not)). Contributions must keep it honest: never make a mock look real, and never turn on a live capability by default.

Setup, commands and local databases are in the root [README](../README.md). This page covers conventions and the common "how do I..." tasks. Every command below exists in `package.json`, `tests/run-all.mjs`, or was run against this repo while writing this page.

## Branches and commits

What the history actually shows: one branch (`main`, tracking `origin/main` on GitHub) and one commit, `Initial commerce platform`. That is too little to establish a convention, so the only conventions that can honestly be drawn from the log are:

- Subject line: short, sentence case, imperative or noun phrase, no type prefix (no `feat:`/`fix:`), no trailing period.
- No commit body in the existing commit.

Recommended on top of that (these are proposals, not established practice; change them if the team prefers otherwise):

- Branch from `main` for each change: `<area>/<short-description>`, for example `api/eligibility-gate` or `docs/readme-refresh`. Keep branches short-lived and merge back to `main`.
- One logical change per commit; explain the reason in the body when it is not obvious.
- Never commit `.env` files, key material, or build output; check `git status` and `git diff --staged` before committing.
- Do not rewrite shared history (no force-push to `main`).

At the time of writing most of the working tree is uncommitted, so expect large first commits to be split before review.

## Local checks before you open a PR

Run from the repo root:

```sh
pnpm lint     # turbo lint: tsc --noEmit in every package; there is no ESLint run
pnpm test     # node tests/run-all.mjs; the Postgres-backed suite is SKIPPED unless TEST_DATABASE_URL is set
pnpm build    # turbo build: next build (storefront, admin), nest build (api), tsc --noEmit (packages)
```

If you touched wallet, checkout or orders code, also run the integration suite (README: [Postgres-backed integration suite](../README.md#postgres-backed-integration-suite)). A SKIPPED line is not a pass.

`.github/workflows/ci.yml` is out of date: it uses `npm ci` and `npm run ... --workspace=...`, which do not match the pnpm setup (and `package-lock.json` is gone). Do not treat a green or red CI run as meaningful until that workflow is updated; the local commands above are the real gate.

## Adding a Prisma migration without Docker

Prisma needs a throwaway PostgreSQL where it may create a *shadow database*. A Homebrew `postgresql@16` cluster in a temp directory is enough. This exact flow (against a copy of `apps/api/prisma`, with `--create-only` and `--skip-generate`) was run successfully while writing this page.

1. Start a throwaway cluster and create a development database (full recipe in the README, [Local database](../README.md#without-docker-homebrew)):

   ```sh
   export PATH="$(brew --prefix postgresql@16)/bin:$PATH"
   export HF_PGDATA="$(mktemp -d)/pgdata"
   initdb -D "$HF_PGDATA" -U helix --auth=trust -E UTF8
   pg_ctl -D "$HF_PGDATA" -o "-p 54329 -c listen_addresses=127.0.0.1" -l "$HF_PGDATA/server.log" -w start
   createdb -h 127.0.0.1 -p 54329 -U helix helix_field
   export DATABASE_URL="postgresql://helix@127.0.0.1:54329/helix_field?schema=public"
   ```

2. Apply the existing migrations so the database matches `main`:

   ```sh
   pnpm --filter @helix-field/api exec prisma migrate deploy
   ```

3. Edit `apps/api/prisma/schema.prisma`.

4. Generate the migration without applying it, then read the SQL:

   ```sh
   pnpm --filter @helix-field/api exec prisma migrate dev --name <short_snake_case_description> --create-only
   ```

   This writes `apps/api/prisma/migrations/<timestamp>_<name>/migration.sql`. Review it by hand. Prisma may emit destructive statements (drops, type changes) for renames; rewrite them to be data-preserving where needed.

5. Apply it and regenerate the client:

   ```sh
   pnpm --filter @helix-field/api exec prisma migrate dev
   pnpm db:generate
   ```

6. Confirm that the migrations and the schema agree (an empty result means in sync):

   ```sh
   pnpm --filter @helix-field/api exec prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code
   ```

7. Stop and delete the cluster: `pg_ctl -D "$HF_PGDATA" -m fast stop && rm -rf "$HF_PGDATA"`.

Rules:

- Never edit a migration that has been merged; add a new one.
- Commit `migration.sql` together with the `schema.prisma` change. The first `migrate dev` on this repo will also create `apps/api/prisma/migrations/migration_lock.toml` (it is missing today); commit it.
- Applying migrations to shared or production databases is always `prisma migrate deploy`, from one place per release. Never run `migrate dev` or `migrate reset` against anything but a throwaway local database.
- Schema columns must never be able to hold key material (private keys, seeds, mnemonics, `Bytes` in wallet models); `custody-invariants.test.ts` checks this.
- With Docker instead: `docker compose up -d postgres redis`, then the same steps with the default `DATABASE_URL` from `.env.example`. (Not verified on this repo's author machine, which has no Docker.)

## Adding tests

- Tests are plain `*.test.ts` files using `node:test` and `node:assert`. The runner `tests/run-all.mjs` discovers every `*.test.ts` under `tests/` and `apps/api/src/` (any depth), runs each with `ts-node --transpile-only` from `apps/api` with `NODE_ENV=test`, and parses the `node:test` summary, so use `node:test`, not another framework.
- Where to put them:
  - Module behavior: `apps/api/src/<module>/__tests__/<name>.test.ts` (the in-memory Prisma double used by the wallet tests is in `apps/api/src/wallet/__tests__/helpers.ts`).
  - Cross-cutting, repo-wide, or static-scan tests: `tests/` or `tests/wallet/`.
  - Anything that needs a real database: name it `*.integration.test.ts`. The runner reports those as SKIPPED when `TEST_DATABASE_URL` is unset. Such a suite must refuse to run against non-local databases (follow `tests/wallet/e2e.integration.test.ts`, which also requires the database name to contain `helix` or `test`).
- Run one suite: `node tests/run-all.mjs <substring-of-path>`, for example `node tests/run-all.mjs custody`. To run a single file directly, from the repo root: `pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only ../../tests/wallet/custody-invariants.test.ts`.
- `tests/authentication-eligibility.test.ts` is excluded from direct runs on purpose; `tests/commerce-workflows.test.ts` imports it.
- Tests must not need network access, real keys, or real provider credentials. Generate throwaway keys inside the test only (see below).
- Do not weaken or delete a failing test or scanner rule to get green. Fix the code, or if the test is wrong, say so in the PR. Static scans are heuristics (see `docs/testing/wallet-qa.md`); `tests/wallet/scanner-selfcheck.test.ts` feeds them known-bad fixtures so they cannot silently stop failing.
- Browser QA lives in `tests/design/` and is not part of `pnpm test`; see [testing/browser-integration-qa.md](testing/browser-integration-qa.md).

## Custody rule: no key material in non-test code

The platform must never generate, load, hold, derive or use private keys, seeds or mnemonics, and must never sign transactions. Customers own their wallets; the API only stores public addresses, builds unsigned transactions, and relays customer-signed ones.

Therefore no key material may enter non-test code. `tests/wallet/custody-invariants.test.ts` enforces this, and it runs under `pnpm test`. In particular it fails when:

- non-test code under `apps/api/src` uses `Keypair.generate/fromSecretKey/fromSeed`, `new Keypair(`, a `secretKey`/`privateKey`/`mnemonic`/seed-phrase identifier, an env read of a `*SEED*` variable, bip39/HD derivation, or a `.sign(`/`partialSign`/`signTransaction`/`signMessage` call;
- `MOONPAY_SECRET_KEY` is referenced anywhere except the env loader and the MoonPay provider (the one allowed use: signing MoonPay widget URLs with an HMAC), or appears in the storefront/admin, or a `NEXT_PUBLIC_*` variable looks like a secret;
- any non-test project file contains a PEM private key, a 64-number byte array, or a base58 string of secret-key length;
- the Prisma schema has a column that could hold key material (or any `Bytes` column in wallet models), or `CustomerWallet` stores anything but a public address;
- wallet fetch calls in the storefront send secret or seed material;
- `.env.example` is missing a feature flag, sets one to anything but `false`, or carries a value for a secret-like variable;
- non-test code assigns any `ENABLE_*` flag to `true`, or contains a mainnet RPC URL / `mainnet-beta`.

Practical consequences:

- Need a keypair for a test? Create it inside the test file (`Keypair.generate()` in a `*.test.ts` or `__tests__/` file is out of scope for the scan). Never write it to disk and never put a literal key in a fixture.
- Do not name variables `secretKey`, `privateKey` or `mnemonic` in API code, even for innocuous things; the scan is textual, so pick another name or fix the design.
- Do not add the rule's exceptions to make a failure go away. If you believe a new exception is warranted, raise it in the PR with justification.

Scope and honesty: these are text scans, not proofs, and they cover what they cover. The storefront's *sandbox wallet* (`apps/storefront/lib/wallet/sandbox-signer.ts`) deliberately generates a throwaway devnet key in the user's own browser and stores it in that browser's `localStorage`; it is not covered by the API scan, must never transmit the secret, and exists only as the devnet stand-in until a provider-managed user-owned wallet is integrated. Do not extend it toward real funds.

## Secrets and `.env`

- **Never commit `.env`.** Copy `.env.example` to `.env` for local values. `.gitignore` ignores `.env` and `.env.local` only; variants such as `.env.production` or `apps/api/.env.staging` are *not* ignored, so do not create them inside the repo. `.dockerignore` excludes `.env` and `.env.*` (except `.env.example`) from image builds.
- `.env.example` is a template: secret-like variables stay blank, and every `ENABLE_*` flag stays `false`. The tests above enforce both.
- Production secrets belong in a managed secret store ([security/controls.md](security/controls.md)). The MoonPay secret in particular must never reach a browser bundle.
- If a secret is ever committed, treat it as compromised: rotate it first, then remove it from history.

## Documentation

- Describe what the code does, and mark mocks, sandboxes and placeholders as such. Verify claims by reading the code or running the command; do not copy from older documents.
- Keep the README's Status table in step with the code when you change what is real.
- `docs/wallet/` and `docs/testing/` are owned by the wallet and QA engineers; coordinate with them before editing those folders.
