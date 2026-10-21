# Admin order fulfillment API

Back-office routes for the owner to pack and ship orders. Base path `/v1/admin/orders`. Every route, read-only ones
included, requires an admin session (`Authorization: Bearer <session token>`, see `AdminSessionGuard`); a missing,
unknown, revoked or expired token is `401 Admin sign-in required.`. Responses are `Cache-Control: no-store` because they
contain customer email and shipping address. Source: `apps/api/src/admin/orders/`.

## Routes

| Route | Result |
| --- | --- |
| `GET /counts` | `{ counts: { PENDING_PAYMENT, PAID, PROCESSING, SHIPPED, DELIVERED, CANCELLED, REFUNDED } }` (all seven, zero-filled) |
| `GET /?status=&q=&limit=&cursor=` | `{ items: AdminOrderSummary[], nextCursor: string \| null }` |
| `GET /:id` | `AdminOrderDetail` |
| `POST /:id/start-packing` `{}` | `PAID -> PROCESSING` |
| `POST /:id/ship` `{ carrier, trackingNumber, note? }` | `PROCESSING -> SHIPPED`, creates the Shipment |
| `POST /:id/mark-delivered` `{}` | `SHIPPED -> DELIVERED`, sets `deliveredAt` on the order's shipments |
| `POST /:id/cancel` `{ reason }` | `PENDING_PAYMENT -> CANCELLED` only |
| `POST /:id/notes` `{ note }` | appends a `NOTE` event, no status change |

Every action answers `200` with the updated `AdminOrderDetail`.

### List query

- `status`: optional, comma-separated (`PAID,PROCESSING`). An unknown value is `400`.
- `q`: optional, at most 100 characters. Matches an order **id prefix** OR a customer **email substring**, case-insensitive.
  `%`, `_` and `\` are literal characters, not wildcards.
- `limit`: default 25, `1..100` (outside that range is `400`, not clamped).
- `cursor`: opaque base64url from a previous `nextCursor`. A malformed cursor is `400`.
- Order: newest first by `createdAt`, then `id` (both descending). Keyset pagination on `(createdAt, id)`, so rows that
  share a `createdAt` are never skipped or repeated, and newer inserts between pages do not shift later pages.

### Shapes

```
AdminOrderSummary = {
  id, status, totalCents: number, currency, createdAt: ISO,
  customer: { id, email, name: string | null },
  itemCount: number            // sum of line quantities
  hasShipment: boolean,
  trackingNumber: string | null // most recent shipment's
}
AdminOrderDetail = AdminOrderSummary & {
  shippingAddress: string | null,   // null only for orders created before the column existed
  items: [{ id, productId, sku, name, lotCode, quantity, unitCents }],
  payment: null | { status, amountAtomic: string, txSignature: string | null, network, finalizedAt: ISO | null },
  shipments: [{ id, carrier, trackingNumber, shippedAt, deliveredAt: ISO | null, note: string | null }],
  events: [{ id, kind: 'STATUS' | 'NOTE', fromStatus, toStatus, note, adminName: string | null, createdAt }], // oldest first
  allowedActions: ('start-packing' | 'ship' | 'mark-delivered' | 'cancel' | 'add-note')[]               // add-note always
}
```

`payment` is read-only and derived from the order's `CryptoTransaction` row of type `PURCHASE` (if there are several
because of retries, the furthest-along one: FINALIZED, CONFIRMED, SUBMITTED, PREPARED, FAILED, EXPIRED; newest on ties).
`amountAtomic` is a decimal string of USDC base units. Wallet addresses are never selected or returned.

### Inputs

- `carrier`: `USPS | UPS | FedEx | DHL | OTHER` (exact case).
- `trackingNumber`: trimmed, 4-64 characters, `/^[A-Za-z0-9][A-Za-z0-9 -]*$/`. The same number twice for one order is `409`.
- `ship.note`: optional, at most 500. `cancel.reason`: 1-500. `notes.note`: 1-1000 (all trimmed).

### Errors

| Status | When |
| --- | --- |
| `400` | validation (carrier, tracking number, reason/note length, list query) |
| `401` | no valid admin session |
| `404` | unknown order id |
| `409` | `Order is <STATUS>; cannot <action>.` for an illegal transition, where `<action>` is `start packing`, `ship`, `mark delivered` or `cancel` |
| `409` | cancelling a `PAID`, `PROCESSING` or `SHIPPED` order: `Paid orders are refunded through the refunds process, not cancelled.` |
| `409` | `This tracking number is already recorded for this order.` |

## State machine

```
PENDING_PAYMENT --cancel--------------------------> CANCELLED
PENDING_PAYMENT --(wallet checkout settles)-------> PAID         (never from this API)
PAID --start-packing--> PROCESSING --ship--> SHIPPED --mark-delivered--> DELIVERED
PAID --(refunds process)--> REFUNDED                              (never from this API)
```

Nothing else is legal; skipping a step (for example shipping a `PAID` order) is a `409`.

## Concurrency and audit

Each transition is one database transaction that performs a conditional `updateMany({ where: { id, status: <expected> } })`
and, **only if that call changed a row**, writes the `STATUS` `OrderEvent` (and the `Shipment` for `ship`, `deliveredAt` for
`mark-delivered`). Ten parallel `ship` calls give exactly one `200`, nine `409`, one `Shipment`. A duplicate tracking
number rolls the whole transaction back, so the order stays `PROCESSING`.

Each successful action also writes an `AdminAuditEvent` (`order.start-packing`, `order.ship`, `order.mark-delivered`,
`order.cancel`, `order.add-note`; `targetType` `order`) holding ids, statuses and, for `ship`, carrier and tracking number.
Note text, cancel reasons, emails and addresses are not copied into the audit trail. The audit row is written after the
transaction commits; if that write fails the action still succeeds and the failure is logged (order id only).
Refused actions (409/404) are not audited.

## Deliberately not here

- **No inventory decrement.** `Product.inventory` is not touched by any transition.
- **No email notifications** to the customer on any transition.
- **No carrier label purchase** or tracking lookup; the owner types the tracking number from a label bought elsewhere.
- **Cancelling a paid order is refunds.** `PAID`, `PROCESSING` and `SHIPPED` orders cannot be cancelled here; they go through the
  refunds process (`/admin/refunds`), which this module neither calls nor imports.
- **No money or payment changes.** No route marks an order `PAID`, creates a refund, or writes payment/wallet rows.
  Wallet internals are not imported; `CryptoTransaction` is only read through Prisma.
- No editing of the shipping address, items or totals.

## Operational notes

- The refunds engine only accepts orders whose status is `PAID`. After `start-packing` an order is `PROCESSING`, so a refund
  for it has to be handled before packing starts (or the refunds rules changed); this API does not work around that.
- Cancelling a `PENDING_PAYMENT` order does not stop an in-flight payment attempt. If funds land afterwards, wallet settlement
  cannot mark the cancelled order `PAID`; it rolls back and flags the purchase `manual refund required` (existing behaviour in
  `verification.service.ts`, not changed here).
