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
| `STOREFRONT_PUBLIC_URL` | Optional, server-side only, read at request time. Public storefront origin (for example `https://shop.example.com`) used to print verification addresses `<STOREFRONT_PUBLIC_URL>/verify/<lotCode>` on packing slips and on the lot page. Unset or not an http(s) URL: the relative text `/verify/<lotCode>` is shown instead. Never a secret. |

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

## Lots, COAs and products (outside-lab certificates of analysis)

Built to the fixed contract in `docs/api/coa-contract.md` (ADMIN API). The admin app stores nothing: every call is server-side with the session token, like the rest of the console.

| Route | Who | What |
| --- | --- | --- |
| `/lots` | any admin | Lot register: filter by product, search by lot code (GET form, bookmarkable), table (lot code, product, current COA version, COA status chip, anchor chip, released date), **Load more**, **New lot**. Lot code is checked against `^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$` in the browser and again in the server action; a duplicate shows the API's 409 text on the code field. Success opens the new lot. |
| `/lots/[id]` | any admin (OWNER for publish/revoke/retry) | Header (code, product, chips, public page address), **versions newest first** with status, lab, report id, tested date, method, purity %, who uploaded/published/revoked and when, file name/size/**full SHA-256 with Copy**, **Open PDF**, and per-kind **anchor** blocks (status, network, attempts, error text, transaction signature with Copy, explorer link only when the API supplies an `https` `explorerUrl`, memo text with Copy). Upload form, delete draft, publish review, revoke, retry anchor. |
| `/products` | any admin sees; OWNER acts | `GET /admin/catalog/products` with active state, `lotCount`, `publishedCoaLotCount`, **Publish / Unpublish** with a confirm step. The API's 409 (`Product has no lot with a published COA.`) is shown on the product's row; the state is left unchanged. STAFF sees the buttons disabled and why. |
| `/coas/[id]/file` | any admin | Route handler: streams `GET /admin/coas/:id/file` to the browser with the admin session. Always served as `application/pdf`, `inline`, `nosniff`, `no-store`; the token is attached on the server and never reaches the page, URL or response. No session: redirect to sign-in; expired: cleared and redirected. |
| `/lots/[id]/upload` | any admin | Route handler for the multipart upload (a server action is capped at 1 MB and `next.config.ts` is not ours to raise). Same-origin check, live session, then the contract's rules again (PDF magic `%PDF-`, <= 10 MB, fields) before forwarding. The API recomputes the SHA-256. |

**Upload.** Client checks run on file selection: `.pdf` name or type, not empty, <= 10 MB, and the first five bytes must be `%PDF-` (a text file renamed `.pdf` is rejected and not kept selected). Fields: laboratory name, lab report ID, tested-on date (`max` = the earlier of today local and today UTC, so it is never in the future for the API), method (free text with a datalist: HPLC, HPLC-UV, UPLC, LC-MS, LC-MS/MS, GC-MS, NMR, amino acid analysis), purity 0 to 100 with up to two decimals, notes <= 1000. The result is a DRAFT; the API's 400/409 text (for example the same SHA-256 already on that lot) is shown inline.

**Publish (OWNER).** "Review and publish" opens a review step: the honest copy (*Publishing makes this COA public at /verify/<lot code>. The on-chain anchor proves this exact file was recorded unchanged; it does not prove the lab's results.*), a warning when it will supersede the current version, **all entered values beside the PDF link, file name, size and full hash**, and the checkbox *I compared these values with the lab's PDF*. The confirm button stays disabled until the box is ticked and then sends `confirmSha256` (the hash the page holds: the point is the deliberate step). STAFF sees the control disabled with the reason; the server action also refuses a STAFF caller.

**Anchor progress.** After publish, revoke or retry, while any anchor is `PENDING` the lot is re-read every 5 s for at most 2 minutes (an `aria-live` note says so). A `CONFIRMED` or `FAILED` anchor stops it. After 2 minutes the page stops, says the anchor is still pending, and offers **Check again** and (OWNER) **Retry**. **Retry** is also offered for a `FAILED` anchor, and for a first-attempt anchor still `PENDING` more than 2 minutes after the publish/revoke time. If the API recorded no anchor (anchoring disabled or unavailable) the block says so; the COA stays published.

**Revoke (OWNER).** Reason (1 to 500), a review step repeating the reason and the consequences, then confirm. Offered on PUBLISHED and SUPERSEDED versions; whether the API accepts a superseded one is the API's call (its 409 is shown). **Delete draft** is offered on any DRAFT with a confirm; the API allows an owner or the uploader and its 403 message is shown otherwise.

**Packing slip.** Each item line with a lot code prints `<STOREFRONT_PUBLIC_URL>/verify/<encoded lot code>` as plain text under the lot code (relative `/verify/<lot code>` when the variable is unset). The slip stays one A4/Letter page and has no prices. The slip does not know whether a lot has a published COA: the address may show "not found" until it is published.

Verified with the fake API (not the real one): `tests/admin-ui/fake-admin-api.mjs` now also implements the ADMIN COA endpoints with 3 products and 5 lots (published with a CONFIRMED anchor and a superseded version, a PENDING anchor that flips to CONFIRMED about 4 s after the lot is first opened, a FAILED anchor with an error, a revoked COA with both anchors, a DRAFT), hand-parsed multipart, SHA-256 and `%PDF-` validation, owner/staff rules, and controls: `/__control/config` accepts `forceConflict: { lotCreate|upload|publish|revoke|delete|retry|productPublish: true | 'message' }`, `anchorOutcome: confirm|fail|stuck|none`, `retryOutcome`, `anchorDelayMs`, `requirePublishedCoa`; `/__control/coa-state`, `/__control/bulk-lots`, `/__control/set-anchor`. `admin-browser-qa.mjs` drives all of the above (set `QA_VERIFY_BASE` to the `STOREFRONT_PUBLIC_URL` the admin under test was started with; empty when unset).

Not covered by any test here: the real API's behaviour (case sensitivity of lot codes, whether it allows revoking a SUPERSEDED version or retrying a missing anchor, response shape of product publish), an upload against a real 10 MB limit proxy, and PDF rendering inside a real browser tab (headless Chromium here has no PDF viewer; the route's bytes, headers and auth were checked instead).
