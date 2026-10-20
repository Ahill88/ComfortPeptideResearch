# Commerce Test Strategy

## Scope

Protect the order path from cart creation through payment settlement. Monetary values are integer cents before payment and integer USDC atomic units during payment.

## Automated Coverage

Run `TS_NODE_PROJECT=apps/api/tsconfig.json node --require ts-node/register/transpile-only --test tests/commerce-workflows.test.ts` from the repository root.

The lightweight service tests use mocked persistence and queues to cover:

- Cart totals and persisted unit prices, including multi-quantity arithmetic.
- Rejection of unavailable products and product/lot mismatches.
- Research-use acknowledgement before a payment intent can be created.
- Exact cents-to-USDC atomic-unit conversion.
- Blocking expired confirmations before any signature update or verification job.
- `PENDING` payment confirmation transitioning the order to `PAID` only during settlement, with matching debit and credit ledger amounts.

## Transition Matrix

| Event | Payment | Order | Fulfillment rule |
| --- | --- | --- | --- |
| Cart submitted | None | `PENDING_PAYMENT` | Do not allocate or ship. |
| Intent created | `PENDING` | `PENDING_PAYMENT` | Do not fulfill. |
| Confirmation submitted | `PENDING` | `PENDING_PAYMENT` | Queue verification only; do not fulfill. |
| On-chain verification succeeds | `CONFIRMED` | `PAID` | Eligible for fulfillment processing. |
| Intent expires or verification fails | `EXPIRED` or `FAILED` | `PENDING_PAYMENT` | Do not fulfill. |
| Refund | `REFUNDED` | `REFUNDED` | Stop unshipped fulfillment; handle shipped orders under returns policy. |

## Follow-up Coverage

No fulfillment service currently exists in the API, so its payment gate cannot yet be exercised as an endpoint or worker test. When fulfillment is added, use an integration test with a transactional PostgreSQL database to prove that only `PAID` orders may transition to `PROCESSING`, reserve inventory once, and never ship `PENDING`, `FAILED`, `EXPIRED`, or `REFUNDED` payments. Add Solana adapter tests that reject an incorrect mint, treasury, amount, or insufficient finality before calling settlement.
