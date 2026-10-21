# Wallet and Research Credits architecture

Status: **implemented for sandbox and devnet-shaped use; not production-ready.** This document describes what the code in the repo does today (verified by reading the code and running `pnpm test` on 2026-10-20) and keeps the design for what is not built (refunds, delegated payments). Items marked "to be confirmed" depend on a third party or on a run that has not happened.

Nothing in this domain has been exercised against a real Solana cluster, a real MoonPay account, a real Privy app, or a real Postgres. See "Sandbox vs real" and "Known gaps" below.

## Terms

- **USDC base units**: integers with 6 decimals. All token math uses `bigint`; never floats (`apps/api/src/wallet/contracts.ts`, `USDC_DECIMALS`, `USDC_BASE_UNITS_PER_USDC`).
- **Research Credits (RC)**: a derived display unit, 1 RC = 1 whole USDC of spendable value. RC is not an issued or stored balance. The schema comment in `apps/api/prisma/schema.prisma` states this.
- **Customer wallet**: a Solana address owned by the customer. The platform stores the public address only (`CustomerWallet.address`).

## Components and repo paths

| Component | Responsibility | Path | State today |
|---|---|---|---|
| Wallet module | Wallet link, credits, on-ramp, external transfers, chain adapters, flags | `apps/api/src/wallet/` (`wallet.module.ts` is `WalletModule`; `wallet.controller.ts` serves `/v1/wallet/*`) | Implemented. Unit and HTTP-level tests use an in-memory Prisma double. |
| Credits | Derived balance, transaction list | `apps/api/src/wallet/credits.service.ts` (`CreditsService`) | Implemented. See "Credits derivation". |
| Chain adapters | `SolanaChain` port | `apps/api/src/wallet/chain/sandbox-solana-chain.ts` (`SandboxSolanaChain`, in-memory), `chain/devnet-solana-chain.ts` (`DevnetSolanaChain`, RPC), picked by `chain/chain.factory.ts` from `WALLET_CHAIN_MODE` | Sandbox is the default. Devnet adapter has never touched a real cluster. |
| On-ramp | MoonPay widget URL / sandbox quote | `apps/api/src/wallet/onramp/moonpay-onramp.provider.ts`, `onramp/onramp.service.ts` | Implemented; real mode never called against MoonPay; no webhook handler. |
| External transfers | Prepare unsigned USDC transfer, relay customer-signed one | `apps/api/src/wallet/transfers/` (`TransfersService`, `compliance-screen.ts`, `prepared-transaction.store.ts`) | Implemented. Compliance screen allows everything; prepared store is in-memory. |
| Checkout ("Pay with Research Credits") | Order-bound prepare, submit, status | `apps/api/src/wallet/checkout/` (`CheckoutService`, controller at `/v1/wallet/checkout/:orderId/*`) | Implemented. |
| Verification | Re-read transfer from chain, settle order once | `apps/api/src/wallet/checkout/verification.service.ts` (`VerificationService`) | Implemented. Devnet mint only; see "Settlement". |
| Reconciliation | Settle or expire in-flight purchase rows | `apps/api/src/wallet/checkout/reconciliation.service.ts` (`ReconciliationService`), timer in `apps/api/src/wallet/wallet.wiring.ts` (`ReconciliationScheduler`) | Implemented as a state-advancer for rows the platform created. It is not a drift detector. |
| Port wiring | Satisfies the checkout ports from the wallet module | `apps/api/src/wallet/wallet.wiring.ts` (`checkoutPortProviders`), registered in `apps/api/src/app.module.ts` | Implemented. A one-off Nest DI check resolved the graph; no committed test boots `AppModule`. |
| Admin API (read-only) | Wallet reporting | `apps/api/src/wallet-admin/` (`GET /v1/admin/wallets/*`, `x-admin-token` guard) | Implemented. See "Admin". |
| Admin UI | Ten read-only report pages | `apps/admin/app/wallets/**`, `apps/admin/components/wallets/` | Implemented. Gated by the same development-only session as `apps/admin/app/page.tsx` (still static sample data). |
| Storefront wallet UI | Address, RC, add credits, send, security panel, pay-at-checkout | `apps/storefront/app/account/wallet/` (dashboard, `add`, `send`), `apps/storefront/components/wallet/`, `apps/storefront/lib/wallet/`; checkout button in `apps/storefront/components/checkout-form.tsx` | Implemented for the sandbox browser wallet only. Known request/response mismatches with the API; see "Known gaps". |
| Persistence | `CustomerWallet`, `BalanceSnapshot`, `OnRampIntent`, `CryptoTransaction`, `CreditReservation`, `DelegatedPermission`, `WalletAuditEvent` | `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/20261020120000_wallet_credits` | Migration exists and its SQL matches `schema.prisma` (checked offline with `prisma migrate diff`). It has not been applied to a Postgres by any test. `BalanceSnapshot` and `DelegatedPermission` are never written by any code. `CryptoTransaction.orderId` has no foreign key. |
| Legacy payment intent | `Payment` row plus BullMQ job | `apps/api/src/payments/` | Unchanged and still disabled: `SolanaUsdcProcessor.process` and `PaymentsService.recordConfirmedPayment` always throw. Not used by wallet checkout. |
| Fulfillment | Pick and pack | `apps/api/src/fulfillment/mock-pick-pack-workflow.adapter.ts`; wallet port is `FULFILLMENT_PORT` in `wallet.wiring.ts` | The wired port is a no-op that logs a warning. It is only called when `ENABLE_LIVE_FULFILLMENT=true` (default false). The mock workflow is not connected to it. |
| Shared chain code | Devnet mint constant | `packages/solana-sdk/src/index.ts`, `packages/payment-sdk/src/index.ts` | Devnet only. |

Feature flags (`loadFeatureFlags` in `contracts.ts`): `ENABLE_REAL_MOONPAY`, `ENABLE_SOLANA_MAINNET`, `ENABLE_LIVE_CRYPTO_PAYMENTS`, `ENABLE_DELEGATED_PAYMENTS`, `ENABLE_LIVE_FULFILLMENT`. A flag is on only when its value is exactly `true`. All five are in `.env.example` as `false` (asserted by `tests/wallet/custody-invariants.test.ts`). Where they are read:

| Flag | Read by |
|---|---|
| `ENABLE_REAL_MOONPAY` | `MoonPayOnRampProvider.createQuote` (real URL vs sandbox quote) |
| `ENABLE_SOLANA_MAINNET` | `DevnetSolanaChain` constructor, `CheckoutService.prepare`, MoonPay live-key check |
| `ENABLE_LIVE_CRYPTO_PAYMENTS` | `CheckoutService.prepare`, mainnet only. Devnet and sandbox do not need it. `TransfersService` does not read it. |
| `ENABLE_LIVE_FULFILLMENT` | `VerificationService.settle` |
| `ENABLE_DELEGATED_PAYMENTS` | Nothing except the admin provider-status report. No delegation code exists. |

Other configuration (`apps/api/src/wallet/wallet.config.ts`, `checkout/ports.ts`): `WALLET_CHAIN_MODE` (`sandbox` default, or `devnet`), `SOLANA_NETWORK`, `SOLANA_RPC_URL`, `SOLANA_USDC_MINT`, `SOLANA_USDC_TREASURY`, `SOLANA_USDC_MAINNET_MINT` (checkout only, not in `.env.example`), `PRIVY_APP_ID`, `MOONPAY_PUBLISHABLE_KEY`, `MOONPAY_SECRET_KEY`, `WALLET_RECONCILE_INTERVAL_MS` (not in `.env.example`), `ADMIN_API_TOKEN` (not in `.env.example`).

## Identity

Wallet, checkout, and transfer controllers identify the customer by the `x-customer-email` header, honored only when `NODE_ENV !== 'production'` (`apps/api/src/wallet/customer-identity.ts`, `apps/api/src/wallet/checkout/checkout.controller.ts`). In production every request gets 401 until real authentication exists. Outside production the header is unauthenticated: whoever sends an email acts as that customer. The storefront supplies it from a browser-local preview session (`apps/storefront/components/auth-provider.tsx`, localStorage), which is also unauthenticated. `tests/wallet/custody-invariants.test.ts` statically checks that identity headers are paired with a production rejection; there is no real auth to test.

The three failing readiness tests for real sessions, MFA/email verification, and persisted eligibility are listed under "Known gaps". Customer eligibility is **not** checked before wallet checkout: nothing under `apps/api/src/wallet/` references eligibility, and `apps/api/src/compliance/eligibility.service.ts` only throws 503.

## Data flows

### 1. Account creation and wallet association
1. There is no real account system behind the wallet yet (see Identity). `WalletService.resolveCustomer` finds or creates a `Customer` by email.
2. The storefront creates a devnet keypair in the browser (`apps/storefront/lib/wallet/sandbox-signer.ts`, localStorage) and sends only the **public address** and `provider: "sandbox"` to `POST /v1/wallet`. No Privy SDK or embedded wallet exists in this repo.
3. `WalletService.associateWallet` (`apps/api/src/wallet/wallet.service.ts`): rejects any body field that looks like secret material (`secret-fields.ts`, also `NoSecretMaterialGuard` in `wallet.http.ts`) with 400 and an audit event; requires a valid on-curve ed25519 address; refuses the treasury address; allows one wallet per customer (idempotent for the same address, 409 otherwise); writes `CustomerWallet` and a `WalletAuditEvent`. Provider `privy` is accepted only when `PRIVY_APP_ID` is set, and even then **nothing verifies the address came from Privy**. The reported address is stored as given.
4. The API never receives, stores, or logs private keys. No schema column holds them (scanned by `tests/wallet/custody-invariants.test.ts`).

### 2. Add credits via MoonPay
1. `POST /v1/wallet/onramp` with `amountUsdCents` calls `OnRampService.createIntent`, which loads the customer's own wallet as the destination (no request field can choose it; the treasury is refused), asks the `OnRampProvider` for a quote, and persists an `OnRampIntent` (`status: CREATED`). The quote is a returned object only; no quote table exists.
2. Sandbox (default, `ENABLE_REAL_MOONPAY` off): `sandbox: true` quote with null fee/amount estimates and a local widget path. `POST /v1/wallet/onramp/:id/mock-complete` credits the in-memory `SandboxSolanaChain` and writes a `DEPOSIT` row. It returns 403 unless `WALLET_CHAIN_MODE=sandbox`, not production, and the chain is the sandbox class.
3. Real (`ENABLE_REAL_MOONPAY=true` plus `MOONPAY_PUBLISHABLE_KEY`/`MOONPAY_SECRET_KEY`): builds a signed widget URL (HMAC-SHA256 over the query string, `usdc_sol`, whole-dollar amounts only). `pk_test_` keys use MoonPay's sandbox host and `pk_live_` keys additionally require `ENABLE_SOLANA_MAINNET`. This path was **never called against MoonPay**; see `providers.md`.
4. **Credits come from the observed finalized on-chain balance, not from a MoonPay status.** `OnRampIntent.status` is never read when computing credits.
5. **No MoonPay webhook handler exists.** Event names and signature scheme are unverified. In real mode an intent therefore stays `CREATED` forever, and `externalReference` is never set. Only the sandbox mock sets `COMPLETED`.

### 3. Credits derivation
Implemented in `CreditsService.getBalance` (`apps/api/src/wallet/credits.service.ts`) with the pure math in `computeSpendable` (`contracts.ts`):

```
spendable = chain-finalized USDC balance
            - pending outgoing   (CryptoTransaction type WITHDRAWAL/PURCHASE, status SUBMITTED/CONFIRMED,
                                  whose transfer is NOT yet finalized+succeeded on chain)
            - ACTIVE, unexpired CreditReservation rows for orders that have NOT yet been submitted
credits   = floor(spendable / 1_000_000)        // whole USDC; negatives clamp to 0
```

Rules the code enforces:
- **No double subtraction.** An order with a SUBMITTED/CONFIRMED purchase row is held by that pending row, so its reservation is excluded from the reservation sum. A pending row whose transfer is already finalized on chain is excluded from the pending sum because the finalized balance already reflects it.
- **Read order matters.** Pending transfer status (`chain.getTransfer` per pending row) is read **before** the finalized balance. A transfer seen as finalized is therefore guaranteed to be in the balance read that follows, so spendable can never be overstated. Reading the balance first could omit a transfer the balance does not yet show.
- **Fail closed.** If the chain cannot be read (`ChainUnavailableError`), `getBalance` returns `stale: true` with spendable 0 and 0 credits; it never serves a cached higher value. `GET /v1/wallet/balance` returns that as HTTP 200 with `stale: true`. Paths that need funds (`requireSpendableAtomic`, used by transfer prepare/submit) return 503 instead; checkout prepare also rejects a stale balance.
- A customer with no wallet gets an empty, non-stale balance.
- `BalanceSnapshot` is for audit only and nothing writes it today.

Covered by `apps/api/src/wallet/__tests__/credits.test.ts` and `tests/wallet/contracts.test.ts`.

### 4. Pay with credits (checkout)
Endpoints: `POST /v1/wallet/checkout/:orderId/prepare`, `POST .../submit`, `GET .../status` (`checkout.controller.ts`).

1. **Prepare** (`CheckoutService.prepare`, serialized per customer in-process): the order must belong to the caller (404 otherwise), be `PENDING_PAYMENT`, have `researchAcknowledgedAt`, and be USD; no FINALIZED/SUBMITTED/CONFIRMED purchase row may exist; network flags must allow the chain (mainnet needs `ENABLE_SOLANA_MAINNET` and `ENABLE_LIVE_CRYPTO_PAYMENTS`); the customer wallet network must match; `SOLANA_USDC_TREASURY` must be a valid address different from the customer wallet (else 503/409); spendable (plus the order's own active hold, so re-prepare is idempotent) must cover the total (else 402); only then is it decided who pays the network fee: if fee sponsorship is on and available (see `custody-model.md`, "Fee sponsorship") the platform is the fee payer and the customer needs no SOL; otherwise the wallet must hold at least the estimated fee in SOL (402). It then creates one `CreditReservation` per order (unique `orderId`, 15 minute TTL) and a `CryptoTransaction` (`PURCHASE`, `PREPARED`, reference `chk_...`) atomically. The response carries an unsigned legacy transaction: one `transferChecked` of the exact amount from the customer's USDC account to the treasury's token account (which must already exist; checkout does not create it), the customer as fee payer (or, when sponsored, the platform's fee-payer key as account index 0 appearing in no instruction, with the customer still the token authority and second required signer; the response carries `feePayer` and `feeSponsored`), and a Solana-Pay-style reference key (sha256 of the reference) appended read-only. A prepared message is reused for 20 s, then rebuilt with a fresh blockhash.
2. **Customer signs** in their own wallet context (sandbox: in the browser). The browser first decodes the transaction and refuses to sign unless it matches the amount, mint, and destination shown (`apps/storefront/lib/wallet/tx.ts`). The platform does not sign.
3. **Submit** (`CheckoutService.submit`) requires the customer's valid signature over exactly the prepared message: the message bytes must equal the stored prepared message byte for byte and the customer's signature must be valid. Customer-paid: the fee payer must be the customer wallet and there must be exactly one signature. Sponsored (decided at prepare and read from the stored message, never from the request): the signers must be exactly `[fee payer, customer]`, any request-supplied fee-payer signature is discarded, and the platform adds its own fee-payer signature through the `FEE_PAYER_SIGNER` port only after these checks and after the row claim, verifying it against the message before broadcast (a failure releases the claim and returns 503; the recorded transaction id is the fee payer's signature, the first signature of the transaction). Only then does the row move `PREPARED` to `SUBMITTED` (compare-and-set, unique `txSignature`) and the transaction is broadcast. A broadcast failure returns the row to `PREPARED`. A sponsored claim that never obtained a signature (crash between claim and signing) is expired by reconciliation after the reservation TTL. An identical payload resubmitted is idempotent; a different payload is 409. If the prepared message is missing (restart, another instance) submit returns 409 and the customer must prepare again.
4. **Settlement is not triggered by submit or status.** The only caller of `VerificationService.verifyAndSettle` outside tests is `ReconciliationService.reconcile()`, run by `ReconciliationScheduler`.
   - Interval: `WALLET_RECONCILE_INTERVAL_MS`, default 60000. `0` (or any non-positive or non-numeric value) disables it. It is a single-process `setInterval` with an overlap guard; with more than one API instance, every instance runs it, and the code comment says to move it to a BullMQ repeatable job. No test covers the scheduler itself.
   - It only considers `SUBMITTED`/`CONFIRMED` purchase rows older than 60 s (by row creation, which is prepare time). With the scheduler disabled, nothing settles an order.
5. **Verify** (`VerificationService.verifyAndSettle`) re-reads the transfer with `chain.getTransfer` and requires all of: transaction succeeded and **finalized** (`confirmed` only moves the row to `CONFIRMED` and waits); network matches the row and the chain; signature matches; mint equals the row mint **and the devnet USDC mint** (see below); `sourceOwner` equals the customer wallet recorded at prepare; `destinationOwner` equals the recorded treasury; the row amount still equals the current order total; the transferred amount equals it exactly (under and over both fail); and the transfer's reference keys include the row's reference key.
6. **Mark paid**: one database transaction sets the row `FINALIZED`, the order `PAID` (only from `PENDING_PAYMENT`), the reservation `CONSUMED`, and writes a `checkout.settled` audit event. **No `Payment` or `LedgerEntry` rows are written.** `VerificationService.listSettlements` derives settlement records from FINALIZED purchase rows. If the order is no longer `PENDING_PAYMENT`, the transaction rolls back and the row is `FAILED` with `manual refund required` in the reason and audit detail.
7. **Fulfillment** is gated by `ENABLE_LIVE_FULFILLMENT` (default false). Off: the audit event records `HELD_BY_FLAG`. On: the wired `FULFILLMENT_PORT` is a placeholder that logs a warning and does nothing. A failing trigger never undoes the payment.

Mainnet is not usable as coded: `VerificationService.expectedMint` returns a value only for `solana-devnet`, so any mainnet purchase would fail verification as `wrong mint`; checkout reads `SOLANA_USDC_MAINNET_MINT` while the chain adapter reads `SOLANA_USDC_MINT`; and the storefront refuses non-devnet. This fails closed.

### 5. External transfer (withdrawal)
`POST /v1/wallet/transfers/prepare` and `POST /v1/wallet/transfers/:id/submit` (`TransfersService`), `CryptoTransaction.type = WITHDRAWAL`.
- Prepare validates the destination (valid address, not the customer's own wallet, not the mint), takes an exact `amountAtomic` or `max: true` (full spendable), checks spendable (503 on outage), runs `ComplianceScreen`, builds an unsigned legacy transfer (customer is fee payer; an idempotent create-token-account instruction is included unless the recipient account is known to exist), stores the compiled message in `PreparedTransactionStore` (5 minute TTL), and returns fee and SOL-rent warnings. Prepare does not reserve funds; submit re-checks spendable.
- Submit requires the customer's valid signature over exactly the prepared message (same checks as checkout: fee payer, message equality, single signature by the customer wallet, valid signature) and then claims the row and broadcasts. A chain rejection marks the row `FAILED`; an outage keeps it `SUBMITTED` (counts as pending outgoing).
- These rows are advanced to FINALIZED/FAILED/EXPIRED lazily by `TransfersService.reconcile`, called from `GET /v1/wallet/balance` and `GET /v1/wallet/transactions`. The scheduler does not touch them. A submission not found on chain after 15 minutes becomes `EXPIRED`.
- **Default `ComplianceScreen` (`AllowAllComplianceScreen`) allows everything: no sanctions screening exists.** No withdrawal limits exist beyond spendable. Bind `COMPLIANCE_SCREEN` to a real provider before enabling external sends anywhere real.

### 6. Refunds
`RefundsModule` (`apps/api/src/wallet/refunds`, admin-token only: `POST /v1/admin/refunds/request`, `/:id/submit`, `/:id/verify`, `GET /v1/admin/refunds`) is mounted, but **no `MERCHANT_SIGNER` implementation ships**, so submit fails closed with 503. Until a KMS/HSM-backed signer is bound, refunds remain an off-platform manual process, and checkout failure paths that may have moved funds (mismatched or over/under payment, order no longer payable) record `FAILED` with a reason and a `manualReview` audit flag for an operator to act on.

A refund would be a **new, merchant-signed USDC transfer from the merchant treasury**. It never debits a customer wallet (the platform has no authority to). Required design, **not built**:

- The treasury private key lives in a KMS or HSM. It is never in the app environment, repo, database, logs, or a developer machine. (Today the platform holds only the treasury **address**.)
- A separate signing service with a narrow interface: it signs only transfers of the configured mint, from the treasury, to a destination derived server-side from an approved refund record.
- The destination defaults to the `sourceOwner` of the original verified purchase. Any other destination needs a separate approval.
- Policy checks: amount <= paid amount minus prior refunds; one refund record per approval (idempotency key); order state allows refund.
- Maker-checker approval (requester and approver are different people), with MFA on the approver identity.
- Signing-service credentials are scoped, short-lived, and audited. Every sign request is logged immutably.
- Rate and amount limits; alerts on any signature outside the service.
- Ed25519 support in the chosen KMS/HSM: to be confirmed with provider. Solana uses Ed25519 and not every KMS offers it.
- Treasury is split: a small operating balance for refunds and a larger balance held under stricter controls.
- Key rotation, backup, and recovery procedure, tested before go-live.

Note that adding this signing service changes the "platform has no signing code path" property that `tests/wallet/custody-invariants.test.ts` enforces for `apps/api/src`; the test and `custody-model.md` must be revisited deliberately, not bypassed.

## Admin (read-only)

`apps/api/src/wallet-admin/wallet-admin.controller.ts`: `GET`-only endpoints under `/v1/admin/wallets/` (`directory`, `balances`, `funding`, `payment-intents`, `transactions`, `failed`, `pending-orders`, `settlements`, `reconciliation`, `providers`). A test asserts there is no `@Post/@Put/@Patch/@Delete/@All`. Access requires the `x-admin-token` header to equal `ADMIN_API_TOKEN` (`admin-token.guard.ts`: SHA-256 digests compared with `timingSafeEqual`; env read per request). **It fails closed**: if `ADMIN_API_TOKEN` is unset or empty, every request is 401. It is a single shared static token: no per-admin identity, MFA, rate limiting, or audit of admin reads, and responses include customer emails and addresses.

`apps/admin/app/wallets/**` calls these endpoints server-side (`apps/admin/components/wallets/api.ts`, `API_URL`, default `http://localhost:3001/v1`) so the token never reaches the browser. The pages are gated only by the development-only admin session cookie (`NODE_ENV=development` and `ADMIN_DEV_SESSION=enabled`); production admin authentication does not exist. Limitations found in review: the **balances page will show "No snapshot" for every wallet** because nothing writes `BalanceSnapshot`; the providers report hard-codes Privy as "not configured" and derives the network from the mainnet flag only; the settlements report uses raw SQL that no test runs against Postgres. There is no admin view of `WalletAuditEvent`.

## Sandbox vs real

| Piece | What it is today |
|---|---|
| `SandboxSolanaChain` | In-memory mock, lost on restart. Really parses and verifies signatures, but balances move only through test/dev helpers. Refuses `NODE_ENV=production`. In a running sandbox API only the on-ramp mock credits funds; nothing calls `finalize()` (tests do), so submitted withdrawals and purchases stay `SUBMITTED`, and checkout broadcast is rejected unless the treasury token account is registered in the sandbox (the end-to-end test does this with `creditUsdc(treasury, 0n)`). This is from code reading; not run against a live sandbox server. |
| `DevnetSolanaChain` | RPC adapter, finalized reads. Tests only cover constructor mainnet guards and RPC-failure wrapping with a fake `Connection`. Success paths (`getTransfer` parsing, `broadcast`, balance reads) are not exercised, and it has **never been run against a real cluster**. Its reference-key detection is best-effort. |
| Privy | A descriptor only (`apps/api/src/wallet/wallet-providers.ts`). No SDK, no embedded wallet, no check that an address came from Privy. |
| Sandbox wallet | A browser-held devnet key in `localStorage` (`SandboxBrowserSigner`). Exposed to any script on the origin (XSS), lost when storage is cleared, not for real funds. |
| MoonPay real mode | Builds a signed widget URL per the parameters in the code comment (checked against dev.moonpay.com on 2026-10-20 by the author; not re-verified here). Never called against MoonPay. |
| MoonPay webhooks | Do not exist. |
| Compliance screen | Allows everything. |
| Prepared message stores | `InMemoryPreparedTransactionStore` (transfers, token `PREPARED_TX_STORE` in `wallet.module.ts`) and `InMemoryPreparedMessageStore` (checkout, token `PREPARED_MESSAGE_STORE` in `checkout.module.ts`). Lost on restart and not shared between instances; submit fails closed and the customer re-prepares. A persistent shared store is required for more than one instance. |
| Reservation lock | `KeyedLock` in `checkout.util.ts` is per process. Cross-process safety relies on the unique `CreditReservation.orderId` and compare-and-set updates, which no test has run against Postgres. |
| Fulfillment | No-op behind `ENABLE_LIVE_FULFILLMENT`. |
| Refunds | Module mounted; request/verify work, submit returns 503 until a `MERCHANT_SIGNER` is bound (none ships). |

## Failure modes

| Case | Actual behavior (design intent where noted) |
|---|---|
| RPC outage | Fails closed. Balance read returns `stale: true`, spendable 0. Prepare, submit, and broadcast return 503; checkout prepare leaves no state. Verification leaves all state unchanged and throws 503; the reconcile summary counts it as `unavailable` and the next scheduled tick retries (no backoff). A broadcast outcome that is unknown keeps a withdrawal `SUBMITTED`. |
| Duplicate notifications or retries | Idempotent. `txSignature` and `reference` are unique; state changes are conditional `updateMany` calls, so a repeat settle is a no-op. Not run against Postgres. |
| Wrong token | Row `FAILED` with `wrong mint`, reservation `RELEASED`, `manualReview` audit flag. Funds stay wherever the transfer put them. |
| Wrong source or recipient | Row `FAILED` (`wrong source owner` / `wrong destination owner`), same handling. The order stays `PENDING_PAYMENT`. |
| Underpayment or overpayment | Both set the row `FAILED` (`underpayment` / `overpayment`) with `manualReview`; the order stays `PENDING_PAYMENT`. The funds moved on chain and there is no refund flow, so return is a manual off-platform process. |
| Reservation expires before finality | Reconcile does not expire a reservation while a submitted payment is in flight. A finalized matching transfer still settles and consumes the reservation. A submission never found on chain is expired after the 15 minute reservation TTL. |
| Missing or wrong reference | `FAILED` with `missing reference`. Only transfers tied to a row the platform created are ever examined; **inbound transfers to the treasury that never went through prepare/submit are not detected by anything**. |
| Chain reorg or non-finalized | Only `finalized` settles. `CONFIRMED` is recorded and the row waits. |
| Order changed while paying | If the order total changed since prepare, the row fails (`order total changed since prepare`). If it is no longer `PENDING_PAYMENT`, settlement rolls back and the row fails with `manual refund required`. |
| Reconciliation drift | `ReconciliationService` only advances rows the platform created (settle, fail, expire). It does not compare the `Payment` table or scan chain history and raises no alerts. The admin `reconciliation` report shows counts per `CryptoTxStatus` and the age of the oldest `SUBMITTED` row only. |

## Known gaps

See also `go-live-checklist.md`.

- No Postgres-backed integration or concurrency tests have been run. Every wallet and wallet-admin test uses an in-memory Prisma double (`apps/api/src/wallet/__tests__/helpers.ts`, `checkout/__tests__/harness.ts`, `tests/wallet/sandbox-scenario.test.ts`). `docs/testing/wallet-qa.md` says the same about its own suite; that document was not updated by this review and is partly stale.
- `pnpm test` (`tests/run-all.mjs`) on 2026-10-20: 19 suites, 242 passed, 3 failed. The failures are the pre-existing readiness tests in `tests/authentication-eligibility.test.ts` (run through `tests/commerce-workflows.test.ts`): "account routes require a server-validated session", "production startup requires server-backed email verification, password reset, and MFA", "customer eligibility is persisted separately from research-use acknowledgement". Customer eligibility is not enforced before wallet checkout.
- Storefront and API disagree on field names for add-credits and send (found by reading both sides; no test covers it; to be confirmed in a browser): `apps/storefront/lib/wallet/api.ts` sends `usdAmountCents` where `CreateOnRampDto` requires `amountUsdCents`, and reads quote fields at the top level where the API nests them under `quote`; for transfers it reads `id`/`unsignedTransactionBase64`/`signature` where the API returns `transactionId`/`unsignedTransaction`/`txSignature`, and sends `signedTransactionBase64` where `SubmitTransferDto` expects `signedTransaction`. The wallet link, balance, and checkout calls use matching names.
- Production is not possible: header identity returns 401 in production, sandbox chain refuses production, admin auth is development-only, mainnet verification cannot pass.
