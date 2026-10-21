# Admin refunds (cancel after payment)

An order that has been paid in USDC is refunded by the **owner** from the order page. A refund is a NEW USDC transfer from the merchant
treasury to the customer's own wallet. The platform never debits a customer wallet and never holds a treasury key. Contract:
`docs/api/commerce-contract.md` section 5. Source: `apps/api/src/admin/orders/admin-order-refund.*` (workflow, audit, mapping) on top of the
existing engine `apps/api/src/wallet/refunds/` (all money logic; not reimplemented).

## Workflow

| Step | Route (base `/v1/admin/orders`) | What happens |
| --- | --- | --- |
| 1. request | `POST /:id/refund {reason: 1-500}` | Creates the refund (status `REQUESTED`). The order stays `PAID`/`PROCESSING`. |
| 2. submit | `POST /:id/refund/submit {}` | The bound `MERCHANT_SIGNER` signs, the API re-verifies the signature and broadcasts (`SUBMITTED`). |
| 3. verify | `POST /:id/refund/verify {}` | Re-reads the chain. On `FINALIZED` the order becomes `REFUNDED` (a `STATUS` order event is written) and, if it had not shipped, its stock is released. |

Each route answers `200` with the updated `AdminOrderDetail`, which now carries
`refund: null | { id, status: 'REQUESTED'|'SUBMITTED'|'FINALIZED'|'FAILED', amountAtomic, txSignature, requestedAt, failureReason }` and the
action `'refund'` in `allowedActions` (PAID or PROCESSING, no refund in progress). The `refund` object never contains a wallet address.
Verify is safe to repeat (poll it until `FINALIZED`); a transfer that failed or does not match becomes `FAILED` and the order may then be
refunded again with a new request.

## Who can do what

- **OWNER only**, with an admin session (`AdminSessionGuard`): STAFF get `403`, no/invalid session `401`.
- Audit rows (`AdminAuditEvent`, `targetType order`): `order.refund.request`, `order.refund.submit`, and `order.refund.verify` (written when verify
  changes state: `FINALIZED` or `FAILED`). Detail holds ids, amount, signature and outcome, never the reason text or an address.
  The engine also keeps its own `refund.requested|submitted|finalized|failed` wallet audit events.

## Rules and limits

- **Amount**: always the exact paid amount (the order total). There is no amount field; a request carrying anything but `reason` is `400`.
- **Destination**: never supplied by the admin. It is the wallet the customer paid from (derived from the order's finalized purchase) and it must
  still be the customer's linked wallet, otherwise `409` ("manual review"). Checked again at submit.
- **Order state**: `PAID` and `PROCESSING` only (an order being packed can be refunded; the owner decides). `SHIPPED`/`DELIVERED` is `409`
  ("Shipped orders cannot be refunded here."), as are `PENDING_PAYMENT`, `CANCELLED` and `REFUNDED`.
- **One refund at a time per order.** A second request while one is `REQUESTED`/`SUBMITTED`/`FINALIZED` is `409`.
- **Double click**: submit is idempotent. Concurrent or repeated submits sign and broadcast once and all return the same transaction.
- **Fulfilment lock**: once a refund is `SUBMITTED` the order can be neither packed nor shipped (`409`). A merely `REQUESTED` refund does not block
  fulfilment; if the order ships first, submit is refused and that request stays `REQUESTED` (no cancel endpoint exists yet).
- **Stock**: released only for an order that had not shipped, in the SAME database transaction that sets `REFUNDED`
  (`INVENTORY_PORT.releaseForOrder`, idempotent), together with the `REFUNDED` order event. If the release fails the whole finalization rolls
  back and the refund stays `SUBMITTED`, so verify can simply be run again. If no inventory implementation is bound the refund still finalizes and
  an error is logged (the money has already moved).
- **No signer bound**: submit answers `503 Refund signing is not available.` and changes nothing. Request and verify still work.
- Partial refunds exist in the engine (`/v1/admin/refunds`, admin token) but not in this owner workflow.
- Not covered: refunding to a different wallet, a chargeback/dispute process, tax/shipping splits, customer notification emails.

## Devnet in development

The repository ships **no** treasury key and no signer implementation under `apps/api/src`. For devnet the dev launcher binds one, exactly like
the fee-payer and COA publisher keys:

1. Create a throwaway devnet key (never reuse a real one), fund its SOL (about 0.02) and its USDC token account with devnet USDC.
2. Set `SOLANA_USDC_TREASURY` in `.env` to that key's public key.
3. Start the API with `DEV_TREASURY_KEYPAIR_FILE=/path/to/dev-treasury.json` next to `DEV_SPONSOR_KEYPAIR_FILE` (see the header of
   `tools/dev/api-devnet-sponsored.ts`). The launcher refuses to start if the treasury address in `.env` is not that key's public key, if the key
   equals the sponsor or COA key, or if the usual checks fail (`NODE_ENV=development`, devnet only, local database).
4. The binding (`tools/dev/dev-treasury-signer.ts`) applies its own policy and signs only one USDC `transferChecked` from the treasury to the customer's
   USDC account for the approved amount; the API additionally re-verifies the returned signature.

Without `DEV_TREASURY_KEYPAIR_FILE` nothing is bound and submit is `503`, as in production.

Live proof: `tests/refunds/live-refund.run.ts` (manual, not part of `run-all`) funds a throwaway treasury, boots a throwaway app, pays a $1.25 order
from a real linked wallet and refunds it through these routes, checking balances and the transaction on chain (usage in the file header).

## Production

Production binds a **KMS/HSM-backed `MERCHANT_SIGNER`** (key never exported to the API process, its own policy on amount and destination,
ideally human approval and maker-checker) under the same token; see `apps/api/src/wallet/refunds/merchant-signer.port.ts`,
`docs/wallet/custody-model.md` and `docs/wallet/architecture.md` section 6. Until one is bound, submit returns `503` and refunds stay a manual
off-platform process. `tests/wallet/custody-invariants.test.ts` pins that `apps/api/src` contains no implementation, binds `MERCHANT_SIGNER` only
to "unbound", and has exactly one delegated signing call, preceded and followed by the checks above.
