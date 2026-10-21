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
- With `ENABLE_REAL_MOONPAY=true` it builds a signed widget URL: `apiKey`, `currencyCode=usdc_sol`, `walletAddress` (the customer's own linked wallet; never the treasury), `baseCurrencyCode=usd`, `baseCurrencyAmount` (whole dollars only; fractional dollars are rejected), `externalCustomerId` (our internal customer id), `externalTransactionId` (our intent id), and optionally `allowedIpAddress` (HMAC of the caller IP). The signature is HMAC-SHA256 over the URL-encoded query string including the leading `?`, base64. Missing keys, a key that is neither `pk_test_` nor `pk_live_`, or a `pk_live_` key without `ENABLE_SOLANA_MAINNET` fail closed with 503.
- The code comment states these parameters were checked against dev.moonpay.com on 2026-10-20 by whoever wrote it. This review did not re-check them. A unit test (`apps/api/src/wallet/__tests__/wallet.test.ts`) matches a documented signing test vector.
- **It was never called against MoonPay**: no widget load, KYC, card payment, or MoonPay sandbox call has happened.

Verify against MoonPay's current docs before `ENABLE_REAL_MOONPAY` is switched on:
- [ ] **URL signing**: confirm which query parameters are signed, the algorithm, encoding, and which parameters are required, against a real MoonPay sandbox widget load. Implemented as above; not proven against the service.
- [ ] **Currency code** `usdc_sol` for USDC on Solana, for sandbox and live environments. Confirm that MoonPay's sandbox delivers Solana **devnet** USDC (to be confirmed with provider); if it does not, a `pk_test_` purchase will not credit the devnet balance this platform reads.
- [ ] **Sandbox vs live** base URLs (`https://buy-sandbox.moonpay.com`, `https://buy.moonpay.com`) and keys.
- [ ] **Webhooks**: **not implemented; no handler exists.** Event names, payload fields, signature header, and retry behavior must be taken from MoonPay's documentation. Do not guess event names. Until implemented, credits are derived from the chain balance, and in real mode `OnRampIntent.status` stays `CREATED` and `externalReference` stays null (informational only; the admin funding page will show `CREATED`).
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

A Solana transfer needs SOL for network fees (and possibly for creating a recipient token account; to be confirmed against Solana documentation). A customer with USDC but no SOL cannot send. The chain port exposes `getSolBalanceLamports` and `estimateFeeLamports` (the adapters return a constant 5000 lamports base fee; no priority fee and no RPC fee query). Current behavior:
- Checkout prepare returns 402 when the wallet's SOL is below the estimated fee (`CheckoutService.prepare`).
- External-transfer prepare does not block; it returns warnings when SOL is below the fee plus possible token-account rent (`TransfersService.prepare`).
- The customer is always the fee payer; the platform holds no fee-payer key.

| Option | Effect | Concerns |
|---|---|---|
| Customer-funded SOL | Customer buys SOL (for example via the on-ramp, if it supports it; to be confirmed with provider). | Adds friction. The platform stays out of signing. **This is what the code does.** |
| Fee sponsorship | Platform or provider pays fees as fee payer. | A fee payer is a **platform signing key** on the transaction. That changes the "no platform signing" property in `contracts.ts` (and would fail `tests/wallet/custody-invariants.test.ts`), adds a funded hot key to protect, creates abuse and drain risk (needs per-user limits), and needs its own custody and licensing assessment. Whether Privy offers a managed gas-sponsorship feature, and who controls the fee-payer key in that case, is to be confirmed with provider. |

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
| `WALLET_RECONCILE_INTERVAL_MS` | API (`wallet.wiring.ts`), default 60000, `0` disables | **Not** in `.env.example` |
| `ADMIN_API_TOKEN` | API guard and admin server (`apps/admin/components/wallets/api.ts`) | **Not** in `.env.example`; all admin wallet requests are 401 until set |
| `API_URL` (admin), `NEXT_PUBLIC_API_URL` (storefront), `ADMIN_DEV_SESSION` | Admin and storefront | **Not** in `.env.example`; defaults to `http://localhost:3001/v1` |
