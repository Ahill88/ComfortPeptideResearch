# Mainnet readiness (without real money)

Status: **the wallet stack is network-correct, mainnet is a configuration change guarded by loud checks, and nothing here makes it ready for real funds.** Everything keeps working on devnet and the sandbox. The "Not ready" list at the end is the honest remainder.

## What changed

- **One mint source.** `SOLANA_USDC_MINT` becomes `config.usdcMint` and `chain.usdcMint`. Checkout, verification (`expectedMint`), refunds, balances, transfers and the on-ramp all read it (`usdcMintOf` / `usdcMintOrNull` in `wallet/chain/chain.types.ts`). Devnet falls back to the built-in devnet mint; any other network that lacks one throws. `SOLANA_USDC_MAINNET_MINT` is deprecated and **ignored** (startup warning if it is set and differs from `SOLANA_USDC_MINT`).
- **Strict startup validation** (`config/env.validation.ts`, `wallet/wallet.config.ts`). The API refuses to start on any violation below.
- **Boot-time chain preflight** (`wallet/chain/chain-preflight.ts`) proves against the live RPC that the cluster and mint are the configured ones.
- **Gating.** Checkout and external transfers, on prepare and on submit, need `ENABLE_SOLANA_MAINNET` and `ENABLE_LIVE_CRYPTO_PAYMENTS` on a mainnet network, and the preflight must have passed. The `sandbox` wallet provider cannot be linked on mainnet or in any production-like runtime (400).
- **Network-scoped balances.** Pending transfers and active reservations from another network never change spendable; a wallet linked under another network reads as zero with a notice.
- **`GET /v1/public/network-info`** (no auth, 60 s cache, the existing `public` rate-limit bucket): `{network, usdcMint, explorerTxBase, explorerClusterQuery, livePayments}`. It reports the chain the API actually uses. `livePayments` is true only on mainnet with both flags on and a passed preflight.
- Legacy `apps/api/src/payments` (disabled; its processor never settles) refuses to create intents for a non-devnet `SOLANA_NETWORK` and uses the configured mint instead of a literal. `packages/solana-sdk` is dead, devnet-typed code and was only annotated.

## Every switch

| Variable | Devnet / sandbox | Mainnet |
|---|---|---|
| `NODE_ENV` | any | exactly `production` (production-like; development and test are refused) |
| `WALLET_CHAIN_MODE` | `sandbox` (dev/test only) or `devnet` | `devnet`. This is the legacy name of the **real RPC adapter**; it serves whichever network `SOLANA_NETWORK` names |
| `SOLANA_NETWORK` | `solana-devnet` (default) | `solana-mainnet` |
| `SOLANA_RPC_URL` | optional (devnet default); must not look like a mainnet endpoint | **required**, https, not the devnet default, not devnet/testnet/local. Config only: the repo never contains a mainnet URL (`tests/wallet/custody-invariants.test.ts`) |
| `SOLANA_USDC_MINT` | optional (built-in devnet mint); valid base58 32-byte key if set | **required**, valid base58; copy it from Circle's page https://developers.circle.com/stablecoins/usdc-contract-addresses (not hard-coded in the repo) |
| `SOLANA_USDC_TREASURY` | required in production-like runtimes | required; valid, not the mint; its USDC token account must already exist |
| `ENABLE_SOLANA_MAINNET`, `ENABLE_LIVE_CRYPTO_PAYMENTS` | must not be set (startup error; also refused in development/test) | both exactly `true` |
| `WALLET_LIVE_ACKNOWLEDGED` | blank | exactly `I_ACCEPT_LIVE_FUNDS_RISK` |
| `MOONPAY_PUBLISHABLE_KEY` | `pk_test_` only | `pk_live_` only (a live key also needs both flags at quote time) |
| `SOLANA_USDC_MAINNET_MINT` | ignored | ignored (deprecated; warning) |

## Boot preflight

For every non-sandbox chain, `ChainPreflight.onModuleInit` requires:
1. `getGenesisHash` equals `SOLANA_GENESIS_HASHES[network]` (`wallet.config.ts`). A devnet RPC behind a mainnet configuration (or the reverse) is refused whatever the URL looks like.
2. `getAccountInfo(mint)`: exists, owner is the classic SPL Token program (Token-2022 refused), an initialized mint, **6 decimals**. Mint and freeze authority presence is logged, never a failure (the real USDC mint has both).

Outcomes: a definitive failure throws, so the API **refuses to start**. An RPC that is merely unreachable (or times out after 10 s) starts the API **degraded**: `isReady()` is false, checkout and transfers answer 503 with a generic message, and the check repeats every 30 s until it passes. A definitive failure found on a re-check keeps the process up but permanently not ready. RPC URLs are never logged (they may carry a provider key). A devnet ledger reset changes the devnet genesis hash; the API then refuses to start until the constant is updated, which is intended.

### Verified genesis hashes (2026-10-21)

| Network | Genesis hash | How verified |
|---|---|---|
| devnet | `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` | JSON-RPC `getGenesisHash` against Solana's documented devnet endpoint |
| mainnet | `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` | JSON-RPC `getGenesisHash` against a public third-party mainnet node. **Solana's documented mainnet endpoint timed out from the verifying machine** (connect timeout, repeated), so it was not the source. The value is also the widely published mainnet constant |

The repo's `ChainPreflight` was also run read-only against the live clusters (devnet with the built-in mint, mainnet with the mint from Circle's page, passed through the environment of a throwaway script): both passed with 6 decimals, and the crossed configurations (mainnet RPC with a devnet config, devnet RPC with a mainnet config, mainnet mint on devnet) were refused. No transaction was sent.

## Checklist to turn mainnet on (do not skip any)

1. Everything under "Not ready" below is resolved first. Do not proceed otherwise.
2. Read the mint from Circle's page, record source and date, set `SOLANA_USDC_MINT`.
3. Contract a production RPC; set `SOLANA_RPC_URL` (https). Keep it out of the repository.
4. Create the mainnet treasury (KMS/HSM-held per `architecture.md`), create its USDC token account, set `SOLANA_USDC_TREASURY`.
5. Set `NODE_ENV=production`, `WALLET_CHAIN_MODE=devnet`, `SOLANA_NETWORK=solana-mainnet`, both live flags `true`, `WALLET_LIVE_ACKNOWLEDGED=I_ACCEPT_LIVE_FUNDS_RISK`.
6. If MoonPay is used: the approved `pk_live_` key and its signing key; `ENABLE_REAL_MOONPAY=true`.
7. Start the API in staging first. Expect the "LIVE FUNDS ENABLED" warning and the "Chain preflight passed on solana-mainnet" line; any startup error names the variable at fault.
8. `GET /v1/public/network-info` must show `network: solana-mainnet`, the expected mint and `livePayments: true`.
9. Existing devnet customers keep their `CustomerWallet.network = solana-devnet` and read as zero with a notice on mainnet; checkout answers 409 for them. A relink/migration flow does not exist (one wallet per customer today).
10. Run a smallest-amount payment end to end yourself before opening to customers, and a refund of it.

## Not ready (do not enable mainnet until these exist)

- **A real user-owned wallet provider.** Only the sandbox provider (a browser localStorage key, refused on mainnet) works. Privy is a descriptor; nothing verifies an address belongs to a Privy user.
- **A KMS/HSM fee payer** (`FEE_PAYER_SIGNER`) for sponsored fees, and a **merchant signer** for refunds. The repository ships only sandbox in-memory signers.
- **MoonPay approval** for research-chemical commerce, a live key, and webhook delivery proven against MoonPay.
- **Treasury custody**: key management, token account, monitoring and the legal review in `custody-model.md`.
- The storefront still has a devnet mint literal and refuses non-devnet; it must read `network-info` and refuse to sign on a mismatch.
- `DevnetSolanaChain` success paths were exercised only against a fake `Connection` (plus read-only live preflight calls above); no real-cluster payment, refund or sponsored payment has been run. A real-devnet end-to-end run must come first.
- Operational: a shared RPC rate-limit plan, alerting on a degraded preflight, and the Redis/Postgres prepared-message stores sized for multiple instances.
- This is software hardening, not legal or compliance sign-off.
