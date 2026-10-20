# Orders API

`POST /v1/orders` creates an order from active products and released lots. Prices always come from the database,
never from the client; all money is integer USD cents.

## Authentication: NOT SOLVED

**This route is not authenticated.** There is no real authentication yet (see `docs/security` and the README "API auth"
row). The customer is identified only by the `email` in the request body, so any caller can create an order for, or
claim the identity of, any email address. Nothing about this endpoint proves who the caller is.

The existing `x-customer-email` development identity (`SessionGuard`) is deliberately **not** required here: it only
accepts customers that already exist, and current callers (the wallet end-to-end flow and the storefront checkout)
create orders for emails without that guarantee, so requiring it would break them. Until real authentication exists,
treat order creation as untrusted input and do not use it as proof of identity or consent.

What this change does fix is cross-customer interference: the idempotency key can no longer be used to read, squat or
overwrite another customer's order (below).

## Request

Headers: `Idempotency-Key` (required unless `idempotencyKey` is in the body; both must match if both are sent).
Key format: `^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$`.

```json
{
  "email": "researcher@example.com",
  "shippingAddress": "123 Research Way, Boston, MA 02110, US",
  "researchUseAcknowledged": true,
  "items": [{ "productId": "<product id>", "lotCode": "BPC-157-2025-01", "quantity": 2 }]
}
```

Limits (violations are `400`, never `500`):

| Field | Limit |
| --- | --- |
| `items` | 1 to 50 lines |
| `quantity` | whole number, 1 to 1000 per line |
| order total | at most 2,147,483,647 cents (PostgreSQL `INT4`) |
| `researchUseAcknowledged` | must be `true` |

`email` is trimmed and lowercased, the same normalization as the wallet code, so one address is one customer.

## Response

`201` with the order: `id`, `customerId`, `status`, `totalCents`, `currency`, `researchAcknowledgedAt`, `createdAt`,
`items[]`. `id` is a **server-generated cuid**. It is not the idempotency key, and the key is never echoed back.
Wallet checkout and the storefront use the returned `id`; they must not assume it equals the key they sent.

## Idempotency

Scope is `(customerId, Idempotency-Key)`, enforced by the unique constraint `Order_customerId_idempotencyKey_key`.
Each order stores a `requestHash`: SHA-256 over the canonical JSON of `{ email (lowercased), shippingAddress,
researchUseAcknowledged, items sorted by productId then lotCode with quantities }`. Key order and line order in the
request do not affect it.

| Situation | Result |
| --- | --- |
| New key | Order created, `201` |
| Same customer, same key, same payload | The original order is returned (`201`); nothing new is created |
| Same customer, same key, different payload | `409` `Idempotency key was already used with a different request` |
| Different customer, same key | Treated as a brand-new key: a separate order is created. The other customer's order is never read, returned or hinted at |

Concurrent identical requests create exactly one order: the loser of the race gets a unique-constraint violation
(`P2002`), re-reads inside the same `(customerId, key)` scope and returns the winner's order (or `409` if the payloads
differ).

## Migration note

Migration `20261020160000_order_idempotency` adds nullable `Order.idempotencyKey` and `Order.requestHash` and the
composite unique index. Orders created before it have `NULL` for both (PostgreSQL treats NULLs as distinct) and keep
their old ids; a retried request from before the upgrade is not matched to them.
