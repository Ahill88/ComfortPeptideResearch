# Live storefront browser QA

**Latest integration rerun:** see [browser-integration-qa.md](./browser-integration-qa.md). The historical passing baseline below predates the WebP gallery changes; the latest run has confirmed missing-image failures.

## Rerun

Harness: `tests/design/browser-qa.mjs`. Run from the repository root against an already running development server. No build step is required.

The baseline used the existing cached Chromium executable because the Playwright bundled-browser download reached 100% but failed to finish within two timeouts (120 and 240 seconds).

```sh
QA_BROWSER=/Users/andrewsilva/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell node tests/design/browser-qa.mjs
```

Playwright 1.58.2 is installed outside the workspace at `/var/folders/v9/840n4c810px9_kxb2ntl2xt00000gn/T/opencode/browser-qa-tools`. To recreate the tooling if that temporary directory is cleaned:

```sh
ls /var/folders/v9/840n4c810px9_kxb2ntl2xt00000gn/T/opencode
npm install --prefix /var/folders/v9/840n4c810px9_kxb2ntl2xt00000gn/T/opencode/browser-qa-tools --no-audit --no-fund playwright@1.58.2
pnpm dlx playwright@1.58.2 install chromium
node tests/design/browser-qa.mjs
```

The last command uses bundled Chromium; set `QA_BROWSER` as above to reproduce the actual baseline browser. Optional environment variables:

- `QA_BASE_URL`: default `http://localhost:3000`.
- `QA_TOOLS`: external directory containing the installed Playwright package.
- `QA_BROWSER`: explicit Chromium executable.
- `QA_OUTPUT`: artifact directory; keep this under the approved temporary directory. Default is a unique timestamped subdirectory there.
- `QA_SUITE`: `all` (default), `legacy` (original route/cart/gallery/drawer/motion checks only) or `wallet` (new suite only, about 1 minute). See [visual-review.md](./visual-review.md) for the wallet suite's scope and latest results.
- `QA_API_ORIGIN`: default `http://localhost:3001`. The wallet suite probes this origin once at start (`apiReachable` in `results.json`). When it is unreachable the suite asserts the honest "Wallet service unavailable" state and that no balance is rendered; when reachable, those no-balance assertions are skipped, so the API-up path is NOT covered by this suite.

Each run prints its artifact location and writes `results.json`, route screenshots, reduced-motion screenshots, drawer screenshots, and failure screenshots. Failures produce exit code 1. Browser contexts are isolated per viewport and use fresh storage. Cart persistence is checked across full reloads in the same context.

## Actual baseline: 2026-10-20

Run interval: **18:27:28–18:28:54 UTC**. Playwright **1.58.2**, cached Chromium headless shell **151.0.7922.34**, local live storefront. Viewports: **1440×1000**, **390×844**, **768×1000** (CSS pixels; desktop Chromium viewport emulation, not physical mobile devices).

**166 passed, 0 failed, 2 skipped.** The skips are navigation-drawer tests at 768 and 1440, where desktop navigation is displayed. Bag-drawer checks run at all three widths.

Artifacts:

```text
/var/folders/v9/840n4c810px9_kxb2ntl2xt00000gn/T/opencode/browser-qa-2026-10-20T18-27-28.158Z/
```

| Check | Observed result |
| --- | --- |
| Route navigation | All 24 specified routes loaded with a successful HTTP response and visible `main` at all three widths. Final URLs and status codes are in JSON. |
| Horizontal overflow | None detected on those routes, populated cart/checkout, or tested open drawers. Document width tolerance is 1 CSS pixel. |
| Cart add/persistence | Adding GHK-Cu creates quantity 1; full reload retains it and the $42 subtotal. |
| Cart update/persistence | Increase gives quantity 2 and $84; reload retains quantity 2. Decrease returns to 1 and disables further decrement. |
| Removal/persistence | Remove empties the bag; reload retains empty state; checkout displays its empty-bag state. |
| Checkout | Empty submit displays email, address, and research acknowledgement errors. Valid test details plus acknowledgement produce the explicit mock-payment preparation message. |
| Drawer keyboard | Enter opens, focus enters dialog, Tab and Shift+Tab wrap at boundaries, Escape closes, and focus returns to opener. Bag tested at all widths; mobile navigation tested at 390. |
| Reduced motion | On home, access, catalog, and GHK-Cu detail, reduced-motion media query is active and no computed animation/transition duration above 10ms or element smooth-scrolling style remains. Screenshots captured. |
| Console/runtime | Zero browser console errors and zero uncaught page exceptions. |

Routes: `/`, `/access`, `/login`, `/register`, `/forgot-password`, `/reset-password`, `/verify-email`, `/catalog`, `/catalog/ghk-cu`, `/catalog/bpc-157`, `/catalog/tb-500`, `/cart`, `/checkout`, `/account`, `/account/addresses`, `/orders`, `/orders/qa-missing-order`, `/research`, `/quality`, `/about`, `/contact`, `/shipping`, `/returns`, `/terms`.

Two request failures were recorded separately: an aborted Next hot-update request at 1440 and an aborted login RSC request at 390. They did not generate console errors or fail route navigation. Network request failures are evidence in JSON, not assertions in this harness.

Manually inspected the captured 1440 access page and 390 navigation drawer: text and controls are legible; drawer focus outline is visible. Screenshots are evidence, not pixel-diff reference images. Full-page screenshots of fixed drawers also show document content below the viewport-height drawer.

## Service and existing-test inspection

- Storefront: Next development server, `localhost:3000`, process working directory `apps/storefront`.
- API: Node running `apps/api/dist/main`, `localhost:3001`; root probe returns Express JSON HTTP 404. This is a root-path observation, not an API health test.
- Admin: Next server, `localhost:3002`, working directory `apps/admin`; root returned **HTTP 500** at initial inspection and again at 18:29 UTC. This remains a separate observed service issue outside the storefront passing summary.
- Existing `tests/commerce-workflows.test.ts` and its strategy describe mocked service commerce checks; `tests/authentication-eligibility.test.ts` contains source/schema assertions. No existing browser harness was found. These unrelated tests were inspected, not modified or executed.

## Interpretation and boundaries

Frontend edits were active throughout. The initial exploratory run at 18:24 UTC had 147 passes, 12 failures, and 2 skips due to assumptions based on earlier source: root redirect, old checkout placeholders/empty-bag wording, and pre-Radix navigation structure. Those results are retained in `browser-qa-2026-10-20T18-24-23.737Z`; they are superseded by the baseline above after updating harness selectors to the current UI.

This is a live-development baseline, not a frozen integration release. Rerun after integration. Route smoke checks verify rendering, not server authorization, missing-order semantics, or successful account registration/reset flows. Checkout exercises the currently labelled mock flow, not an API order/payment settlement. The motion check inspects computed CSS; it does not prove absence of every JavaScript, canvas, or scroll-triggered animation. The bag keyboard test uses an empty bag; populated cart actions are exercised on `/cart`. No production build was run.
