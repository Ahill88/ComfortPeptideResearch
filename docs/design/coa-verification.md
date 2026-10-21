# COA verification pages (storefront)

Public, no-login pages built against the fixed contract in `docs/api/coa-contract.md` (PUBLIC API section).

| Route | What it is |
| --- | --- |
| `/verify` | Lookup landing: lot-code form, in-browser "Verify a file" drop zone, "What this proves / does not", "How to verify it yourself" (publisher address from `/public/anchor-info`). |
| `/verify/[lotCode]` | Server-rendered lot record (shareable, indexable): status banner, lab fields, PDF + SHA-256, anchor block, "Verify this PDF" controls, version history. Unknown or malformed code gives a real 404 with a helpful page; an unreadable API response gives a calm "Record unavailable" page. |
| `/catalog/[slug]` | Mounts `<LotCoaPanel slug>`: reads `lots[0].code` / `lots[0].coaPublished` from `GET /products/:slug` in the browser after render (never blocks the page). |

Code: `apps/storefront/app/verify/**`, `components/coa/**`, `lib/coa/**` (`codes`, `hash`, `model` validators, `status` mapping, `client`).

## Honesty rules the code enforces
- Wording is "tamper-evident, publicly checkable record". It never claims purity, safety, efficacy, endorsement or certification. Lab figures are always labelled "as reported by <lab>". A scan test fails on forbidden phrases.
- The banner is positive ONLY when the lot is `current` and its current COA is `published`. Revoked shows the reason in red with an icon; "Not yet anchored" is neutral, never an error. Status is icon + text + border, never colour alone.
- Devnet anchors are badged "Solana devnet (test network)" with a test-record note; mainnet is not. The API's `explorerUrl` is used as-is (https only is enforced).
- The page recomputes the expected memo from the record and warns if the API's memo disagrees.
- Every response is validated field by field (`lib/coa/model.ts`); only contract fields are copied, so admin-only or extra fields cannot reach the DOM. Anything off-contract renders "Record unavailable". All text is rendered through React (escaped); lot codes and slugs are validated and percent-encoded in URLs; the PDF link must be exactly `/v1/public/lots/<code>/coa/<version>.pdf`.
- Files are hashed with Web Crypto in the browser and never uploaded. Only the 64-hex digest goes to `GET /public/coa/by-hash/:sha256`.
- Data is fetched `no-store`, so a revocation shows on the next load. Server fetches use `API_URL` then `NEXT_PUBLIC_API_URL` then `http://localhost:3001/v1`; links and browser fetches always use `NEXT_PUBLIC_API_URL`.

## Needs from the API (assumptions)
- CORS must allow the storefront origin to GET `/v1/public/**` including the PDF route, otherwise the in-page "Verify this PDF" download button reports it could not download and points the visitor to the file picker. Linking/downloading the PDF does not need CORS.
- A published lot's `product` is null when the product is inactive; the page then shows the lot code only.

## Tests and how to run them
- `tests/coa-ui/fake-coa-api.mjs [port]`: fake PUBLIC API (devnet-anchored, no anchor, superseded history, revoked with reason, mainnet, product null, deliberately mismatched PDF, hostile text with leaked admin fields, contract-violating record, 500). All signatures and keys are fabricated.
- `node tests/run-all.mjs coa-ui`: node unit tests (`coa-lib.test.ts` helpers/validators/client, `coa-copy-and-safety.test.ts` copy scans and WCAG contrast math).
- Browser QA (headless Chromium via playwright): `tests/coa-ui/sync-storefront-copy.sh` copies the storefront to a temp dir (the config hard-codes `.next-dev`, so a copy keeps the :3000 dev server untouched), then run the fake on :3290 and `next dev --port 3291` there with `NEXT_PUBLIC_API_URL=http://127.0.0.1:3290/v1 API_URL=...`, then `node tests/coa-ui/browser-qa.mjs` (and `browser-qa-api-down.mjs` with the fake stopped).
