# Catalog pricing regression tests

Run from the repository root using the API's existing ts-node runner:

```sh
pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only ../../tests/catalog-pricing.test.ts
```

The suite uses Node's built-in `node:test` and strict assertions. It requires no new dependencies, database, server, network access, or storefront build. It imports the actual storefront catalog and lookup function, so missing product updates fail rather than being skipped. This standalone command does not require editing the shared test runner.

## Sheet contract

All prices below are integer cents. The selling price must equal exactly 90% of the original, checked with integer multiplication (`selling * 10 === original * 9`).

| Product | Amount | Original | Selling |
| --- | --- | ---: | ---: |
| Reta | 10mg | 10000 | 9000 |
| Tirz | 10mg | 7000 | 6300 |
| Semax | 10mg | 4500 | 4050 |
| Selank | 10mg | 4500 | 4050 |
| KLOW | 80mg | 13500 | 12150 |
| Ipamorelin | 10mg | 6000 | 5400 |
| Tesamorelin | 10mg | 9000 | 8100 |
| MOTS-c | 10mg | 5500 | 4950 |
| NAD+ | 500mg | 8000 | 7200 |
| BPC-157 | 10mg | 6000 | 5400 |
| KPV | 10mg | 5000 | 4500 |
| Epithalon | 10mg | 4500 | 4050 |
| Thymosin Alpha-1 | 10mg | 8000 | 7200 |
| CJC-1295 + Ipamorelin | 10mg total | 8000 | 7200 |
| BAC Water | 30ml | No price | No price |

BAC Water must have `availability: 'comingSoon'`; null or omitted prices are accepted, but zero is not. Each sheet name must occur exactly once. Existing non-sheet products may remain; all catalog slugs must be unique and resolve to their own entry. BPC-157 must retain its existing `bpc-157` route and use the updated amount and prices.

Sheet entries must explicitly default to `publicationStatus: 'draft'`. SKU, scientific specifications, storage, lot, purity, sequence, and COA fields must be absent/null or explicit unknown placeholders. This includes the updated BPC-157 entry, which now uses the shared draft defaults. These assertions catch populated unsupported defaults; they do not establish scientific accuracy or provenance.

## Concurrent implementation

The tests target the inspected storefront schema: `sizeLabel`, `originalPriceCents`, `priceCents`, `publicationStatus`, and `availability`. Names and amounts tolerate whitespace and case only; prices are exact numeric values.

Run again after any further storefront changes. The suite validates the actual imported source against independent sheet fixtures; it does not substitute mock catalog data or skip missing entries.
