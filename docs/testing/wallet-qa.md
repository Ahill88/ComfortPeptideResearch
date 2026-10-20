# Wallet / Research Credits QA suite

Independent tests for the user-owned wallet and Research Credits domain. They live in `tests/wallet/` and are written
to be implementation-independent: they read the repository **as it exists when they run** and fail with a clear message
when an invariant is violated or a target does not exist yet. A test that targets code that has not been built fails with
`not yet implemented: ...`; nothing is silently skipped, and no test is a passing placeholder.

## How to run

From the repository root (same runner as the other suites; paths are relative to `apps/api`, which `pnpm --dir` makes the
working directory):

```sh
pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only ../../tests/wallet/contracts.test.ts
pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only ../../tests/wallet/custody-invariants.test.ts
pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only ../../tests/wallet/storefront-honesty.test.ts
pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only ../../tests/wallet/scanner-selfcheck.test.ts
pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only ../../tests/wallet/sandbox-scenario.test.ts
```

Each command uses `node:test` with strict assertions and exits non-zero if any test fails. Node 20+ is required. No
database, Redis, network access, browser, or extra dependency is needed. `tests/wallet/_helpers.ts` is shared support
code, not a test.

## What each file covers

| File | Covers |
| --- | --- |
| `contracts.test.ts` | Pure logic in `apps/api/src/wallet/contracts.ts`: `computeSpendable`, `centsToAtomic`, `loadFeatureFlags` (details below). |
| `custody-invariants.test.ts` | Static scans of the repo for custody, secret-handling, flag, network, MoonPay, identity-header and admin read-only invariants (details below). |
| `storefront-honesty.test.ts` | Static scans of the storefront wallet UI for honest wording: Privy claims, paid/confirmed claims, sandbox labelling. |
| `scanner-selfcheck.test.ts` | Known-bad / known-good fixtures proving the scanners above can actually fail (a scan that cannot fail proves nothing). |
| `sandbox-scenario.test.ts` | End-to-end sandbox scenario against the real `SandboxSolanaChain`, `CheckoutService` and `VerificationService` with an in-memory Prisma double. |

### contracts.test.ts
- Credits **floor**: 12.999999 USDC is 12 RC with the exact atomic amount preserved; 0.999999 USDC is 0 RC; whole-USDC
  boundary; a one-base-unit deduction crossing a credit boundary.
- Pending outgoing and active reservations both subtract; spendable never goes negative; values beyond
  `Number.MAX_SAFE_INTEGER` stay exact; a deterministic 2000-case sweep checks `RC * 1e6 <= spendable < (RC + 1) * 1e6`.
- Rejects negative values and every non-bigint (number, string, float, null, undefined, object) in every field, and a
  missing field.
- `centsToAtomic`: 1999 cents is `19990000n`, exact at `MAX_SAFE_INTEGER`, rejects floats, NaN, Infinity, negatives, unsafe
  integers, and non-number input.
- Flags: every flag is `false` with an empty env; only the literal string `true` enables (not `1`, `TRUE`, `True`, `yes`,
  `on`, padded or quoted strings); each env var controls exactly one flag; the default argument reads `process.env` at call
  time.

### custody-invariants.test.ts
- No non-test file under `apps/api/src` contains `Keypair.fromSecretKey/fromSeed/generate`, `new Keypair(`, any
  `secretKey`/`SECRET_KEY`/`privateKey`/`PRIVATE_KEY`/`mnemonic`/seed-phrase identifier or env read, HD derivation / bip39,
  `partialSign`/`signTransaction`/`signMessage`, `.sign(` (except on `jwt`, `jwtService`, `jsonwebtoken`, `hmac`
  receivers), or `nacl.sign(` / `nacl.sign.detached(` / `nacl.sign.keyPair`. `nacl.sign.detached.verify` is allowed
  (verifying needs no secret).
- `MOONPAY_SECRET_KEY` is referenced in exactly one file, a MoonPay provider file under `apps/api/src/wallet`, which must
  use `createHmac('sha256', ...)` and must not log, throw, serialize or return it. No storefront/admin code references it
  or any `NEXT_PUBLIC_*SECRET/PRIVATE` variable.
- No embedded key material in non-test project files (64-number arrays, 86-90 char base58 strings, PEM private keys).
- Prisma schema: no column (or `@map` name) such as `privateKey`, `secretKey`, `seed`, `mnemonic`, `keypair`; no `Bytes`
  column in wallet-domain models.
- Storefront `lib/wallet` and `components/wallet`: no `fetch`/`apiFetch`/`axios`/`sendBeacon`/`api.post` call serializes
  secret-key or seed material.
- `.env.example` declares all five flags set to exactly `false` and carries no secret values; no tracked or untracked
  non-test config/source file assigns any flag to true.
- No mainnet URL, `mainnet-beta`, or `clusterApiUrl('mainnet...')` literal anywhere in API/storefront source or env
  templates; any literal default RPC URL is devnet/local.
- MoonPay provider: never references `SOLANA_USDC_TREASURY`; every `walletAddress` assignment is visibly sourced from the
  destination (customer wallet) address and never a treasury; every caller of `createQuote` passes a destination derived
  from the customer's wallet address, never the treasury.
- Wallet and wallet-admin controllers: any identity-bearing `x-*` header (for example `x-customer-email`) must be paired
  with a `NODE_ENV` / `'production'` rejection. Credential headers such as `x-admin-token` are exempt from this rule
  and are covered by "has an identity mechanism" (`@UseGuards` or a gated identity header).
- `wallet-admin` has no `@Post/@Put/@Patch/@Delete/@All` and at least one `@Get`.

### storefront-honesty.test.ts
- Every line under `app/account/wallet`, `components/wallet`, `lib/wallet` (and `app/wallet` if present) that mentions
  Privy also contains one of `not|future|slot|abstraction|requires|configured`; no Privy SDK import.
- No text saying "paid" or "confirmed" that is gated on a non-finalized status, or maps the Solana `confirmed` commitment
  to a paid/finalized outcome (heuristic, see limits).
- A displayed "sandbox" label exists in a wallet component, is reachable from every wallet `page.tsx` through its import
  tree, and the UI states devnet and not-real-funds.

### sandbox-scenario.test.ts
Uses the repo's real `SandboxSolanaChain` (`creditUsdc`, `finalize`, `recordTransfer`, `fail`, `setOutage`),
`CheckoutService`, `VerificationService`, and `InMemoryPreparedMessageStore`. Only Prisma is replaced (small in-memory
double, itself sanity-tested). The customer keypair is generated **inside the test**, signs locally, and is never passed
to a service.
- Chain level: devnet only; deposit appears in the finalized balance; unsigned, stranger-signed, altered-after-signing,
  overdrawn and garbage transactions are rejected and move nothing; a valid transfer is not applied until finalized and then
  moves exactly the amount.
- Happy path: deposit, balance (25.5 USDC is 25 RC), prepare (exactly 19,990,000 base units to the treasury, customer is
  fee payer, unsigned, one transfer instruction), reservation reduces spendable but not the on-chain balance, sign, submit
  (`SUBMITTED`, order still unpaid), verify while unfinalized (`PENDING`), finalize, verify (`FINALIZED`, order `PAID`,
  reservation `CONSUMED`), credits fall only because the chain balance fell, fulfillment held while the flag is off.
- Exactly-once: re-verify, verify by signature, and identical re-submit are idempotent; fulfillment fires once when its flag is
  on.
- Negatives: submission with no signature (unsigned, empty, random bytes, all-zero signature); signature from another key
  (forged slot, other fee payer/authority, prepared message signed by a stranger); wrong amount signed by the real customer
  (1, total-1, total+1, whole balance); finalized-but-wrong transfers (under/over payment, wrong destination, source, mint,
  network, missing reference) end `FAILED`, never `PAID`; unfinalized and failed-on-chain transfers never settle;
  insufficient credits (including one base unit short) is 402 with no reservation; foreign orders are 404; RPC outage is 503
  with no reservation; mainnet chain is refused while the mainnet/live flags are off.

## What is NOT covered

State plainly so nobody assumes otherwise:

- **No live MoonPay.** Only the URL-building/wiring is checked statically. No widget, KYC, card, webhook, or MoonPay
  sandbox call is exercised.
- **No real Privy.** The tests only check the UI does not claim a Privy integration. Embedded-wallet creation, export and
  recovery are untested because they do not exist.
- **No mainnet.** Nothing talks to any Solana cluster, devnet included. The sandbox chain is an in-memory mock; the
  `DevnetSolanaChain` RPC adapter is not tested at all (no network).
- **No DB-backed integration or concurrency tests.** No Postgres is available locally, so migrations, real Prisma
  semantics, transaction isolation, unique-constraint behavior under load, row locking and concurrent
  prepare/submit/verify races are **not tested**. The in-memory Prisma double is single-threaded and emulates only the calls
  checkout/verification currently make; passing scenarios do not prove the SQL behaves identically.
- No HTTP-level test: controllers, guards, DTO validation and the production 401 behavior are checked by static scan only.
- No browser/UI rendering test of the wallet pages, and no test that the sandbox key never leaves the browser beyond the
  static fetch-body scan.
- No load, fuzz, or timing tests; no reconciliation job test; no admin API behavior test.
- `PreparedMessageStore` is in-memory by design in the current code; multi-instance/restart behavior is untested.

## Limits of static scans

These are text heuristics over comment-stripped source. They catch regressions and careless mistakes, not a determined
author.

- **Custody scan**: matches names and call shapes. Obfuscation (string concatenation, dynamic `require`, aliasing
  `Keypair`, building property names) evades it. `.sign(` on a receiver literally named `jwt`, `jwtService`,
  `jsonwebtoken` or `hmac` is allowed. A file whose purpose is *rejecting* secret-looking request fields necessarily
  contains words such as `secret` or `mnemonic`; the scan flags those too and does not exempt them (see
  "Known open findings").
- **Embedded key material**: a 64-byte Ed25519 signature and a 64-byte secret key encode to the same base58 length, so a
  base58 literal is tolerated only when the word `signature` appears within 4 lines. Documentation (`docs/`) and test
  files are not scanned.
- **Flags set to true**: scans tracked and untracked-but-not-ignored config and source files (`.ts/.tsx/.js/.json/.yml/.sh/
  .toml/.env*/Dockerfile/docker-compose`), not Markdown. Prose such as `set ENABLE_X=true to allow it` inside an error string
  is treated as documentation, not an assignment. Values injected by CI secrets or a deployment system are invisible.
- **Mainnet**: any URL containing `mainnet`, or `mainnet-beta` anywhere in code, is a failure. If a legitimate gated mainnet
  path is added, it must take its URL from the environment, not a literal.
- **Fetch-body scan** (`lib/wallet`, `components/wallet`): finds `fetch`/`apiFetch`/`axios`/`sendBeacon`/`api.post|put|patch`
  calls, then flags secret-named object keys, `{ secretKey }` shorthand, `body: secret`, `JSON.stringify(secret)`, and
  encoders (`bs58.encode`, `Buffer.from`, `Array.from`) applied directly to a secret, either inline or in a variable
  initializer used by the call (one level of tracing). It does **not** flag `sign(tx, kp.secretKey)` because sending a locally
  produced signature is the intended flow. It cannot follow values through function boundaries, spreads, class fields or
  renamed variables.
- **Identity-header gating**: finds `'x-...customer|user|account|admin|actor|identity|principal|subject|session|auth|owner|
  email...'` header literals in a controller and its local imports (3 levels) and requires `NODE_ENV` next to `'production'`
  and a reject/ignore word within 400 characters. It cannot prove the check runs before the header is trusted.
- **"paid"/"confirmed"** (storefront): display text (JSX text or multi-word / Capitalized string literals) containing
  `paid`/`confirmed` is accepted only if the same line is negated (`not|never|yet|until|unless|awaiting|waiting|before|
  pending|cannot|n't`), is about network fees, mentions `finaliz...`, or a finalized check appears in the preceding 6 lines;
  it is rejected when the same line compares against a non-finalized status. Negation is judged per line, so another negation
  word on the same line masks a bad claim. Exact lowercase/UPPERCASE `'paid'`/`'confirmed'` literals are treated as status
  tokens, not display text. A lowercase token `'confirmed'` mapped to a finalized/paid result on the same line, in a
  `case 'confirmed':` branch, or in a lookup table fails.
- **Privy**: line-based; a claim split across lines is judged line by line.

`scanner-selfcheck.test.ts` pins these behaviors with fixtures. If you change a scanner, update the fixtures.

## Known open findings at time of writing

Failures against current code are listed in the QA report that accompanied this suite; they are real and the tests are not
weakened to hide them. At the time of writing:

1. `sandbox-scenario.test.ts` happy path and exactly-once tests fail: `SandboxSolanaChain.broadcast` stores
   `referenceKeys: []`, so verification of a real broadcast ends `FAILED: missing reference` and an end-to-end sandbox purchase
   can never settle. (Checkout's own tests bypass this with `recordTransfer`.) With `referenceKeys` taken from the transfer
   instruction's extra account keys (`ix.keys.slice(4)`), all 14 scenario tests pass in a scratch copy.
2. `custody-invariants.test.ts` fails on `MOONPAY_SECRET_KEY` being read in `wallet.config.ts` as well as the MoonPay
   provider file (the requirement is a single file).
3. `custody-invariants.test.ts` flags `apps/api/src/wallet/secret-fields.ts`, a request-field *denylist* that contains the
   words `secret`, `mnemonic`, `recoveryphrase`. This is arguably legitimate defensive code; resolving it is a product
   decision (restructure, or add a narrowly scoped, reviewed exemption to the scan) and was not decided by the tests.

## Updating the suite

- Do not weaken a rule to make it pass; fix the code, or change the rule with a documented rationale here.
- When the real scenario wiring changes (constructor signatures of `CheckoutService` / `VerificationService`, chain test
  hooks), `sandbox-scenario.test.ts` fails with `wire up scenario: ...` and a list of exactly what it expected.
- Anything needing Postgres (concurrency, isolation, migrations) belongs in a separate, DB-backed suite that does not exist
  yet.
