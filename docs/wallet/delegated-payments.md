# Delegated payments (Phase 10) design assessment

Decision: **disabled by default** (`ENABLE_DELEGATED_PAYMENTS=false`, set in `.env.example`). The fallback, and the only implemented direction, is per-checkout user authorization: the customer signs each purchase (`apps/api/src/wallet/checkout/checkout.service.ts`, `submit`). This document is an assessment, not an implementation plan.

Current code state (verified by search of `apps/`):
- **No delegation code exists.** Nothing reads or writes `DelegatedPermission`.
- The `DelegatedPermission` model is in `apps/api/prisma/schema.prisma` and its table is created by `apps/api/prisma/migrations/20261020120000_wallet_credits`, but it is design-only.
- `ENABLE_DELEGATED_PAYMENTS` is parsed by `loadFeatureFlags` (`apps/api/src/wallet/contracts.ts`) and displayed by the admin provider-status report (`apps/api/src/wallet-admin/wallet-admin.service.ts`). No code path branches on it.
- The storefront security panel (`apps/storefront/components/wallet/wallet-security.tsx`) tells customers delegated permissions are not enabled.

## What delegation would mean

The customer pre-authorizes later payments without signing each one, so a one-click checkout or a subscription is possible. Something other than the customer's live signature must then authorize the transfer.

## Required properties

| Property | Requirement | Present in `DelegatedPermission` |
|---|---|---|
| Specific merchant destination | Only the configured merchant treasury address; no wildcard | `merchantAddress` |
| Spending cap | Total and per-transaction limits, in USDC base units | `capAtomic`, `spentAtomic` (no per-transaction field) |
| Expiry | Hard end time, short by default | `expiresAt` |
| Revocation | Customer revokes at any time, effective immediately, from the customer's own wallet UI | `revokedAt` |
| Audit | Record of consent, each use, and revocation, including the consent text shown | `consentedAt`, `WalletAuditEvent` |
| Asset restriction | Only the configured USDC mint | Not modeled |

**These must be enforced where the signature is produced, not only in our database.** If a database row is the only limit and the platform can still cause a signature, the cap is a promise, not a control.

## Possible mapping to provider features (to be confirmed with provider)

Privy may offer session or delegated signers and policy controls for embedded wallets (to be confirmed with provider; not verified here). If current official docs confirm they exist for Solana, the mapping would be:
- merchant destination, mint, and cap expressed as provider policy rules;
- expiry as the session lifetime;
- revocation as removal of the signer by the user;
- our `DelegatedPermission` as a mirror for display and audit, not as the control.

Items to confirm: whether policies support Solana and token-transfer constraints (destination, mint, amount); whether cumulative caps are supported or only per-transaction; who holds the signer key (app or provider); whether the user can revoke without our involvement; the audit log provided. If the provider cannot enforce these, the answer is no-go for provider-based delegation.

## Why it is off

- The feature gives the platform, or a key it controls, the ability to cause spending from a customer wallet. This is the case the custody model is designed to avoid.
- The per-checkout flow is implemented with one signature per order. It is unit-tested against fake chains and an in-memory database (`apps/api/src/wallet/checkout/__tests__/`, `tests/wallet/sandbox-scenario.test.ts`) but has not been run against a real cluster or Postgres. Delegation's benefit is convenience only.
- Legal and provider questions are unanswered (see `custody-model.md`).

## Risks

- **Custody characterization.** A platform-held signer with spending authority may change how regulators and the provider view the wallet. Needs counsel.
- **Liability for unauthorized spend.** Bug, key compromise, or abuse of a delegated signer could cause loss. Who bears it, and what consumer dispute rights apply, is unresolved.
- **Cap bypass.** Enforcement only in our database can be bypassed by a bug or a compromised service.
- **Stale consent.** A customer forgets an active permission. Expiry and reminders are required.
- **Refund interaction.** Refunds stay merchant-signed transfers and never use the delegated permission in reverse.
- **Marketing and disclosure.** "Non-custodial" wording may stop being supportable.

## Go / no-go criteria

All must be true before any pilot:
1. Counsel's written position that the delegated design does not change the custody or licensing analysis in a way we cannot accept.
2. The provider's official documentation confirms policy enforcement for destination, mint, amount, expiry, and user-initiated revocation, and the provider's terms allow our use.
3. A key-management design for the delegated signer (who holds it, how it is rotated and monitored) is reviewed.
4. Per-transaction and total caps default low, expiry defaults short, and a customer-facing revocation UI exists and is tested. (No revocation UI exists.)
5. Audit trail is complete and viewable in admin (read-only). Today `WalletAuditEvent` rows are written for wallet, on-ramp, transfer, and checkout events, but no admin endpoint or page exposes them.
6. A written loss-allocation and dispute process exists.
7. Verified on devnet, including revocation, expiry, cap exhaustion, wrong destination, and wrong mint, each failing closed. (`DevnetSolanaChain` has not been run against a real cluster even for the per-checkout flow.)
8. Staged rollout behind `ENABLE_DELEGATED_PAYMENTS` with a kill switch.

**No-go if any of the following:** enforcement is only in our database; the provider cannot confirm policy support; counsel cannot support the characterization; or revocation depends on our service being available.

Current status: **no-go**. Not assessed with any provider. Any delegated signer would break the "platform has no signing code path" property that `tests/wallet/custody-invariants.test.ts` enforces for `apps/api/src`; that test and `custody-model.md` would have to be changed deliberately.
