# Customer order history and order emails

Contract: `docs/api/commerce-contract.md` section 4. Source: `apps/api/src/orders/customer-orders.*`.
Routes sit on the same prefix as order creation (`/v1/orders`), identity comes from the shared resolver
(`apps/api/src/wallet/customer-identity.ts`: dev/test `x-customer-email` header, or the session cookie once that lands).
No identity is `401`. Responses are `Cache-Control: no-store`. Read endpoints never create a customer.

## Routes

| Route | Result |
| --- | --- |
| `GET /v1/orders?limit=20&cursor=` | `{ items: OrderSummary[], nextCursor: string \| null }`, the caller's orders, newest first |
| `GET /v1/orders/:id` | `OrderDetail`. `404 Order not found.` for an unknown id AND for another customer's order (same body, existence is never revealed) |

`limit` is `1..50` (default 20; anything else is `400`, not clamped). `cursor` is opaque base64url from a previous
`nextCursor`; a malformed one is `400`. Pagination is keyset on `(createdAt desc, id desc)`, so rows sharing a `createdAt`
are never skipped or repeated. A customer with no row yet gets an empty page.

```
OrderSummary = { id, status, totalCents, subtotalCents: number|null, shippingCents, taxCents, currency, createdAt,
                 itemCount /* sum of quantities */, carrier: string|null, trackingNumber: string|null /* latest shipment */ }
OrderDetail  = { id, status, totalCents, subtotalCents|null, shippingCents, taxCents, currency, createdAt,
                 shippingAddress: string|null,   // only ever returned to the owner; null only for pre-column legacy orders
                 items: [{ productId, slug, name, lotCode, quantity, unitCents }],
                 shipments: [{ carrier, trackingNumber, trackingUrl: string|null, shippedAt, deliveredAt: string|null }],  // oldest first
                 timeline: [{ status, at }] }
```

`slug`/`name` come from `Product` (an order line has no foreign key to it); if a product row is gone, `slug` is `null` and
`name` is `Unavailable product` instead of failing the order.

## Timeline

Only `{status, at}` pairs, built from: `PENDING_PAYMENT` at `Order.createdAt`, then every `OrderEvent` of kind `STATUS`
that has a target status, oldest first. Staff notes (`NOTE` events and the `note` on status events), admin ids and names,
and the shipment note are never selected from the database, so they cannot be serialised (a test seeds an order with a
staff note and asserts it never appears, and asserts the issued selects name no such column).

Payment settlement (`VerificationService`) does not write an `OrderEvent`, so when no event records `PAID`, the
`finalizedAt` of the order's FINALIZED purchase transaction is used as the `PAID` time (only that timestamp is read, no
wallet or signature columns). A legacy order with no events and no purchase shows just `PENDING_PAYMENT`: later
transitions made before events existed have no recorded time and are not invented.

## Tracking URLs

`buildTrackingUrl(carrier, trackingNumber)` is pure (`customer-orders.mappers.ts`). The carrier must match the stored value
exactly (`USPS`, `UPS`, `FedEx`, `DHL`); `OTHER`, any other string, an empty number or an unencodable number gives `null`.
The number is trimmed and percent-encoded (`encodeURIComponent` plus `! ' ( ) *`), so `&`, `#`, `?`, `/`, spaces, quotes,
CR/LF and `%` cannot add parameters, a fragment, a host or markup.

| Carrier | Pattern |
| --- | --- |
| USPS | `https://tools.usps.com/go/TrackConfirmAction?tLabels=<n>` |
| UPS | `https://www.ups.com/track?tracknum=<n>` |
| FedEx | `https://www.fedex.com/fedextrack/?trknbr=<n>` |
| DHL | `https://www.dhl.com/global-en/home/tracking.html?tracking-id=<n>` |

**What was and was not verified (2026-10-21).** No carrier publishes these URL templates on a page I could read: the
carrier tracking pages are script-rendered and bot-protected, and a search engine was blocked. I fetched each exact URL with
a sample number: UPS (`Tracking | UPS - United States`), FedEx (`Detailed Tracking`) and DHL (`Tracking - DHL - United
States of America`) answered with their own tracking pages, which shows the host and path exist, not that the query
parameter is read. USPS answered `401` (curl) and an empty body (fetch tool), so nothing was confirmed for USPS. The DHL
Shipment Tracking developer page (`developer.dhl.com/api-reference/shipment-tracking`) documents the API, not the web URL.
Treat all four patterns as UNVERIFIED against carrier documentation until someone checks a real shipment in a browser; they
are isolated in one table so a change is a one-line edit.

## Email hooks

Both go through `EMAIL_PORT` (`apps/api/src/email/email.types.ts`), injected `@Optional()`: with no port bound nothing is
sent and nothing fails. The recipient is the customer's email. Shared helper: `customer-orders.email-hook.ts`
(`runOrderEmailHook`).

| Event | Where | Template, `dedupeKey`, data |
| --- | --- | --- |
| Shipped | `AdminOrdersService.ship`, after the ship transaction and audit row | `order_shipped`, `order_shipped:<orderId>:<trackingNumber>`, `{orderId, carrier, trackingNumber, trackingUrl}` |
| Payment confirmed | `VerificationService.settle`, after the settlement transaction, only on the call that won the conditional update (`settledNow`) | `order_confirmation`, `order_confirmation:<orderId>`, `{orderId, totalCents, currency}` |

Guarantees: fires once per shipment (only the one call that flips `PROCESSING -> SHIPPED` reaches it) and once per paid
order (losers of racing/duplicate verifications return before it; a payment that fails, stays pending or cannot mark the
order paid sends nothing); the `dedupeKey` is a second line of defence in the outbox. Neither hook can fail or undo the
primary action: lookup errors, rejected or synchronously thrown enqueues and a missing customer email are caught, a hung
port is abandoned after 750 ms (`ORDER_EMAIL_HOOK_TIMEOUT_MS`, so shipping/settling is delayed by at most that), and logs
carry template and order id only (no address, tracking number or error text).

Known limit: a process crash between the commit and the enqueue loses that one email (there is no retry from the order
side). Re-enqueueing is safe because of the dedupe keys, so a future backfill job can scan PAID/SHIPPED orders.

## Tests

`apps/api/src/orders/__tests__/customer-orders.{mappers,http,email-hook}.test.ts` (in-memory doubles, including a route
order test against stand-ins for `POST /orders` and `POST /orders/quote` in both controller orders),
`customer-orders.integration.test.ts` (PostgreSQL scratch schema), `admin/orders/__tests__/admin-orders.email-hook.test.ts`,
`wallet/checkout/__tests__/verify-email-hook.test.ts`.
