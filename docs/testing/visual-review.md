# Visual review and wallet/browser QA — 2026-10-20

## Result

**Full harness run: 289 passed, 0 failed, 2 skipped** (`tests/design/browser-qa.mjs`, 21:19:26–21:22:38 UTC, storefront dev server on `http://localhost:3000`, Chromium headless shell 151, Playwright 1.58.2, viewports 1440×1000 / 390×844 / 768×1000).

- Existing checks: 178 passed, 2 skipped (navigation drawer at 768 and 1440, where desktop navigation is shown).
- New checks added in this pass: **111 passed, 0 failed** (37 per viewport × 3).
- Artifacts: `/var/folders/v9/840n4c810px9_kxb2ntl2xt00000gn/T/opencode/browser-qa-2026-10-20T21-19-26.325Z/` (`results.json` has per-check detail, `noise` classification, and every raw console/HTTP/request event).

**Environment caveat that bounds what these results mean:** the API (`http://localhost:3001`) was **not running** (`apiReachable: false` in `results.json`). The wallet pages were therefore tested only in their service-unavailable state. Nothing here verifies a real balance, deposit, transfer, history list, or the order-creation/authorize/finalized checkout stages. Those paths are untested.

Both dev servers were started for this run (`pnpm --filter @helix-field/storefront dev` on 3000, `pnpm --filter @helix-field/admin dev` on 3002, both returning 200). Another storefront `next dev` (PID 20395, cwd `apps/storefront`) was already listening on port 3003 and was left alone.

## Rerun

From the repository root, with the storefront running:

```sh
QA_BROWSER=/Users/andrewsilva/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell node tests/design/browser-qa.mjs
# new suite only (~1 minute):
QA_SUITE=wallet QA_BROWSER=... node tests/design/browser-qa.mjs
```

Options (`QA_SUITE`, `QA_API_ORIGIN`, `QA_BASE_URL`, `QA_OUTPUT`, ...) are listed in [browser-design-qa.md](./browser-design-qa.md). Exit code is 1 if any check fails.

## What the new suite checks

Per viewport (1440, 390, 768):

| Area | Checks |
| --- | --- |
| Signed out: `/account/wallet`, `/add`, `/send` (3) | Redirects to `/login`; no wallet content shown; no `helix-field-SANDBOX-devnet-wallet:*` key is created in localStorage. |
| Signed out checkout (1) | "Pay with Research Credits" visible with a non-empty cart; clicking it after valid fields shows "Sign in to pay with Research Credits." |
| Signed in (session `{name,email,verified:true,eligible:true,mfaEnabled:false}` under `helix-field-local-preview-session`), each of the 3 wallet pages (6 checks each) | Renders wallet UI or the honest unavailable state; "Sandbox wallet" and "SANDBOX" text present; no horizontal overflow; keyboard focus order; no console/page errors; paid/confirmed wording. |
| Honest-state assertions (API down) | "Wallet service unavailable" visible; no `[data-testid=research-credits]`; no "Actual balance", "Finalized on-chain" or "Updated <time>" text; `Balance not available` placeholder on the dashboard; "Review transfer" and "Get quote" disabled; send page says balance "unknown". |
| `/account/wallet/send` validation (1) | Invalid address shows an error and no "Transfer submitted" state appears. |
| Checkout, signed in (2) | Credits button visible and keyboard-focusable; panel opens and shows "Sandbox wallet", "Wallet service unavailable", "Spendable credits: Not available", disabled "Create order and review authorization"; no overflow; no console/page errors. |
| `/privacy` and `/research` (4 each) | Renders content with an h1; no overflow; focus order; no console/page errors. |
| Review captures (4) | Home, catalog, product (each: no console/page errors) and a populated bag drawer. |

Rules as implemented:

- **Focus order**: Tab through the page; fail if there is a positive tabindex, a hidden focus target, a stop out of DOM order, a stop with no outline or box-shadow, or if the wallet nav stops (Wallet, Add credits, Send funds, Profile) are not reached in that order. Visual-order inversions are recorded in `detail` (none occurred). The Next dev overlay (`nextjs-portal`) is treated as the end of the page; it is not application UI.
- **paid / confirmed**: any `\bpaid\b|\bconfirmed\b` in `main` text fails unless a finalized state ("Deposit finalized", "Payment finalized", a `finalized` badge) is on the page. One allowlist: sentences about *network fees* ("Network fees are paid in SOL…", "The network fee is paid separately…"). They are not payment-status claims. They are reported in each result's `feeStatementsAllowlisted` so they can be challenged. No other occurrences were found, and no finalized state was present.
- **Errors**: page errors, console errors and HTTP >= 400 fail the check. Classified and listed (never silently dropped) in `results.json` `noise`/`events`:
  - `aborted-rsc-prefetch`: `net::ERR_ABORTED` on `?_rsc=` URLs. Seen on `/login?_rsc=…` 2 times (1 legacy, 1 wallet).
  - `api-unreachable-*`: `ERR_CONNECTION_REFUSED` to `localhost:3001` and the matching browser console line "Failed to load resource". 21 console + 21 request events across the wallet pages (poll every 15 s and on load). These are treated as expected **only because** the API was down at start. They would not be excused if the API were reachable.
  - Lazy product images aborted when my capture script navigated away (`ERR_ABORTED`, 6 events at 768). Harness-induced; not an app error.

Harness corrections made during this pass (not app defects): updated stale gallery selectors to the new accessible names (`Enlarge GHK-Cu 3D concept render: <view>`, dialog title `GHK-Cu · 5mg — <view>`); added a single retry when Next dev aborts the first navigation to a freshly compiled route (none were needed in the final run; `retriedNavigations: []`); fixed a capture race where smooth scrolling left home/product "viewport" screenshots mid-scroll.

## Defects and findings

No harness check fails in the final run. Findings below are from reading screenshots and source, and from earlier runs of this session.

### Resolved between runs, but worth knowing

- Earlier runs in this session failed 6 checks per run (images returning HTTP 400 from `/_next/image` for 14 products' `*-overview.webp`: reta, tirz, semax, selank, klow, ipamorelin, tesamorelin, mots-c, nad-plus, kpv, epithalon, thymosin-alpha-1, cjc-1295-ipamorelin, bac-water). `apps/storefront/public/media/products/` went from 11 files to 53 files at about 16:10 local while I was testing; with those files present, product-image and console checks pass. A run that straddled the change (21:09 UTC) gave a mixed result, so it was discarded and the suite re-run. If those images are removed or renamed, `product images load`, `console and uncaught errors` and the new `/catalog` / `/catalog/ghk-cu` capture checks will fail again.

### Not covered / latent

- **Low, latent:** `components/wallet/wallet-dashboard.tsx` (`History`, "Research purchase history") renders "No research purchases **paid** with Research Credits yet." when the history call succeeds and returns no purchases. That would trip the paid-wording rule once the API is up. Not exercised here because the API was down. The harness will catch it on a rerun with the API running.
- **Info:** the 21 console lines from refused API connections are produced by the browser for every failed `fetch`, not by app `console.error`. They will disappear when the API runs. With the API down, the wallet pages emit console errors on every poll; a tester should not read "0 console errors" from this suite as meaning the API path is healthy.

## Visual review

**Method.** I opened PNG files with the image viewer. Opened and assessed:

- 1440: home (full + viewport), catalog (viewport + full), product GHK-Cu (viewport), bag drawer with one item, checkout (full), checkout with Research Credits panel open (full), wallet dashboard (full), add credits (full), send funds with an invalid address (full).
- 390: home (full + viewport), catalog (viewport), product (viewport + full + a crop of the middle), bag drawer, wallet dashboard (viewport + two crops), add credits (crop), checkout credits panel (crop).

**Not opened:** any 768 screenshot, `/privacy`, `/research`, the signed-out redirect captures, 390 send funds, 390 full catalog, 390 full checkout, and failure screenshots. I make no visual claim about those. Screenshots were taken from the `21:16:15Z` wallet-suite run and the `21:12:37Z` full run; the final full run used identical harness code. Full-page captures show the sticky header partway down the page and the Next dev "N" badge. Both are capture artifacts, not production UI. I also measured contrast for a few elements with a script (computed styles). Everything else about contrast below is by eye and marked as such.

Screenshots are reviewed evidence, not pixel-diff baselines.

### What looks good

- Home 1440: strong hierarchy, clear CTAs, vial illustration reads as intentional. Home 390: headline wraps cleanly and CTAs stack; no overflow.
- Product 1440: two-column layout is balanced; price, quantity, and the Add to research bag button are clear.
- Catalog 1440: consistent 3-column grid, 17 cards with images loading, prices and "Catalog preview" badges aligned.
- Wallet pages are honest: "Wallet service unavailable", "--" balance, "Not available", disabled actions, and the sandbox banner are all visible. Nothing looks like a real balance.

### Weak spots

| # | Severity | Page / file | Observation |
| --- | --- | --- | --- |
| 1 | **High** | Product page at 390 / 768 (`app/catalog/[slug]/page.tsx`: left column lines ~17-19, purchase panel ~29-34; `components/product-gallery.tsx` bottom) | On narrow screens the left column (gallery plus the "Material details" accordion) comes before the right column. The `h1` "GHK-Cu", the price card and "Add to research bag" appear about 1,450 px down (roughly 1.7 screens). The first viewport at 390 shows only the image, thumbnails, and a small price/caption with no product name heading and no button. Also the gallery repeats the price and "Preview only" label (`product-gallery.tsx`) that the purchase panel repeats again. Consider putting the title and purchase card before details, or a sticky add-to-bag bar. |
| 2 | Medium | Catalog hero, `app/catalog/page.tsx` ("The catalog.") | Measured contrast: text `rgb(148,163,184)` on `rgb(248,250,252)` is **2.45:1** at 72 px. Large text needs 3:1, so it fails by design choice. It reads as intentional "ghost" styling but is faint. |
| 3 | Medium | Bag drawer and checkout order summary (`components/cart-contents.tsx` line ~12) | The cart thumbnail is the old flat vial icon with a black label block and the caption "ILLUSTRATION". Catalog and product now use the 3D renders. This looks like leftover placeholder art next to the new imagery, and it is the one place a customer sees their chosen item. |
| 4 | Medium | Wallet dashboard 1440 and 390 (`components/wallet/ui.tsx`, `wallet-dashboard.tsx`, `wallet-security.tsx`, `wallet-disclosures.tsx`) | Message repetition buries the page. The sandbox disclosure appears three times (top banner, bottom of the security card, disclosures list). "Wallet service unavailable" appears four times on one screen (top notice, balance card, both history cards). The first fold at 1440 is two amber boxes before any structure. The security card is a dense wall of small text. Merge into one status region and keep a single sandbox statement. |
| 5 | Low-Med | Wallet nav on all three wallet pages (`WalletPageFrame` in `ui.tsx`) | The four pills (Wallet, Add credits, Send funds, Profile) look identical on every page, with no visible current-page state. The dashboard repeats the same actions again in the balance card and a text-link line at the bottom (three places). I did not check for `aria-current`; there is no visible indicator. |
| 6 | Low | Balance card at 1440 and 390 | With no balance the number slot shows `--` as two short grey dashes in a large empty dark block (`text-8xl`). Honest, but looks like a rendering glitch or loading skeleton, not an unavailable state. Show a short text such as "Balance unavailable" at display size instead. |
| 7 | Low | Wallet dashboard 1440 | The Receive card (left) is about 400 px shorter than the Security card (right) and leaves a large empty white area under the address because the grid stretches both. Add credits shows a similar empty block in the Step 2 card; the Send form uses the left ~55% and leaves the right side blank. |
| 8 | Low | Catalog 1440 (`app/catalog/page.tsx`, product media) | All 17 cards use the same vial render with only the cap colour and label name changed. Label text on the vial is tiny and hard to read at card size (e.g. "Thymosin Alpha-1", "CJC-1295 + Ipamorelin"). The set reads as a template and, because all are labelled "3D concept render", as placeholder imagery. The BPC-157 card appears raised in the screenshot; that is the mouse-hover state from the capture, not a defect. |
| 9 | Low | Checkout (`components/checkout-form.tsx`, `components/wallet/credits-checkout.tsx`) | "Order total 42.000000 USDC ($42.00)" prints six decimals, which is noisy. At 390 the panel eyebrow "RESEARCH CREDITS / SOLANA DEVNET SANDBOX" wraps over two lines beside the Close button. The primary black CTA is "Prepare mock devnet payment" and the credits option is an outlined button below a 12 px grey line; the hierarchy is clear but the primary action is the mock one. At 1440 the form column sits left with about 30% blank space on the right. |
| 10 | Low | Small text, site-wide | Many eyebrows are 10 px uppercase with wide tracking, and helper lines are 11-12 px in slate-500. Measured contrast on those samples was 4.55-4.76:1 (passes AA, narrowly), but they are small. Wallet helper text such as "Not yet registered: wallet service unavailable." and the checkout line "Or pay from your own wallet balance…" are hard to read on mobile. |
| 11 | Low | Home 390 | The second hero CTA ("Our Quality Standards") overlays the vial illustration; legible, but the vial is cropped behind the buttons. Carried over from the earlier review. |
| 12 | Info | Bag drawer 1440 | Layout is clean (item, quantity, subtotal, Review checkout, View full bag). About 400 px of empty drawer below the summary; fine for one item. |

### Checks that are NOT visual evidence

Passing "no horizontal overflow", "focus order" and "sandbox label" show the DOM metrics and text are as expected. They do not tell you whether a layout looks good. Items 1-12 are judgement calls from the images I opened, and severity is my own estimate. 768 layouts were checked by the automated checks only; I did not look at them.
