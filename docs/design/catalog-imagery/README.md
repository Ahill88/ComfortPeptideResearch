# Catalog imagery direction

## Review and recommendation

The catalog is an **Explore** surface. The previous product art was a repeated CSS vial on an identical blue-gray backdrop. It made the materials difficult to distinguish visually and offered no actual detail imagery in the gallery.

Keep the existing editorial typography, neutral layout, pricing, seed-data disclosures, and research-only language. Replace only the product imagery and its presentation.

### Adopted direction: quiet precision

- Original physically rendered glass vials, aluminum closures, printed labels, porcelain display plinths, and soft studio reflections.
- Matched camera position, product scale, and lighting for fair comparison.
- Sage for GHK-Cu, sand for BPC-157, and muted lavender for TB-500. These are visual identifiers, not statements about the material's actual appearance or composition.
- Square compositions preserve the entire product and pedestal without cropping the closure.
- Three distinct camera views per material: overview, label detail, alternate angle. The detail view is a dedicated render rather than an enlarged CSS placeholder.
- Exact typeset names and SKUs; no generative lettering, unsupported quantities, purity numbers, testing seals, or invented certification marks.

## Delivered assets

Nine 2048 × 2048 PNG masters live in `tools/catalog-art/masters/`.
Nine optimized WebP assets live in `apps/storefront/public/media/products/`.
`manifest.json` records dimensions, file sizes, source, and SHA-256 checksums.
The website uses Next Image responsive delivery and local assets rather than external image hotlinks.

`image-collection.jpg` is a review sheet of all nine images.
`helix-field-hq-images.zip` contains the nine full-resolution PNG masters and an image disclosure README.

## Implementation scope

Updated `components/product-gallery.tsx`, `components/product-card.tsx`, and the product-media registry. All nine finished image views are registered; the generic fallback remains available for future missing products.
Catalog cards, detail galleries, thumbnails, enlarged views, and related-product cards share the new imagery. No product specifications, prices, checkout behavior, or backend records were changed.

## Verification

- Passed browser QA at 1440px, 768px, and 390px.
- Verified all three catalog images decode and every product gallery switches to distinct detail and alternate image files.
- Verified enlarged images decode, Escape closes the modal, and the catalog and product layouts have no horizontal overflow.
- No uncaught page errors during the browser checks.
- Storefront TypeScript validation and production build passed.
- Nine optimized 2048px WebP assets total 365,412 bytes, before responsive image delivery.

## Important limitation

These are original 3D **concept packaging renders**, not photographs of verified products. They do not establish packaging, contents, availability, quantity, purity, or test results. This distinction remains visible on the site and within the labels. Replace concepts with approved, lot-appropriate photography when real packaging is available.

## Reproduction

1. Run `python tools/catalog-art/create-labels.py` with Pillow installed.
2. With Blender 4.5 available, run `blender --background --python tools/catalog-art/render.py -- ghk-cu overview --cpu`.
3. Repeat for `ghk-cu`, `bpc-157`, `tb-500` and `overview`, `detail`, `angle`.
4. Run `python tools/catalog-art/optimize.py` with Pillow installed.
5. Run `python tests/design/catalog-imagery.py` with Playwright and Chromium installed, against the local development server.
6. Run `pnpm --dir apps/storefront lint` and `pnpm --dir apps/storefront build`.

The `--cpu` option avoids a Metal-driver abort encountered on the rendering host. The scene is deterministic and editable; source scripts and label art are included in the project.
