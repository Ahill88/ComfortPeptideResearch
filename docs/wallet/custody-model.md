# Custody model

This document describes technical capability. It is not legal advice and reaches no legal conclusion. Whether any arrangement is "custodial", "money transmission", or otherwise regulated is a question for counsel (see the last section).

## What the platform can and cannot do

Table below is the target design with a provider-managed, user-owned wallet (Privy). **Only the sandbox browser wallet exists today** (see "What does NOT qualify"); no Privy integration is built.

| The platform can | The platform cannot |
|---|---|
| Store the customer's public address (`CustomerWallet.address`) | Hold, receive, or persist private keys or seed material |
| Read the customer's on-chain USDC balance (`CreditsService`, `SolanaChain`) | Move customer funds without a customer signature |
| Prepare an unsigned transfer and relay a signed one (`TransfersService`, `CheckoutService`) | Debit a customer wallet for a refund, fee, or chargeback |
| Reserve spendable value against an order in its own database (`CreditReservation`) | Make a reservation an on-chain lock (it is a database record only) |
| Verify a finalized transfer and mark an order paid (`VerificationService`) | Recover a customer's wallet. Recovery is the provider's flow (to be confirmed with provider) |
| Send refunds from the merchant treasury (design only, **not implemented**) | Reverse an on-chain transfer |

## How "no platform signing" is enforced

Invariants stated in the header of `apps/api/src/wallet/contracts.ts`: the platform never holds keys; funds move only when signed by the customer's key; no floats; RC is derived and never issued.

**Runtime.** Checkout submit (`apps/api/src/wallet/checkout/checkout.service.ts`) and transfer submit (`apps/api/src/wallet/transfers/transfers.service.ts`) broadcast only a transaction that carries the customer's valid signature over exactly the prepared message: message bytes equal the stored prepared message byte for byte, the fee payer is the customer's wallet, there is exactly one signature, it is by that wallet, and `verifySignatures()` passes. Unsigned, stranger-signed, wrongly-signed, and altered-after-signing transactions are rejected (`apps/api/src/wallet/checkout/__tests__/submit.test.ts`, `apps/api/src/wallet/__tests__/transfers.test.ts`, `tests/wallet/sandbox-scenario.test.ts`). The customer is always the fee payer. The platform has no signing code path: no function in `apps/api/src` creates a signature.

**Static tests.** `tests/wallet/custody-invariants.test.ts` scans non-test files under `apps/api/src` and fails on key generation or loading (`Keypair.fromSecretKey/fromSeed/generate`), secret/private-key/mnemonic identifiers, `partialSign`/`signTransaction`/`signMessage`, `.sign(` (except on `jwt`/`hmac`-style receivers), and `nacl.sign` signing. Verification (`nacl.sign.detached.verify`) is allowed. Allowed exceptions, and only these:
- `MOONPAY_SECRET_KEY` may be named **only** in the env loader `apps/api/src/wallet/wallet.config.ts` (which must not use it) and in the MoonPay provider `apps/api/src/wallet/onramp/moonpay-onramp.provider.ts` (which uses it for `createHmac('sha256', ...)` to sign the widget URL and must not log, throw, serialize, or return it). No storefront, admin, or package code may reference it.
- `apps/api/src/wallet/secret-fields.ts` (a request-field denylist that contains words like `secret` and `mnemonic` in order to reject them) is allowed **only while it has no imports**. Adding any import to it makes the scan fail.

The same suite scans the Prisma schema for key-like columns and `Bytes` columns in wallet models, the storefront wallet code for fetch calls that serialize key material, committed files for embedded key material, and source for mainnet URLs. These scans are text heuristics over comment-stripped source: they catch regressions and careless mistakes, not a determined author (obfuscation, aliasing, and renamed variables evade them). `tests/wallet/scanner-selfcheck.test.ts` proves the scanners can fail. Limits are listed in `docs/testing/wallet-qa.md`.

**The only platform-held secret in the wallet domain is the MoonPay URL-signing secret.** It signs URLs, not blockchain transactions. The platform holds no treasury key; `SOLANA_USDC_TREASURY` is an address. The platform has no fee-payer key.

## When a non-custodial claim is valid

A non-custodial statement is only supportable when all of these hold:

1. The wallet is created and managed by a provider whose design gives the user, not the platform, sole control of signing authority. Privy is the intended candidate. How Privy splits or secures keys, and whether the app operator can ever trigger signing, must be taken from Privy's current documentation and security materials (to be confirmed with provider).
2. The platform holds no credential that can sign for the user: no provider API secret configured with signing rights, no delegated or session signer, no copied key shares.
3. Any recovery or export mechanism does not give the platform unilateral access.
4. Counsel has agreed that the facts support the wording used in customer-facing text.

Even when 1-3 hold, wording such as "non-custodial" should be used in the UI only after step 4. **Step 4 has not happened.** The storefront security panel (`apps/storefront/components/wallet/wallet-security.tsx`) currently says "You hold the key." and "User-owned", labeled with a SANDBOX badge and a devnet/not-for-real-funds disclosure. `tests/wallet/storefront-honesty.test.ts` checks Privy claims, paid/confirmed wording, and sandbox labelling only; it does not check custody wording. Review that copy with counsel before any customer sees it outside a sandbox.

## What does NOT qualify

- **The sandbox wallet.** `SandboxBrowserSigner` (`apps/storefront/lib/wallet/sandbox-signer.ts`) generates a devnet key in the browser and stores it in `localStorage` (key `helix-field-SANDBOX-devnet-wallet:v1:<email>`). It is not provider-managed, has no recovery (an export file is offered), and its key is exposed to any script on the origin (XSS) and to anyone with the browser profile. It is not for real funds, must not be described as non-custodial or as equivalent to Privy, and must not be enabled with mainnet. Server side it is `provider: "sandbox"` with `realFundsSuitable: false` and its own disclosure (`apps/api/src/wallet/wallet-providers.ts`). Note that `WalletProviderInfo.custody` in `contracts.ts` is typed `'USER_OWNED'` for both `'privy'` and `'sandbox'`. Customer-facing copy must be driven by provider name and disclosure text, not by that field alone. Consider widening the type.
- **Privy as it exists today.** It is a descriptor only (`wallet-providers.ts`); there is no Privy SDK, no embedded wallet creation, and the storefront offers only the sandbox provider. If `PRIVY_APP_ID` is set, `POST /v1/wallet` accepts `provider: "privy"` with any valid address and **nothing verifies that the address was issued by Privy**. Its disclosure and `recoverySupported`/`exportSupported: false` say so. Do not set `PRIVY_APP_ID` in a deployment and treat the result as a Privy wallet.
- **Any service-controlled wallet.** A wallet whose key the platform or a vendor acting for the platform can use without a per-action customer signature is not to be described as non-custodial, whatever the vendor calls it.
- **A fee-payer key or delegated signing** changes the "no platform signing" property (see `providers.md` and `delegated-payments.md`). Each needs its own assessment. Neither exists today.
- **The merchant treasury key.** It is a platform-controlled key by design once refunds exist. It must only be used for refunds (see `architecture.md`) and never to move customer-wallet funds. Refunds are not implemented and no treasury key is held by the platform today.

## Other facts relevant to the custody and compliance analysis

- **No sanctions screening.** The default `ComplianceScreen` (`apps/api/src/wallet/transfers/compliance-screen.ts`) allows every transfer. External sends relay customer-signed transfers to arbitrary addresses with no limits beyond spendable.
- **No real authentication.** Identity is the `x-customer-email` header, honored only when `NODE_ENV !== 'production'`; production returns 401 until real auth exists. Customer eligibility is not enforced before wallet checkout. See `architecture.md`.
- **Wallet ownership is not proven.** The API records whatever valid public address the client reports; there is no signed-message proof of control and no provider verification.
- **MoonPay.** The platform builds a widget URL whose destination is always the customer's own linked wallet (never the treasury; checked in code and by tests). MoonPay performs KYC and payment. No webhook handler exists.

## Open questions for counsel (to be answered before production)

1. **Money transmission and payment-services licensing.** Does the planned flow (customer buys with their own USDC; platform receives USDC for goods; platform may send USDC refunds) fall within money-transmission or payment-services licensing in the US federal and state regimes, and in any other jurisdiction we serve? Does the answer change if a refund goes to a different address than the source, or if we send credits-funded transfers (external transfer feature)?
2. **Does the external-transfer feature change the analysis?** The platform relays customer-signed transfers to arbitrary addresses (implemented in `TransfersService`, with no screening). Does relaying matter, and should the feature be removed or restricted?
3. **MoonPay merchant category and storefront approval.** Is commerce in research chemicals or peptides permitted under MoonPay's acceptable-use and merchant rules? What approval, review, or domain allow-listing is required before a live widget is used on this storefront?
4. **Sanctions screening.** Which provider screens wallet addresses and customers, at which points (wallet association, add credits, pay, withdraw), and what do we do on a hit? (The code has a single hook on withdrawal prepare and a default that allows everything.)
5. **Travel rule.** Does it apply to any transfer we initiate or receive, including refunds and withdrawals, and at what thresholds?
6. **Tax treatment.** Sales tax and income-tax treatment of payments received in USDC, the accounting treatment of the treasury balance, and any reporting duties. (The wallet checkout writes no `Payment` or `LedgerEntry` rows today.)
7. **Consumer disclosures.** What must customers be told about fees, irreversibility, the wallet provider's role, recovery, the sandbox/test status, and refund method? How should "Research Credits" be described so they are not read as stored value or a gift-card-like instrument? Includes the "You hold the key." wording above.
8. **Is "Research Credits" itself a regulated stored-value or prepaid-access concept?** It is derived from a user-owned balance, but the reservation mechanic and naming may be read differently.
9. **Card-network and stablecoin issuer terms.** Do the terms of Circle (USDC) or any card network used by the on-ramp restrict this product category or use?
10. **State and country restrictions.** Which states or countries must be blocked for the wallet, the on-ramp, or the product category? How is the block enforced (shipping address, IP, wallet screening)? Nothing is enforced today.
11. **Research-use compliance.** How does the existing research-use acknowledgement (`docs/compliance/research-use.md`) interact with payment-provider category rules? Checkout requires `researchAcknowledgedAt` on the order; it does not check customer eligibility.
12. **Fee sponsorship and delegation.** Would a platform fee-payer key or a delegated spending permission change the custody characterization or licensing analysis?
13. **Refund liability.** Who bears loss from refunds sent to an address the customer no longer controls (including a sandbox or lost-key wallet), and what is our obligation when a refund cannot be delivered?
