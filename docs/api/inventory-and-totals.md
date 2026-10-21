# Stock, order totals, order holds and the admin inventory API

Contract: `docs/api/commerce-contract.md` section 3. Source: `apps/api/src/commerce/**`, `apps/api/src/orders/orders.service.ts`,
`apps/api/src/admin/inventory/**`. Money is integer cents everywhere.

## Totals

```
subtotal = sum(unitCents x quantity)                       unit prices come from the database, never from the client
shipping = 0                    when SHIPPING_FREE_OVER_CENTS is set and subtotal >  SHIPPING_FREE_OVER_CENTS
           SHIPPING_FLAT_CENTS  otherwise
tax      = round-half-up(subtotal x TAX_RATE_BPS / 10000)   on the subtotal only; shipping is not taxed
total    = subtotal + shipping + tax                        must be <= 2,147,483,647 (Int32), otherwise 400 "Order total is too large"
```

"Over" is strict: a subtotal exactly equal to the threshold still pays shipping. Half-up means 0.5 cent rounds to 1.
The arithmetic is one pure class (`ShippingTaxCalculator`), used by both the quote and order creation, so they cannot disagree.

| Env | Default | Valid |
| --- | --- | --- |
| `SHIPPING_FLAT_CENTS` | `0` | whole number 0..2147483647 |
| `SHIPPING_FREE_OVER_CENTS` | unset (never free) | whole number 0..2147483647 (`0` is a real threshold) |
| `TAX_RATE_BPS` | `0` | whole number 0..10000 (825 = 8.25%) |
| `ORDER_HOLD_MINUTES` | `60` | whole number 1..10080 |
| `ORDER_SWEEP_INTERVAL_MS` | `60000` | whole number 0..86400000; `0` disables the sweep on this instance |

Parsing is strict and happens when the application boots (like `ONRAMP_*`): digits only (no sign, decimal point, exponent,
separator or `%`), in range, otherwise the API refuses to start and names the variable. Nothing falls back silently.

## `POST /v1/orders/quote` (public, rate limited, writes nothing)

Body `{ items: [{ productId, lotCode, quantity }] }`, same bounds as order creation (1..50 lines, quantity 1..1000). `200`:

```
{ currency: 'USD', subtotalCents, shippingCents, taxCents, totalCents,
  lines: [{ productId, lotCode, quantity, unitCents, lineCents }],
  unavailable: [{ productId, reason: 'out_of_stock' | 'inactive' | 'unknown_lot', available: number | null }] }
```

- `lines` holds every line that can be priced (active product, known lot, and a PUBLISHED COA when `REQUIRE_PUBLISHED_COA=true`). Totals are computed over `lines`.
- `inactive`: the product is inactive or does not exist (the two are not distinguished). `unknown_lot`: the lot is not one of the product's (or has no published COA while that is required). Neither is priced; `available` is `null`.
- `out_of_stock`: the quantities of the priced lines of one product (all its lots together) exceed what is on hand. The line IS priced so the customer sees the cost; `available` is the units left. One entry per product.
- An empty `lines` gives all zeros. Rate limit: the `public` bucket (`THROTTLE_PUBLIC_LIMIT`, `config/rate-limit.ts`). `Cache-Control: no-store`.
- A quote is a preview, not a promise: stock can change before the order is placed.

## `POST /v1/orders` changes

- **Stock is reserved with the order, atomically.** One transaction inserts the order and its lines, then reserves every product: `UPDATE "Product" SET inventory = inventory - q WHERE id = $1 AND inventory >= q` (Prisma `updateMany` with `gte` + `decrement`) plus an `ORDER_RESERVE` ledger row. Quantities of two lots of one product are summed (one stock pool). If any product cannot be covered the transaction rolls back every earlier reservation and the order row: `409 { code: 'OUT_OF_STOCK', message: 'Insufficient stock for <name>.', productId, available }` (the first product, in ascending id order, that fails). Products are locked in ascending id order, so two orders listing the same products in opposite order cannot deadlock. Stock can never go negative and the units sold can never exceed the units on hand, however many orders race.
- **Hold**: `expiresAt = now + ORDER_HOLD_MINUTES`. Not part of the public order response.
- **Stored and returned**: `subtotalCents`, `shippingCents`, `taxCents` (and `totalCents`) on the order; the response gains the first three. `subtotalCents` is `null` only for orders created before totals were stored.
- **Idempotency is unchanged and still returns the ORIGINAL order.** A replay never reserves stock again and never recomputes totals. The `requestHash` still covers only email, address, acknowledgement and lines: totals, shipping/tax settings, stock and the clock are NOT in it, so a replay after an env change returns the original order instead of a 409.
- **Identity.** With an authenticated customer from the shared resolver (`resolveRequestIdentity`: dev/test `x-customer-email` header or session cookie) the order belongs to that customer, `email` in the body may be omitted, and a different email is `400`. Without one: development/test still accept the anonymous body email; every production-like runtime (`!isNonProductionRuntime`) answers `401 Sign in to place an order.` and creates nothing (fail closed). A session cookie on this POST also needs an allow-listed `Origin` (the resolver answers 403 otherwise).
- `shippingAddress` is still never in the public response. The Int32 bounds (quantity, lines, total) are unchanged; the total now includes shipping and tax.

## Releasing stock

`InventoryService.releaseForOrder(tx, orderId, reason)` (the `INVENTORY_PORT`) runs inside the caller's transaction:
claims `Order.inventoryReleasedAt` with a conditional update (`WHERE inventoryReleasedAt IS NULL`, so exactly one caller proceeds), then for every `ORDER_RESERVE` row writes an `ORDER_RELEASE` row (unique per `(orderId, productId, kind)`, `skipDuplicates` as a second guard) and adds the units back. Idempotent and concurrency safe. An order with no `ORDER_RESERVE` rows (created before holds existed) releases nothing: no stock is invented for it. Callers: the sweep, the admin cancel of a `PENDING_PAYMENT` order (same transaction as the status flip, so a failing release rolls the cancel back) and the refund flow for PAID/PROCESSING orders.

## The unpaid-order sweep

`OrderSweepScheduler` runs `OrderSweepService.sweep()` every `ORDER_SWEEP_INTERVAL_MS` (first run one interval after start; an overlapping tick is skipped; `0` disables it on this instance). Every instance may run it: each order is handled by conditional updates inside ONE transaction, so concurrent sweepers, an admin cancel and settlement are serialised by the order row lock.

Per order with `status = PENDING_PAYMENT` and `expiresAt < now`:

1. conditional flip `PENDING_PAYMENT -> CANCELLED` (only while still expired and pending);
2. **skip (roll the flip back)** if a purchase `CryptoTransaction` for the order is `SUBMITTED`, `CONFIRMED` or `FINALIZED`, or `PREPARED` while its `CreditReservation` is `ACTIVE` and unexpired. A customer-signed payment may be on its way; reconciliation or verification must settle or expire it first, after which a later sweep handles the order;
3. otherwise retire the order's leftover `PREPARED` purchase (`EXPIRED`, `order expired unpaid`) and `ACTIVE` reservation (`RELEASED`), then check once more that no payment moved to `SUBMITTED`/`CONFIRMED`/`FINALIZED` in the meantime (a submit that wins the claim race between the two checks is seen here and makes the sweep skip);
4. `releaseForOrder(..., 'Order expired unpaid')` and an `OrderEvent` `STATUS PENDING_PAYMENT -> CANCELLED`, note `Expired unpaid`, no admin.

Each cancel logs one line `order.sweep.cancelled orderId=... from=PENDING_PAYMENT to=CANCELLED reason=expired_unpaid` (ids only, no customer data). Settlement (`VerificationService`) also flips `PENDING_PAYMENT -> PAID` conditionally; if the sweep ever won that race, settlement's existing guard marks the payment for manual refund instead of silently settling. Because the sweep skips every in-flight payment, that case needs a payment to be claimed in the few milliseconds between the sweep's two checks, which step 3's re-check closes (tested by `commerce.integration.test.ts`).

## Admin inventory (`/v1/admin/inventory`, admin session guard)

| Route | Roles | Result |
| --- | --- | --- |
| `GET ?q=&lowStockOnly=&limit=25&cursor=` | any admin | `{ items: [{ productId, sku, name, active, onHand, reserved, lowStockThreshold, lowStock }], nextCursor }`; ordered by SKU, keyset on SKU; `limit` 1..100; `q` matches SKU or name (case-insensitive, `%` and `_` literal); `lowStockOnly=true` needs a threshold and `onHand <= threshold` |
| `POST /:productId/adjust { delta, reason }` | any admin | `delta` a non-zero whole number, `|delta| <= 100000`; `reason` 1..200 characters. One conditional update (result may not go below 0, nor above Int32), one `ADMIN_ADJUST` ledger row, audit `inventory.adjust`. `409` when it would go below zero, `404` unknown product. Returns the item |
| `GET /:productId/ledger?limit=50&cursor=` | any admin | `{ items: [{ id, delta, kind, reason, orderId, adminName, createdAt }], nextCursor }`, newest first, keyset on `(createdAt, id)`, `limit` 1..100 |
| `POST /:productId/threshold { lowStockThreshold }` | OWNER | whole number >= 0 or `null` (clears it). Audit `inventory.threshold`. Returns the item |

Meaning of the numbers: `onHand` is `Product.inventory`, the units still SELLABLE. Units held by unpaid orders have already been taken out of it. `reserved` is the units held by orders that are `PENDING_PAYMENT`, not yet released and not yet expired (informational: they come back if those orders expire or are cancelled). `lowStock` is `lowStockThreshold != null && onHand <= lowStockThreshold`. Paid, unshipped orders are neither in `reserved` nor added back to `onHand`. The public catalog never exposes `lowStockThreshold`. `AdminOrderSummary`/`AdminOrderDetail` also carry `subtotalCents` (`null` for older orders), `shippingCents`, `taxCents`.

## What this does NOT do

- **No tax engine.** `TAX_RATE_BPS` is one flat rate on the subtotal for every customer and destination; no jurisdictions, product tax codes, exemptions, rounding per line or tax reporting. Do not describe it to customers as calculated sales tax.
- **No lot-level stock.** Stock is one number per product; lots are labels on order lines, so a lot cannot be sold out separately.
- **No backorders or waitlists.** An order that cannot be covered is refused (409).
- No separate "physical on hand" figure: `onHand` is the sellable count; units in paid orders awaiting shipment are not tracked separately.
- The hold is time based only: a customer cannot extend it; a payment in flight keeps the order (and its stock) until it settles or reconciliation expires it.
- The sweep is an in-process timer per instance (safe to run on several; not a distributed scheduler).
