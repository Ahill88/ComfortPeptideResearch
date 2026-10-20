# Integration QA — 2026-10-20

## Result

**Storefront browser: 172 passed, 6 failed, 2 skipped.** Latest full run: 18:40:21–18:43:15 UTC against `http://localhost:3000`, Playwright 1.58.2 with cached Chromium 151.0.7922.34. Viewports: 1440×1000, 390×844, 768×1000.

**Blocking visual issue: product images are missing.** All three widths fail `product images load` and `console and uncaught errors`, accounting for the six failures. The latter now includes HTTP-error responses as well as console errors/page exceptions; raw events preserve each category. The gallery's keyboard behavior passing does not mean its image content is usable.

Evidence at 18:46 UTC:

```sh
curl -i 'http://localhost:3000/_next/image?url=%2Fmedia%2Fproducts%2Fghk-cu-overview.webp&w=640&q=90'
# HTTP 400: The requested resource isn't a valid image.
curl -I http://localhost:3000/media/products/ghk-cu-overview.webp
# HTTP 404
```

`apps/storefront/public/media/products/` contained only `.gitkeep` when inspected. The frontend references overview/detail/angle WebP images for GHK-Cu, BPC-157, and TB-500. Browser network evidence shows optimizer HTTP 400s for all three products. Product detail, thumbnails, related-product cards, and zoom visibly show empty image areas/broken-image indicators. Supplying the referenced media is needed before visual acceptance.

## Checks that passed

- All **25 routes**, including new `/privacy`, rendered successfully with visible main content at all widths. This is route smoke coverage, not proof of authenticated account behavior or missing-order semantics.
- No document horizontal overflow was detected on those routes, populated cart/checkout, or tested drawers/dialog.
- GHK-Cu add, $42/$84 subtotal arithmetic, increase/decrease, reload persistence, removal persistence, and empty checkout.
- Checkout field validation and explicit mock payment preparation.
- Gallery: Tab between view buttons, Enter/Space selection, pressed-state changes, keyboard zoom opening, focus containment in both directions, Escape close, and return focus. The harness waits up to two seconds for Radix's deferred focus restoration rather than asserting synchronously during close cleanup.
- Bag drawer keyboard tests at every width; navigation drawer at 390. Two navigation skips at 768/1440 reflect desktop navigation.
- Computed reduced-motion styles on home/access/catalog/product. This remains a CSS-duration check, not comprehensive JavaScript/canvas motion analysis.

## Visual review

Screenshots were opened and visually inspected, not inferred from successful status codes:

- **1440 home viewport:** clear headline hierarchy, separate left text/right illustration composition, readable CTAs, aligned header.
- **390 home viewport:** heading wraps cleanly, CTAs stack and remain legible. The second CTA overlays the vial illustration; no clipped text or sideways spill was visible.
- **1440 product detail (latest run):** purchase panel and technical details are aligned, but main image, thumbnails, and related-product imagery are visibly broken. This is a visual failure.
- **390 zoom (latest run):** dialog fits within viewport, heading/description and close focus ring are visible; image area instead displays broken-image alt text. This is a visual failure despite functional keyboard controls.
- **390 privacy (latest run):** headings, body copy, contact link, and footer wrap within margins and remain readable.
- **390 prepared checkout (18:35 run):** totals, labelled fields, mock-environment notice, and confirmation are legible. Full-page screenshot was captured after scrolling to submit, so the sticky header appears across the document at the captured scroll position; that capture is not evidence of a permanently misplaced header.
- **768 product detail (18:35 run):** layout stacks without sideways spill, but purchase controls appear below the gallery and technical-details section, requiring substantial scrolling. This is a usability observation, not a failing acceptance assertion.
- **Admin after restart:** clean, centered “Access denied” panel and configuration explanation; no rendering error overlay.

The Next development indicator appears in screenshots and is not production UI. These are reviewed evidence images, not pixel-diff golden files.

## Sequential command checks

Executed in requested order: `pnpm lint`, then `pnpm test`, then `pnpm --filter=@helix-field/storefront build`. Repeated this sequence after observing additional gallery edits during QA.

| Command | Actual result |
| --- | --- |
| `pnpm lint` | Pass: 8/8 package tasks. Latest run: 7 cached, storefront freshly checked. Scripts run TypeScript `tsc --noEmit`. |
| `pnpm test` | Fail: 11 tests, 7 passed, 4 failed. |
| `pnpm --filter=@helix-field/storefront build` | Pass: compiled, type-checked, generated 27/27 static pages, completed optimization/traces. `/privacy` and three product pages appear in build output. |

The four failures are the existing source/schema readiness assertions in `tests/authentication-eligibility.test.ts`, imported by the commerce suite:

1. **Non-production sessions are visibly constrained** — expected development/session-auth source pattern absent.
2. **Account routes require a server-validated session** — expected account/accounts controller pattern absent.
3. **Production startup requires server-backed email verification, password reset, and MFA** — expected production startup fail-closed pattern absent.
4. **Customer eligibility is persisted separately from research-use acknowledgement** — expected eligibility field in `Customer` absent.

These are actual failures of preexisting readiness tests, not newly introduced browser tests. They were not edited, disabled, or reclassified as passes. Seven commerce/payment tests pass. Complete latest test output: `/var/folders/v9/840n4c810px9_kxb2ntl2xt00000gn/T/opencode/qa-integration-tests.log`.

The storefront preview was already running. Its development `.next-dev` output remained available while the authorized storefront build used `.next`.

## API and admin

- `localhost:3001/docs`: HTTP 200, Swagger UI rendered “Helix & Field API” with catalog/order/payment endpoints; no browser console/page errors.
- `/docs-json`: returned OpenAPI 3.0 JSON, title/version and endpoint schemas.
- `/v1/products`: **HTTP 500**. Current process log explicitly reports `PrismaClientInitializationError: Environment variable not found: DATABASE_URL` at `product.findMany()`. Docs availability does not establish database/API readiness.
- Admin initially returned HTTP 500. Old log showed missing generated Next chunks `./916.js` and `./951.js` in `.next/server`.
- Restarted only the identified stale admin server process (PID 52147) and launched `nohup pnpm --filter=@helix-field/admin dev`, logging to the approved temporary directory. No generated-cache deletion or backend source change was necessary.
- After restart, `/` returns 307 to `/sign-in`; that page returns **200**, with no browser console/page errors. It intentionally displays **“Access denied — Operational dashboard access is not configured for this environment.”** `ADMIN_DEV_SESSION` is not enabled. This confirms service recovery, not usable authenticated dashboard access.
- Admin restart log: `/var/folders/v9/840n4c810px9_kxb2ntl2xt00000gn/T/opencode/admin-qa-restart.log`.

## Rerun and evidence

From repository root, with the live services running:

```sh
QA_BROWSER=/Users/andrewsilva/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell node tests/design/browser-qa.mjs
QA_BROWSER=/Users/andrewsilva/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell node tests/design/service-browser-qa.mjs
```

Service harness checks docs rendering and admin sign-in/access-denied rendering, explicitly recording `accessDenied`. It does not authenticate or enable operational access. Setup and environment options for the browser harness are in [browser-design-qa.md](./browser-design-qa.md).

Latest full browser artifacts:

```text
/var/folders/v9/840n4c810px9_kxb2ntl2xt00000gn/T/opencode/browser-qa-2026-10-20T18-40-20.885Z/
```

Latest service screenshots and JSON:

```text
/var/folders/v9/840n4c810px9_kxb2ntl2xt00000gn/T/opencode/service-browser-qa-1792522053522/
```

Earlier integration attempts remain preserved:

- `browser-qa-2026-10-20T18-35-00.096Z`: 174 pass / 1 fail / 2 skip; synchronous zoom-focus assertion at 768 raced deferred restoration (screenshot already showed trigger focus).
- `browser-qa-2026-10-20T18-37-17.188Z`: 168 pass / 7 fail / 2 skip; frontend changed during the run. Captured `ProductIllustration is not defined`, subsequent image 400s, and an obsolete gallery-label selector. Updated selectors for the new accessible image labels and added explicit image loading checks, producing the confirmed six failures in the latest run.

Only `tests/design/**` and `docs/testing/**` were edited for QA. Product media, frontend/backend source/configuration, and unrelated readiness tests were not changed by QA.
