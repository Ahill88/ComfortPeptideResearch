# Provider integration checklists

Everything below about third-party behavior must be verified against the provider's current official documentation before a flag is enabled. Variable names and parameters not found in this repo are working names and are marked "to be confirmed with provider".

## Privy (wallet provider)

Purpose: provider-managed, user-owned wallet (the basis for any non-custodial claim; see `custody-model.md`).

**Current implementation: a descriptor only.** `apps/api/src/wallet/wallet-providers.ts` defines a `privy` descriptor (`realFundsSuitable: false`, `recoverySupported: false`, `exportSupported: false`) whose `active` flag is true when `PRIVY_APP_ID` is non-blank (read in `apps/api/src/wallet/wallet.config.ts`). There is no Privy SDK in the API or storefront, no server-side token verification, and no embedded-wallet creation. The storefront registers only the sandbox provider (`apps/storefront/lib/wallet/provider-selector.ts`). With `PRIVY_APP_ID` set, `POST /v1/wallet` accepts `provider: "privy"` and stores whatever valid address the client sends; **nothing verifies the address belongs to a Privy user.** Without it, linking `privy` returns 400. The admin provider-status report hard-codes Privy as "not configured". `tests/wallet/storefront-honesty.test.ts` checks that the storefront makes no unqualified Privy claim and imports no Privy SDK.

Credentials and configuration (names to be confirmed with provider):
- `PRIVY_APP_ID` (public client identifier). In `.env.example` and read by the API; nothing else uses it.
- `PRIVY_APP_SECRET` or equivalent server credential, used only for server-side token verification. **Not in `.env.example`, not read by any code.**
- Allowed origins/domains and login methods configured in the Privy dashboard

Checklist:
- [ ] Confirm the embedded Solana wallet is supported and how its key is held, split, and recovered (to be confirmed with provider).
- [ ] Confirm whether the app server can sign or initiate signing with the server credential. If yes, disable it or scope it out, and re-assess custody claims.
- [ ] Confirm how the server verifies that a submitted public address belongs to the authenticated Privy user, and implement it in `WalletService.associateWallet` (not built).
- [ ] Confirm export and recovery options and write the customer disclosure text (`WalletProviderInfo.disclosure`, `recoverySupported`, `exportSupported`).
- [ ] Confirm pricing, rate limits, data-residency, and the terms for the product category.
- [ ] Store the server credential in a managed secret store, not `.env` in production (`docs/security/controls.md`).
- [ ] Execute the provider agreement, and complete any account review the provider requires.

## MoonPay (on-ramp)

Credentials (in `.env.example`, read in `apps/api/src/wallet/wallet.config.ts`):
- `MOONPAY_PUBLISHABLE_KEY` (client-facing key; `pk_test_` selects MoonPay's sandbox host, `pk_live_` the live host)
- `MOONPAY_SECRET_KEY` (server only, used to sign widget URLs). Per `tests/wallet/custody-invariants.test.ts` it may be named only in `wallet.config.ts` (read only) and in `apps/api/src/wallet/onramp/moonpay-onramp.provider.ts` (the only place that signs with it).

**Current implementation** (`apps/api/src/wallet/onramp/moonpay-onramp.provider.ts`, `onramp/onramp.service.ts`):
- Off by default. With `ENABLE_REAL_MOONPAY` unset the provider returns a clearly labeled sandbox quote (`provider: 'moonpay-sandbox'`, `sandbox: true`, null fee and amount estimates, local widget path); `POST /v1/wallet/onramp/:id/mock-complete` then credits the in-memory sandbox chain.
- With `ENABLE_REAL_MOONPAY=true` it builds a signed widget URL: `apiKey`, `currencyCode=usdc_sol`, `walletAddress` (the customer's own linked wallet; never the treasury), `baseCurrencyCode=usd`, `baseCurrencyAmount` (whole dollars only; fractional dollars are rejected), `externalCustomerId` (our internal customer id), `externalTransactionId` (our intent id), and optionally `allowedIpAddress` (base64 HMAC-SHA256 of the canonicalized caller IP, keyed with the same `MOONPAY_SECRET_KEY` that signs the URL, exactly as MoonPay's IP-matching page documents; mandatory for going live). The signature is HMAC-SHA256 over the URL-encoded query string including the leading `?`, base64. Missing keys, a key that is neither `pk_test_` nor `pk_live_`, or a `pk_live_` key without `ENABLE_SOLANA_MAINNET` fail closed with 503.
- The code comment states these parameters were checked against dev.moonpay.com on 2026-10-20 by whoever wrote it. This review did not re-check them. A unit test (`apps/api/src/wallet/__tests__/wallet.test.ts`) matches a documented signing test vector.
- **It was never called against MoonPay**: no widget load, KYC, card payment, or MoonPay sandbox call has happened.

Verify against MoonPay's current docs before `ENABLE_REAL_MOONPAY` is switched on:
- [ ] **URL signing**: confirm which query parameters are signed, the algorithm, encoding, and which parameters are required, against a real MoonPay sandbox widget load. Implemented as above; not proven against the service.
- [ ] **Currency code** `usdc_sol` for USDC on Solana, for sandbox and live environments. Confirm that MoonPay's sandbox delivers Solana **devnet** USDC (to be confirmed with provider); if it does not, a `pk_test_` purchase will not credit the devnet balance this platform reads.
- [ ] **Sandbox vs live** base URLs (`https://buy-sandbox.moonpay.com`, `https://buy.moonpay.com`) and keys.
- [x] **Webhooks** (implemented, verified against MoonPay's docs, never received from MoonPay): `POST /v1/webhooks/moonpay` accepts `transaction_created`, `transaction_updated` and `transaction_failed` (everything else is acknowledged and ignored), verifies `Moonpay-Signature-V2` (`t=<unix>,s=<hex HMAC-SHA256 of "<t>.<raw body>">`, keyed with the dashboard's **webhook** API key `MOONPAY_WEBHOOK_KEY`, not the URL-signing key), and fails closed with 503 when the key is unset. Delivery is at-least-once and unordered, so processing is idempotent and ordered by `data.updatedAt`. The webhook only updates `OnRampIntent.status`/`externalReference` and the audit trail: **it never credits, never marks an order paid and never writes a balance** (credits derive only from the finalized on-chain balance). Register one endpoint per key set in the dashboard (test and live keys send to separate settings). Open points: whether MoonPay re-signs retries with a fresh timestamp (stale timestamps are rejected; see `MOONPAY_WEBHOOK_TOLERANCE_SECONDS`), and whether a widget retry creates a second transaction with the same `externalTransactionId` (flagged `transaction-id-differs`).
- [ ] **Fees and limits** shown to the customer come from provider quotes. The `OnRampQuote` fields stay `null` when the provider has not quoted, and the real path never quotes.
- [ ] **Geo and KYC**: provider-side restrictions and who performs KYC.
- [ ] **Approval gates**: merchant/category approval for research-chemical commerce, storefront domain approval, and any required legal review (see `custody-model.md`, questions 3 and 9). A live key must not be used on the storefront before these are complete.

## Solana network and USDC mint

| Network | USDC mint | State |
|---|---|---|
| Devnet | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | In code in four places: `apps/api/src/wallet/contracts.ts` (`USDC_DEVNET_MINT`, also used by checkout and verification), `packages/solana-sdk/src/index.ts`, `apps/api/src/payments/payments.service.ts`, `apps/storefront/lib/wallet/tx.ts` |
| Mainnet | Not configured | Must be confirmed from Circle's official documentation before use. It is deliberately not written in this repo. |

Mainnet status in code: guarded and **not usable**.
- `DevnetSolanaChain` (`apps/api/src/wallet/chain/devnet-solana-chain.ts`, the only RPC adapter regardless of its name) refuses mainnet unless `ENABLE_SOLANA_MAINNET=true`, and then also requires an explicit mint (`SOLANA_USDC_MINT`). It also refuses a mainnet-looking RPC URL while `SOLANA_NETWORK` is devnet.
- Checkout reads a **different** variable, `SOLANA_USDC_MAINNET_MINT` (`apps/api/src/wallet/checkout/ports.ts`; not in `.env.example`), and mainnet checkout also needs `ENABLE_LIVE_CRYPTO_PAYMENTS`.
- `VerificationService.expectedMint` returns a mint only for devnet, so any mainnet purchase would fail verification as `wrong mint`. The storefront also refuses non-devnet networks.
- `tests/wallet/custody-invariants.test.ts` fails if any source contains a mainnet RPC URL literal.

Checklist for `ENABLE_SOLANA_MAINNET`:
- [ ] Confirm the mainnet mint from Circle's official documentation, record the source and date, and add it as explicit configuration (not a code literal copied from a third-party site).
- [ ] Replace the four devnet constants above with one configured source of truth, unify `SOLANA_USDC_MINT` and `SOLANA_USDC_MAINNET_MINT`, and make `VerificationService.expectedMint` use the network's configured mint.
- [ ] Choose and contract a production RPC provider. Public endpoints are not for production. RPC outage must fail closed (it does in code; `DevnetSolanaChain` success paths are untested).
- [ ] Set `SOLANA_USDC_TREASURY` to a mainnet treasury address whose key is held per the KMS/HSM design in `architecture.md`, and make sure its USDC token account exists (checkout does not create it).
- [ ] Run the whole flow on a **real** devnet cluster first. It has never been done; `DevnetSolanaChain` has only been tested against a fake `Connection`.

## SOL fees for customer wallets

A Solana transfer needs SOL for network fees (and possibly for creating a recipient token account; to be confirmed against Solana documentation). A customer who bought USDC through the MoonPay on-ramp holds no SOL. The chain port exposes `getSolBalanceLamports` and `estimateFeeLamports` (the adapters return a constant 5000 lamports base fee per signature; no priority fee and no RPC fee query). Current behavior:
- **Wallet checkout ("Pay with Research Credits"): the platform pays the network fee when fee sponsorship is on and available** (owner-approved product decision). With `FEE_SPONSORSHIP=true`, a bound `FEE_PAYER_SIGNER` and a funded sponsor, prepare returns `feeSponsored: true` and `feePayer` = the sponsor's address, with the fee quoted for two signatures (10,000 lamports) and the disclosure saying Helix & Field pays it. The customer needs no SOL. Otherwise (flag off, no signer, sponsor balance below `FEE_SPONSOR_MIN_LAMPORTS`, customer over `FEE_SPONSOR_MAX_PER_CUSTOMER_DAY`, sponsor key equal to the customer or treasury) checkout behaves as before: `feeSponsored: false`, `feePayer` = the customer's wallet, and prepare returns 402 when the wallet's SOL is below the estimated fee (`CheckoutService.prepare`).
- **External-transfer (withdrawal) prepare is unchanged and customer-paid.** It does not block; it returns warnings when SOL is below the fee plus possible token-account rent (`TransfersService.prepare`). The customer is the fee payer and sole signer; sponsorship never applies.
- The platform's only signature is as fee payer of a sponsored checkout. It relies on a KMS/HSM-held fee-payer key (not in this repository); see `custody-model.md` ("Fee sponsorship") for what that key can and cannot do and the risks, and `go-live-checklist.md` for the checklist.

| Option | Effect | Concerns |
|---|---|---|
| Customer-funded SOL | Customer buys SOL (for example via the on-ramp, if it supports it; to be confirmed with provider). | Adds friction; a customer who only bought USDC cannot check out. This is the **fallback** the code still uses whenever sponsorship is off or unavailable, and what withdrawals always use. |
| Fee sponsorship | Platform pays fees as fee payer. | **Built, off by default (`FEE_SPONSORSHIP`), and requires an operator-bound `FEE_PAYER_SIGNER`.** A fee payer is a **platform signing key** on the transaction, so it changes the "no platform signing" property in `contracts.ts` (the custody scan pins the single allowed call site), adds a funded hot key to protect, creates budget-drain risk (per-customer cap, minimum balance, eligibility gate), and needs its own custody and licensing assessment by counsel. Whether Privy offers a managed gas-sponsorship feature, and who would control the fee-payer key in that case, is to be confirmed with provider. Only a sandbox in-memory signer exists in the repo; no real-cluster sponsored payment has ever been run. |

## Credentials and configuration summary

| Name | Used by | Status |
|---|---|---|
| `PRIVY_APP_ID` | API (`wallet.config.ts`) | In `.env.example`; only flips the Privy descriptor to active. Privy server secret: not in `.env.example`, not read by code; name to be confirmed with provider |
| `MOONPAY_PUBLISHABLE_KEY`, `MOONPAY_SECRET_KEY` | API only (the storefront never receives them) | In `.env.example`, blank |
| `SOLANA_USDC_TREASURY` | API (checkout, wallet, on-ramp checks; legacy payments) | In `.env.example`, empty. Checkout prepare returns 503 until set. |
| `WALLET_LINK_CHALLENGE_KEY` | API (`wallet/link-proof.ts`) | In `.env.example`, blank; >= 32 chars required outside development/test |
| `ELIGIBILITY_REQUIRED` | API (`checkout.service.ts`) | In `.env.example` as `true`; `false` honored only in development/test |
| Five `ENABLE_*` flags | API (`contracts.ts`) | In `.env.example`, all `false` |
| `WALLET_CHAIN_MODE`, `SOLANA_NETWORK`, `SOLANA_RPC_URL`, `SOLANA_USDC_MINT` | API (`wallet.config.ts`) | In `.env.example` (`sandbox`, `solana-devnet`, devnet URL, blank) |
| `SOLANA_USDC_MAINNET_MINT` | API checkout only (`checkout/ports.ts`) | **Not** in `.env.example` |
| `FEE_SPONSORSHIP` | API checkout (`checkout/fee-sponsorship.ts`, read by `loadCheckoutConfig`) | In `.env.example` (`false`). Exact string `true` enables; unset/blank/`false` is off; any other value stops the API from starting. Needs a bound `FEE_PAYER_SIGNER`, otherwise it has no effect and a startup warning is logged. |
| `FEE_SPONSOR_MIN_LAMPORTS` | same | In `.env.example` (`50000000`, 0.05 SOL). Whole lamports 1 to 10^15; sponsor balance below it (or below two signatures' fees) means fallback to customer-pays. Malformed values stop the API from starting. |
| `FEE_SPONSOR_MAX_PER_CUSTOMER_DAY` | same | In `.env.example` (`20`). Whole number 1 to 10000, counted from `CHECKOUT_FEE_SPONSORED` audit events in the last 24 hours (no schema change); at the cap checkout falls back to customer-pays. Malformed values stop the API from starting. |
| `WALLET_RECONCILE_INTERVAL_MS` | API (`wallet.wiring.ts`), default 60000, `0` disables | **Not** in `.env.example` |
| `ADMIN_API_TOKEN` | API guard and admin server (`apps/admin/components/wallets/api.ts`) | **Not** in `.env.example`; all admin wallet requests are 401 until set |
| `API_URL` (admin), `NEXT_PUBLIC_API_URL` (storefront), `ADMIN_DEV_SESSION` | Admin and storefront | **Not** in `.env.example`; defaults to `http://localhost:3001/v1` |

## Checkout top-up (order-linked on-ramp)

`POST /v1/wallet/onramp/order-topup` with `{ "orderId": "..." }` (same `x-customer-email` identity as the other wallet routes) lets checkout offer a MoonPay purchase sized to what a pending order is missing. Implemented in `apps/api/src/wallet/onramp/order-topup.service.ts`; it reuses `OnRampService.createIntent`, so the destination is always the customer's own linked wallet (never the treasury, never a request field).

What it does, in order: the order must belong to the caller (404 otherwise, identical to "not found"), be `PENDING_PAYMENT` (409) and have no payment in flight (409); the customer must have approved eligibility (403, checked before any intent exists); spendable is read with the same computation as `GET /v1/wallet/balance`, plus this order's own active reservation added back exactly as `CheckoutService.prepare` does. If the chain cannot be read the answer is 503 and nothing is created (never "0 spendable"). If spendable covers the order the response is `{ topUpNeeded: false, orderId, requiredAtomic, spendableAtomic }` and no intent is created. Otherwise `shortfallAtomic = requiredAtomic - spendableAtomic`, `topUpUsdCents` is the shortfall (plus the fee buffer below) rounded **up to whole dollars** (the existing MoonPay path only accepts whole dollars), and the response adds `intentId`, `shortfallAtomic`, `topUpUsdCents`, `quote` (the same shape `POST /v1/wallet/onramp` returns) and `status` (`CREATED` or `PENDING`). All base-unit amounts are decimal strings.

Idempotency: an open intent (`CREATED` or `PENDING`) for the same customer and order with the same `topUpUsdCents` and wallet is returned again with a freshly generated quote. If the amount changed, a new intent is created and older open intents for that order are marked `EXPIRED`. `EXPIRED` is local bookkeeping only: it does not cancel anything at MoonPay, and USDC that still arrives from an older purchase just shows up in the next chain balance read.

Nothing here pays an order or credits a balance. Spendable comes only from the chain; after the funds arrive the browser re-checks the balance, and the customer's own key signs the payment through the normal prepare/submit flow. The platform never signs.

| Setting | Default | Meaning |
|---|---|---|
| `ONRAMP_FEE_BUFFER_PERCENT` | `0` | Integer 0-100 added to the shortfall before rounding up. MoonPay's fees reduce the USDC delivered and are **not quoted** by the provider here (`estimatedFeeUsdCents` and `estimatedUsdcAtomic` stay `null`), so the operator sets this from MoonPay's fee schedule. With `0`, a customer can still end slightly short; the checkout then re-checks the balance and offers another top-up. |
| `ONRAMP_MIN_USD` | `1` | Whole-dollar floor on a purchase. This repo does not know MoonPay's real minimum; the operator must set it (to be confirmed with provider). |
| `ONRAMP_MAX_USD` | `10000` | Whole-dollar cap (at most 1,000,000). A needed amount above it, buffer included, is refused with 400. |

Values must be whole numbers in range; anything else (and a max below the min) makes the API refuse to start rather than silently change what customers are asked to pay. Eligibility follows the same `ELIGIBILITY_REQUIRED` rule as checkout.

Verification status: covered by unit tests (in-memory doubles) and by `tests/wallet/e2e.integration.test.ts` against real Postgres and the sandbox chain. Never exercised against the live MoonPay widget or a real devnet/mainnet cluster; whether MoonPay honors a pre-filled amount at or above its own minimum for every region and payment method is to be confirmed with provider.

## Local devnet with platform-paid fees (development only)

`pnpm dev:api` runs the API without a fee-payer signer, so with `WALLET_CHAIN_MODE=devnet` every customer pays the fee in SOL.
To run the real API on Solana devnet with a throwaway devnet key bound as the fee payer (so a customer with 0 SOL can pay):

```
DEV_SPONSOR_KEYPAIR_FILE=/path/to/devnet-sponsor.json NODE_ENV=development \
  pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only ../../tools/dev/api-devnet-sponsored.ts
```

Needs `.env` with `WALLET_CHAIN_MODE=devnet`, `FEE_SPONSORSHIP=true`, a local `DATABASE_URL`, and a devnet-funded sponsor key
(at least `FEE_SPONSOR_MIN_LAMPORTS`, default 0.05 SOL). The launcher (`tools/dev/api-devnet-sponsored.ts`) refuses to start
outside `NODE_ENV=development`, on a non-devnet RPC or a non-local database. It lives outside `apps/api/src` on purpose: the API
never holds key material. Production binds a KMS/HSM signer under the same `FEE_PAYER_SIGNER` token instead.

## MoonPay facts verified from MoonPay's docs (2026-10-21)

Source pages: `dev.moonpay.com/widget/sandbox-testing`, `.../widget/on-ramp/customization/ip-matching`, `.../url-signing`, `.../parameters`, `.../api-reference/widget/webhooks/*`, and the public `GET https://api.moonpay.com/v3/currencies`.

- **The MoonPay sandbox cannot deliver USDC on Solana.** The sandbox supports Solana devnet for **native SOL only ("SPL tokens are not available in sandbox")**, and delivers 1/100th of the quoted amount. A `pk_test_` purchase of `usdc_sol` therefore cannot be proven end to end on devnet. The card flow can only be proven in production (mainnet USDC), after MoonPay's KYB approval. Until then, test the rest of the loop with devnet USDC from Circle's faucet (see "Local devnet" below) or the in-memory sandbox chain.
- **IP matching is mandatory for going live.** `allowedIpAddress = base64(HMAC-SHA256(secretKey, ip))` with the IP canonicalized (dotted-quad without leading zeros; IPv6 per RFC 5952; IPv4-mapped IPv6 unmapped; no port/brackets). MoonPay recommends reading `True-Client-IP`; this API uses `req.ip` (honours `TRUST_PROXY`), so behind a CDN or proxy set `TRUST_PROXY` correctly or the hash will not match and the widget shows "Unverified Connection". An IP that changes between URL generation and opening (VPN, mobile network switch) also blocks the widget; the URL is generated at quote time. Omitting the parameter skips enforcement for that session (documented, for iCloud Private Relay); this API omits it only when no valid IP is available.
- **Currency code:** `usdc_sol` is MoonPay's Solana USDC (contract `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, 6 decimals; the public currency list showed `minBuyAmount` 4.99 and `maxBuyAmount` 30000 on the day it was read). The widget docs' BuyTransaction schema says "the minimum amount is 20", which conflicts; the authoritative per-method limits come from `GET /v3/currencies/usdc_sol/limits?apiKey=...` and need a MoonPay key. Set `ONRAMP_MIN_USD` from that call, not from this note.
- **Sizing: the real purchase is sized in USDC (`quoteCurrencyAmount`), verified against MoonPay's `buy_quote` API (publishable test key, `usdc_sol`, card, 2026-10-21).** With `quoteCurrencyAmount=N` the customer receives exactly N USDC and MoonPay adds fees on top; with a dollar amount (`baseCurrencyAmount`) the customer received about 1.7% *fewer* USDC than the dollars entered, because MoonPay quoted USDC at about $1.017. Observed examples (not a fee schedule; they change): 25 USDC cost $25.42 + $2.99 fee + $0.36 network = $28.77; 50 USDC cost $50.85 + $3.99 + $0.36 = $55.20; 100 USDC cost $101.69 + $4.07 + $0.36 = $106.12. The widget URL therefore carries `quoteCurrencyAmount` (whole USDC), and `ONRAMP_FEE_BUFFER_PERCENT` is no longer needed for the real path (it still shapes the requested amount if set). Not yet confirmed in the widget itself (needs `sk_test_` to load a signed URL).
- **Limits, measured with the test key:** `usdc_sol` minimum purchase is 19.57 USDC (about $21-$24 in fiat depending on payment method) and the maximum about 29,501 USDC. Use `ONRAMP_MIN_USD=20` (the top-up is whole USDC, so 20 is the smallest valid purchase). Not available in Canada or the US Virgin Islands (`notAllowedCountries`/`notAllowedUSStates`).
- **Account requires signed widget URLs:** loading `https://buy-sandbox.moonpay.com/?apiKey=pk_test_...&currencyCode=usdc_sol&quoteCurrencyAmount=25` without a `signature` returned "Signature check failed". A signed URL needs the secret key (`sk_test_...`).
- **Restricted categories (business risk, not code):** no MoonPay page names peptides or research chemicals. MoonPay's customer Terms of Use (Prohibited Use) lists, among others, "purported pharmaceuticals, or weight-loss, anti-aging, or sexual-enhancement supplements dispensed without a valid prescription" and "steroids, certain controlled substances or other products that present a risk to consumer safety". Whether a research-use-only peptide store is accepted is MoonPay's decision during KYB; get an explicit answer before building more on MoonPay.
- **Funding in devnet mode without MoonPay:** when the API runs on real devnet and `ENABLE_REAL_MOONPAY` is off, quotes carry `simulationAvailable: false`; the storefront then shows the wallet address and the Circle/Solana faucet links instead of a simulate button.
