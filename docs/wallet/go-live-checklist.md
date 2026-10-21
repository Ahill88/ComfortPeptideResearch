# Go-live checklist

All five flags default to off (`loadFeatureFlags` in `apps/api/src/wallet/contracts.ts`; only the exact value `true` enables) and are set to `false` in `.env.example`. Turn on in the order below; each gate assumes the earlier ones are complete. Nothing here has been approved. A box is checked only with evidence (a document, a ticket, or a test run). Evidence cited below was gathered on 2026-10-20.

## Gate 0: before any flag

- [x] Wallet tables have a migration: `apps/api/prisma/migrations/20261020120000_wallet_credits`. Evidence: its SQL, with the init migration, matches `schema.prisma` statement for statement (`prisma migrate diff`, offline).
- [ ] Apply the migrations to a real Postgres and run DB-backed tests. **Not done.** Every wallet test uses an in-memory Prisma double; migrations, transaction isolation, unique-constraint behavior under load, and concurrent prepare/submit/verify races are untested.
- [x] Wallet invariants enforced by tests: `tests/wallet/custody-invariants.test.ts`, `contracts.test.ts`, `storefront-honesty.test.ts`, `scanner-selfcheck.test.ts`, `sandbox-scenario.test.ts`, plus `apps/api/src/wallet*/__tests__/`. Static scans are heuristics, not proof (see `custody-model.md` and `docs/testing/wallet-qa.md`).
- [x] The five flags are in `.env.example` with `false` (asserted by `custody-invariants.test.ts`).
- [ ] Flags checked at their call sites: partly. `ENABLE_REAL_MOONPAY`, `ENABLE_SOLANA_MAINNET`, `ENABLE_LIVE_CRYPTO_PAYMENTS` (mainnet checkout only), and `ENABLE_LIVE_FULFILLMENT` are read; `ENABLE_DELEGATED_PAYMENTS` is read by nothing but the admin status report (see `architecture.md`).
- [ ] Admin has real authentication and MFA. Wallet reporting endpoints are guarded by a shared static `x-admin-token` (`ADMIN_API_TOKEN`, fails closed when unset), and the admin UI is behind a development-only session (`apps/admin/components/wallets/gate.ts`; `apps/admin/app/page.tsx` still says production must integrate an identity provider). Neither is production authentication.
- [ ] Real customer authentication. Wallet and checkout controllers trust the `x-customer-email` header outside production and return 401 in production. The storefront session is browser-local preview state.
- [ ] Customer eligibility enforced before wallet checkout. It is not: nothing under `apps/api/src/wallet/` checks eligibility, and `apps/api/src/compliance/eligibility.service.ts` only throws 503.
- [ ] The 3 failing readiness tests pass (`tests/authentication-eligibility.test.ts`, run through `tests/commerce-workflows.test.ts`): server-validated session guard on account routes; production startup checks for email verification, password reset, and MFA; persisted customer eligibility.
- [ ] Open questions in `custody-model.md` sent to counsel.
- [ ] Customer-facing wallet copy reviewed by counsel (the sandbox security panel says "You hold the key." and "User-owned").

## Gate F: fee sponsorship (`FEE_SPONSORSHIP=true`; skip entirely if it stays off)

Owner-approved product decision: the platform pays the Solana network fee for wallet checkout so customers who only bought USDC can pay. It is OFF by default and independent of the five flags above, but it makes the platform sign (as fee payer only) and holds a funded key, so none of the following is done yet. Nothing here has been run against a real cluster; only the sandbox signer and in-memory/Postgres tests exist.

- [ ] **Fee-payer key in KMS/HSM, implemented and bound.** A `FEE_PAYER_SIGNER` implementation (cloud KMS ed25519 key, HSM, or a policy engine) that never exports key material, bound after `...checkoutPortProviders` in `CheckoutModule.register`. **Not built; the repo ships only the sandbox-only in-memory signer.** Without it the API logs a startup warning and every customer pays the fee in SOL.
- [ ] The fee-payer account is dedicated: not the merchant treasury, not any customer wallet, never holds USDC, funded only with the SOL budget. (The service refuses a key equal to the customer or treasury; it cannot know about other accounts.)
- [ ] Signing policy at the KMS/HSM: restrict the key to ed25519 signing of Solana messages from the API's identity only, with rate limits and an audit trail independent of the application, and the ability to disable the key without a deploy.
- [ ] **Sponsor balance monitoring and alerting.** Alert on the fee-payer SOL balance before it reaches `FEE_SPONSOR_MIN_LAMPORTS` (below it checkout silently falls back to customer-pays and zero-SOL customers cannot pay) and on a fast burn rate. **No alerting exists in the repo.** Decide the top-up procedure and the maximum balance held.
- [ ] Set `FEE_SPONSOR_MIN_LAMPORTS` and `FEE_SPONSOR_MAX_PER_CUSTOMER_DAY` from real fee and abuse data; review how the per-customer cap interacts with creating many approved customers, and whether a global daily ceiling is also needed (none exists).
- [ ] Eligibility gate is enforced in the target environment (`ELIGIBILITY_REQUIRED` is ignored outside development/test): sponsorship applies only to APPROVED customers because prepare/submit refuse everyone else.
- [ ] Key-compromise and drain runbook: how to disable the signer, rotate the key (in-flight sponsored payments fail closed with 503 and are re-prepared), and sweep remaining SOL; expected maximum loss is the funded balance.
- [ ] A real-cluster test of a sponsored payment: two-signature transaction accepted by a devnet cluster, fee charged to the fee payer, the first signature (the fee payer's) used as the id by `DevnetSolanaChain.getTransfer`, and verification settling it. **Never done.** Also decide whether the 2 x 5000 lamport quote is right for the cluster in use (no priority fees are modelled).
- [ ] Counsel has reviewed fee sponsorship (open question 12 in `custody-model.md`) and the customer-facing disclosure ("paid by Helix & Field").
- [ ] Production prepared-message store is Redis (`WALLET_PREPARED_STORE`); the sponsorship decision lives in the stored compiled message and a missing entry makes submit fail with 409.

## Flags and required approvals

| Flag | What it enables | Approvals and evidence required before switching on |
|---|---|---|
| `ENABLE_REAL_MOONPAY` | Real signed widget URLs instead of sandbox quotes (`moonpay-onramp.provider.ts`) | MoonPay merchant/category and storefront approval for this product category; URL signing and currency code (`usdc_sol`) verified against MoonPay docs **and a real MoonPay sandbox call** (never done); customer disclosures reviewed by counsel; sanctions-screening provider chosen; webhooks either implemented from MoonPay docs (none exist) or the balance-read-only approach accepted, including that intents stay `CREATED`; Privy (user-owned wallet) actually integrated, not the sandbox wallet |
| `ENABLE_SOLANA_MAINNET` | Mainnet network and mint in `DevnetSolanaChain`, checkout, and the live MoonPay key | Mainnet USDC mint confirmed from Circle's official documentation and configured; `SOLANA_USDC_MINT` / `SOLANA_USDC_MAINNET_MINT` unified and `VerificationService.expectedMint` fixed (today mainnet verification always fails as `wrong mint`); production RPC contracted; treasury address under KMS/HSM design with its token account created; devnet end-to-end passed **on a real cluster** (never done); fail-closed RPC behavior tested against the real adapter; Circle/issuer terms reviewed by counsel |
| `ENABLE_LIVE_CRYPTO_PAYMENTS` | Mainnet checkout prepare (it is only read by `CheckoutService.prepare`) | Verification checks in `architecture.md` proven against real chain data and Postgres (they are unit-tested with fakes only); the reconciliation scheduler running (`WALLET_RECONCILE_INTERVAL_MS`, single-process timer; BullMQ repeatable job if more than one instance) with alerting (none exists); persistent shared prepared-message stores; refund path implemented with KMS/HSM treasury key and maker-checker approval (or an approved interim manual refund procedure); money-transmission/licensing analysis completed by counsel; real sanctions screening and travel-rule position; tax position; SOL-fee approach decided (`providers.md`); incident and key-compromise runbook |
| `ENABLE_DELEGATED_PAYMENTS` | Delegated spending permissions (no code exists) | Only after all go criteria in `delegated-payments.md`. Current status: no-go. Requires `ENABLE_LIVE_CRYPTO_PAYMENTS` to be stable first. |
| `ENABLE_LIVE_FULFILLMENT` | Paid orders call `FULFILLMENT_PORT` | Today that port is a no-op that logs a warning (`wallet.wiring.ts`); a real fulfillment adapter must replace it (and `MockPickPackWorkflow` is not connected); live payments proven on mainnet at small volume; reconciliation clean; research-use and eligibility controls verified (`docs/compliance/research-use.md`); carrier and inventory integrations tested; shipping restrictions by state/country confirmed by counsel |

## What is built, mock, or disabled today

- **Built and unit-tested with doubles:** wallet link; derived credits; sandbox on-ramp mock; external transfers; checkout prepare/submit/status; verification and settlement; reconciliation service and scheduler; read-only admin API and UI. See `architecture.md`.
- **Test status:** `pnpm test` (`node tests/run-all.mjs`): 19 suites, 242 passed, 3 failed on 2026-10-20. The three failures are the pre-existing readiness tests listed in Gate 0. `pnpm --dir apps/api lint` (`tsc --noEmit`) passes.
- **Chain:** `SandboxSolanaChain` is an in-memory mock and the default (`WALLET_CHAIN_MODE=sandbox`; refuses `NODE_ENV=production`). `DevnetSolanaChain` has only been exercised against a fake `Connection` (constructor guards and RPC-failure wrapping), never a real cluster. In a running sandbox API nothing finalizes submitted transfers (only tests call `finalize`).
- **Network:** devnet only. The USDC devnet mint is a literal in four places (`contracts.ts`, `packages/solana-sdk`, `payments.service.ts`, storefront `lib/wallet/tx.ts`). Mainnet is guarded and unusable (see `providers.md`).
- **Settlement:** wallet checkout settles through `VerificationService`, triggered only by `ReconciliationService` (interval `WALLET_RECONCILE_INTERVAL_MS`, default 60000, `0` disables; settles rows older than 60 s; single-process timer). It writes no `Payment` or `LedgerEntry` rows. The legacy path is still disabled: `SolanaUsdcProcessor.process` (`apps/api/src/payments/solana-usdc.processor.ts`) and `PaymentsService.recordConfirmedPayment` always throw.
- **Wallet link key:** set `WALLET_LINK_CHALLENGE_KEY` (>= 32 chars); the API refuses to start without it outside development/test. Do not set `ELIGIBILITY_REQUIRED=false` anywhere real (ignored outside development/test).
- **Privy:** a descriptor only. No SDK, no verification that an address came from Privy.
- **Sandbox wallet:** browser-held devnet key in `localStorage` (XSS-exposed, lost on storage clear, not for real funds). Not user-owned in the provider-managed sense, and not to be used for any non-custodial claim.
- **MoonPay:** real mode builds a signed widget URL per the documented parameters but was never called against MoonPay. A webhook receiver exists (`/v1/webhooks/moonpay`, signature verified per MoonPay's docs) but has never received a real event; MoonPay's sandbox delivered devnet USDC in two real test purchases, but only 1/100,000 of the quoted amount, so it proves delivery but cannot cover an order. IP matching (`allowedIpAddress`) is mandatory for going live and is implemented per MoonPay's documented HMAC.
- **Sanctions screening:** none. The default `ComplianceScreen` allows everything.
- **Prepared message stores:** in-memory (transfers and checkout); lost on restart; not shared across instances.
- **Refunds:** `RefundsModule` is mounted (admin-token only) but no `MERCHANT_SIGNER` implementation ships, so refund submit returns 503 by design. There is no treasury key management. Checkout failures that may have moved funds are flagged `manualReview` in audit events and need an operator.
- **Delegated payments:** schema model and table only (`DelegatedPermission`).
- **Fulfillment:** no-op behind `ENABLE_LIVE_FULFILLMENT` (default false).
- **Admin:** read-only wallet reports exist (`apps/admin/app/wallets/**`, `apps/api/src/wallet-admin/`). The balances report shows no data because nothing writes `BalanceSnapshot`. `apps/admin/app/page.tsx` is still static sample data.
- **Treasury address:** `SOLANA_USDC_TREASURY` is empty by default; checkout prepare returns 503 and the legacy intent creation fails until it is set.
- **Identity:** header `x-customer-email`, non-production only; production returns 401.

## Known gaps (stated plainly)

1. No Postgres-backed integration or concurrency tests have been run (`docs/testing/wallet-qa.md` says the same; the repo contains no DB-backed suite). Raw SQL in the admin settlements report is also untested against Postgres.
2. 3 pre-existing authentication/eligibility readiness tests fail (see Gate 0). Customer eligibility is not enforced before wallet checkout.
3. The wallet and checkout controllers trust a header identity outside production, and the storefront session is a browser-local preview.
4. Storefront add-credits and send flows disagree with the API on field names (`usdAmountCents` vs `amountUsdCents`; `id`/`unsignedTransactionBase64`/`signature` vs `transactionId`/`unsignedTransaction`/`txSignature`; `signedTransactionBase64` vs `signedTransaction`). Found by reading both sides; no test covers it; to be confirmed in a browser. Checkout, balance, and wallet-link calls match.
5. The reconciliation scheduler has no test, and no committed test boots `AppModule`. Reconciliation is not drift detection and raises no alerts; treasury inbound transfers that did not come through prepare/submit are not detected.
6. Only the wallet controller has an HTTP-level test (`apps/api/src/wallet/__tests__/controller.test.ts`, in-memory double). The checkout and admin controllers are tested by direct calls and route metadata, and the admin guard by a unit test; none of them is exercised over HTTP.
7. `docs/testing/wallet-qa.md` is out of date in places (for example its "Known open findings" list and the statement that no HTTP-level test exists). It is outside `docs/wallet/` and was not changed here.

## Rollback

- Each flag can be switched off without a data migration. Switching off must stop new prepares and new settlement, not delete records. (Only mainnet checkout prepare is gated by `ENABLE_LIVE_CRYPTO_PAYMENTS`; devnet/sandbox checkout and external transfers are not behind any flag.)
- In-flight `PREPARED`/`SUBMITTED` transactions must still be reconciled after a rollback. Set `WALLET_RECONCILE_INTERVAL_MS` deliberately: `0` stops all checkout settlement.
- Keep the treasury key controls (KMS/HSM policy) able to disable signing independently of the application (to be built with the refund path).
