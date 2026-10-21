# Admin back office (apps/admin)

Operations console for fulfilment. Every page, including the wallet reports, requires a real admin session verified by the API. There is no development bypass (`ADMIN_DEV_SESSION` and `/api/dev-session` are gone).

## Screens

| Route | Who | What |
| --- | --- | --- |
| `/sign-in` | public | Email, password, 6-digit code. Generic `Invalid sign-in.`, the API's 503 text, a "session expired" notice. |
| `/` | any admin | Counts for To pack / Packing / Shipped / Awaiting payment (only what `/admin/orders/counts` provides), links, signed-in admin and role, session expiry. |
| `/orders` | any admin | Fulfilment queue. Tabs with counts (default **To pack** = `PAID`), search by order id or email (`/` focuses it), newest first, **Load more**, refreshes every 30 s while visible. |
| `/orders/[id]` | any admin | Ship-to block with **Copy address**, items with prominent **lot codes**, payment (USDC from `amountAtomic`, 6 decimals; explorer link **only** when `network === 'solana-devnet'`), shipments, timeline oldest first, and the action panel driven strictly by `allowedActions`. |
| `/orders/[id]/packing-slip` | any admin | One-page print layout (A4/Letter): order id, date (UTC), ship-to, items with SKU / lot / qty and a blank pick box, no prices. No research-use wording: the storefront has no shared constant for it, so none is invented. |
| `/team` | OWNER | List, create (temporary password + MFA seed shown once), deactivate with confirm. STAFF sees a 403 page. |
| `/audit` | OWNER | Audit table, `targetType` / `targetId` filters, next-page links. |
| `/account/password` | any admin | Change password. |
| `/wallets/*` | any admin | Unchanged read-only reports (still call `/admin/wallets/*` with `x-admin-token`); only the gate and the page shell changed. |

Order actions: **Start packing** (one click), **Mark shipped** (carrier, tracking number, optional note, then a confirm step that repeats the address and tracking), **Mark delivered**, **Cancel** (awaiting payment only, reason required), **Add note**. Buttons are disabled while a request is in flight and a ref lock stops double submits. After an action the screen shows the API's returned order without a reload. API `400`/`404`/`409` messages are shown inline; after a `409` or `400` the order is re-read so the panel matches reality. 5xx bodies are never shown.

## Session and security model

- `POST /admin/auth/login` is called by a **server action**. The token is stored only in an `httpOnly`, `SameSite=Strict` cookie (`Secure` and `__Host-` prefixed when `NODE_ENV=production`), expiring at the API's `expiresAt`. Browser JavaScript never receives it.
- All API calls carrying it (`Authorization: Bearer`) run on the server (server components and server actions). The browser only talks to the admin app.
- Every page calls `requireSession()`, which verifies the cookie with `GET /admin/auth/me` (memoised per request). No cookie: `/sign-in`. API `401`: the cookie is cleared (`/session/expired`, or directly in an action) and the user lands on `/sign-in?reason=expired`.
- Sign-out calls `POST /admin/auth/logout`, then clears the cookie whatever the outcome.
- State-changing actions are server actions. Each one checks `Origin` against `Host` itself (Next also does), requires a live session, and re-checks the role for OWNER-only actions. `SameSite=Strict` is the second layer.
- No token in URLs, logs, error messages, `localStorage` or `document.cookie`. Role checks in the UI are for display; the API is the authority.
- **Production needs HTTPS** (a reverse proxy is fine): the `Secure` cookie is dropped by browsers over plain http except on localhost.
- **Dev-only caveat:** under `next dev`, Next serialises awaited `cookies()` values into RSC debug payloads, so the cookie value is visible to the browser in the page source. A production build does not do this (checked). Do not use real credentials against a dev server you do not control.

## Configuration

| Variable | Used for |
| --- | --- |
| `API_URL` | API base, already ending in `/v1` (default `http://localhost:3001/v1`). Server-side only. |
| `ADMIN_API_TOKEN` | Only the existing wallet reports (`x-admin-token`). Not used for sign-in. |

Owners are created with the API's `admin:create` CLI (see `docs/api/admin-auth.md`); further admins from `/team`.

## Verifying without the real API

`tests/admin-ui/fake-admin-api.mjs` is an in-memory implementation of the contract (10 orders across all statuses, long and missing addresses, missing lot code, devnet and mainnet payments, owner and staff accounts, TOTP `123456`, password `correct horse battery`) with control endpoints under `/__control` to expire sessions, flip sign-in to 503, fail the orders API, or move an order behind the UI's back to provoke a 409. `tests/admin-ui/admin-browser-qa.mjs` drives the admin with headless Chromium (login, queue, pack/ship/deliver, 409, packing slip + PDF page count, OWNER vs STAFF, expiry, logout, CSRF replay, token-leak scan, contrast and 44px target checks, screenshots).

```sh
PORT=3190 node tests/admin-ui/fake-admin-api.mjs
# in apps/admin, with a separate distDir/copy if another admin dev server is running:
API_URL=http://127.0.0.1:3190/v1 ADMIN_API_TOKEN=fake-wallet-token next start -p 3191   # after `next build`
QA_PROD=1 node tests/admin-ui/admin-browser-qa.mjs          # omit QA_PROD for `next dev`
```

A pass shows the UI follows the contract. It says nothing about the real API.

## Known limits

- A STAFF visit to `/team` or `/audit` renders the 403 page with HTTP 200: Next 15's stable API cannot set a page's status. No data is requested or shown.
- The short order number is the last 8 characters of the id (ids share prefixes). Whether the API's `q` matches that suffix is up to the API.
- No deep-link return after sign-in; `SameSite=Strict` means a link from another site first lands on `/sign-in` if the session is not sent.
- Dates render in the browser's local time (UTC before hydration and on the packing slip).
- No MFA re-enrolment or password reset UI (the API has none).
