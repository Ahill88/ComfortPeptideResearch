# COA anchoring on Solana

Companion to `docs/api/coa-contract.md` (the fixed contract). Code: `apps/api/src/coa/anchor/**`.

**What an anchor proves:** this exact document (its SHA-256) existed unchanged by the time of that transaction and was linked to this lot and
version by Helix & Field's publisher key. **What it does NOT prove:** that the lab's results are true, that the lab is accredited, that the
sample was representative, that the product in a vial came from that lot, or anything about a document that was never anchored. Say
"tamper-evident, publicly checkable record", never "blockchain-verified purity".

## The transaction (exact)

One legacy transaction, built by `buildMemoTransaction` (`coa-anchor-message.ts`):

| Part | Value |
| --- | --- |
| Fee payer / only signer | the COA publisher public key (account index 0) |
| Account keys (compiled) | exactly `[publisher (writable signer), MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr (read-only program)]` |
| Instructions | exactly ONE: program = Memo v2, accounts = `[publisher: signer, read-only]`, data = the memo (UTF-8) |
| Memo | `helix-coa:v1:<publish\|revoke>:<lotCode>:<version>:<sha256 lower-case hex>` (`buildCoaMemo`) |
| Blockhash | a recent `finalized` blockhash from the configured RPC |

Listing the publisher as a signer is the Memo v2 convention: the program verifies the signature and logs `Signed by <publisher>`, so the memo is
attributed on chain, not just by the fee payer. The Memo program moves no funds. Broadcast uses the canonical `tx.serialize()` with preflight
(`finalized`), never client bytes.

One `CoaAnchor` row exists per `(coa, kind)` (DB unique). PUBLISH anchors a coa that is or was published (PUBLISHED, SUPERSEDED, or REVOKED
after publication); REVOKE anchors only a REVOKED coa. Superseding a version does not anchor anything: the new version gets its own PUBLISH
anchor, the old one keeps its.

## Configuration

Anchoring has its own configuration, independent of the payment chain (`SOLANA_*`, `ENABLE_SOLANA_MAINNET`, `WALLET_CHAIN_MODE`): anchoring on
mainnet does not enable payments, and enabling payments does not enable anchoring. Parsed strictly at startup (a bad value stops the API).

| Variable | Values | Default |
| --- | --- | --- |
| `COA_ANCHOR_ENABLED` | exactly `true` / `false` (`TRUE`, `1`, `yes` are errors) | off: COAs publish without anchors, no row is created |
| `COA_ANCHOR_NETWORK` | `solana-devnet` \| `solana-mainnet` | `solana-devnet` |
| `COA_ANCHOR_RPC_URL` | https URL (http only for a local devnet validator). **Required for mainnet**, must not look like devnet/local; devnet rejects mainnet-looking URLs | devnet: the public devnet endpoint; mainnet: none (no mainnet URL exists anywhere in the repo) |
| `COA_ANCHOR_RECONCILE_INTERVAL_MS` | whole ms, `0` disables the scheduled sweep | `60000` |
| `COA_PUBLISHER_SIGNER` | NOT an env variable: a provider token (below) | unbound |

Error messages name the variable, never the URL (an RPC URL can carry an API key).

`GET /v1/public/anchor-info` reads `COA_ANCHOR_INFO` (core file `coa/coa-anchor-info.ts`), provided by the anchor module:
`{network, publisher, anchoringEnabled}` is `{solana-…, <publisher public key>, true}` only when anchoring is enabled **and** a signer is bound,
otherwise `{null, null, false}`.

## Key custody (required)

The repository contains no key and no implementation that holds one. The signing port is `CoaPublisherSigner { publicKey; signMessage(bytes) }`
under the token `COA_PUBLISHER_SIGNER` (`coa-publisher-signer.port.ts`). Mirrors the fee-payer rules:

- Production binds a **KMS/HSM-backed signer** (the key never enters the API process): `CoaAnchorModule.register({ providers: [{ provide: COA_PUBLISHER_SIGNER, useClass: … }] })`.
  Nest keeps the last provider registered for a token. In `AppModule` it is deliberately unbound.
- The key is **dedicated**: not the merchant treasury, not the checkout fee-payer key, not any customer wallet. It holds **only a few dollars of
  SOL** for fees (a memo transaction costs 5,000 lamports, so a few dollars covers years of anchors). Even a stolen key can only write memos and
  burn that SOL; it cannot move payments.
- The platform asks the signer for exactly one thing: the message of the memo-only transaction above. `assertMemoOnlyMessage` runs on the exact
  bytes before the signer is called and refuses anything else (any other instruction, account, signer, program or data). The signature is
  verified locally against the transaction before it is broadcast. The single `signMessage` call site is pinned by
  `tests/wallet/custody-invariants.test.ts`.
- With no signer bound, anchoring is unavailable: the row stays PENDING with the error "COA anchoring is unavailable: no publisher signer is
  bound", nothing is signed or broadcast, nothing crashes.

### Rotation

To rotate: create the new KMS key, fund it, bind it, restart. Then **update the public anchor-info (it follows the bound key automatically) and
publish the key change date** (for example on the verification page / changelog) with the old and new public keys, so third parties know which
key signed which anchors. Old anchors stay valid: they were signed by the old key and remain CONFIRMED (the verifier only re-checks PENDING
rows). A PENDING anchor in flight during a rotation fails verification (signer is not the configured publisher) and is re-issued with
`POST /admin/coas/:id/anchor/retry`. Retire and drain the old key.

## Lifecycle and how the verifier works

`requestAnchor({coaId, kind})` (called by the core after publish/revoke; fail-soft, never throws, idempotent):

1. Per `(coaId, kind)` calls are serialized in process, the DB unique constraint plus `P2002` handling covers other processes, and a
   compare-and-set on `attempts` / `txSignature IS NULL` means only one process ever builds a transaction for a row.
2. Create the `CoaAnchor` row PENDING with the memo and network. Build, sign (via the port helper), verify the signature locally.
3. **Persist the transaction signature, then broadcast.** A definitive rejection (the cluster's preflight refused it) marks the row FAILED with
   a short error and no signature. Any other outcome (timeout, outage) is *unknown*: the row stays PENDING **with** the signature and the
   reconciler decides. A broadcast outcome is never guessed.

`verifyAnchor(anchorId)` and the scheduled sweep (`CoaAnchorScheduler`, only when `COA_ANCHOR_ENABLED=true`, every
`COA_ANCHOR_RECONCILE_INTERVAL_MS`) re-read each PENDING row from the chain and mark it **CONFIRMED only when all of these hold**:

- the transaction is `finalized` and succeeded (a not-yet-finalized transaction stays PENDING, even one that looks failed);
- legacy transaction, exactly one signer, fee payer (index 0) equals the **configured publisher public key**;
- account keys are exactly `[publisher, memo program]`, no inner instructions;
- exactly **one** instruction in total, and it is a Memo-program instruction whose accounts are `[publisher]` and whose data equals the expected
  memo **byte for byte**. The expected memo is rebuilt from the Coa and Lot records and must also equal the stored memo.

Slot and block time are recorded. A failed transaction or any mismatch (wrong memo/lot/version/hash/kind, extra or second instruction, wrong
signer, wrong network) marks the row FAILED with a reason. The public API only shows CONFIRMED anchors.

Sweep rules for rows that are not confirmed (times are measured from the row's last update):

- PENDING **without** a signature, stale for 10 minutes: attempted again (also when it was only waiting for a signer or the RPC), at most **5
  attempts**, then FAILED "gave up after 5 attempts".
- PENDING **with** a signature the chain **does** know: verified, never re-sent.
- PENDING with a signature the chain does **not** know: nothing happens for 10 minutes (a blockhash lives about two minutes, so after 10
  the transaction cannot land any more). Only then, and only because the lookup answered "not found" (an RPC error is *not* "not found"), the
  signature is cleared and a new transaction is sent. A duplicate memo would be harmless but is avoided.

### Retry

`AnchorService.retry(coaId, kind)` (the admin route `POST /admin/coas/:id/anchor/retry` delegates to it; it throws `CoaAnchorRefusedError` with a
`reason`): refuses a CONFIRMED anchor (`ALREADY_CONFIRMED`), anchoring off or no signer (`DISABLED`, `NO_SIGNER`), an ineligible or unknown coa
(`NOT_ELIGIBLE`, `NOT_FOUND`), a transaction that may still land (`IN_FLIGHT`: sent less than 10 minutes ago, or on chain but not finalized),
and an unreadable chain (`CHAIN_UNAVAILABLE`). Otherwise it first re-reads the old signature (it may simply confirm), then resets the row
(attempts back to 0) and sends a fresh transaction. If no row exists yet (anchoring was off when the COA was published) it creates one.

## Explorer links

`coaExplorerTxUrl(network, signature)`: `https://explorer.solana.com/tx/<signature>` plus `?cluster=devnet` for devnet only.

## Development

`tools/dev/api-devnet-sponsored.ts` binds a throwaway devnet key as `COA_PUBLISHER_SIGNER` when `DEV_COA_PUBLISHER_KEYPAIR_FILE` is set (a JSON
array of 64 bytes, a **different** key than `DEV_SPONSOR_KEYPAIR_FILE`). It needs `COA_ANCHOR_ENABLED=true` in `.env`, devnet only, local DB, and
`NODE_ENV=development` (the same safety checks as the sponsor key). Without the variable it prints a note and anchors stay PENDING.

Create and fund a throwaway key (never reuse it anywhere else):

```
solana-keygen new --no-bip39-passphrase -o /tmp/devnet-coa-publisher.json     # or any tool that writes a 64-byte JSON array
solana-keygen pubkey /tmp/devnet-coa-publisher.json
```

Fund its public key with devnet SOL at the web faucet **https://faucet.solana.com** (choose devnet). The RPC `requestAirdrop` is heavily rate
limited on the public endpoint and often fails, so use the web faucet; 0.1 SOL is thousands of anchors.

An end-to-end devnet check is available as `tests/coa/live-anchor.run.ts` (not part of `run-all`): it anchors a fake lot `LIVE-TEST-1` once and
verifies it through the real verifier against `api.devnet.solana.com` (public RPC rate limits apply).

Tests: `node tests/run-all.mjs anchor` (unit, fake chain + in-memory Prisma; the `*.integration.test.ts` suite needs `TEST_DATABASE_URL`).
