/**
 * Plain data module (no imports, no side effects) mirroring the storefront preview catalog in
 * apps/storefront/lib/products.ts. It is deliberately NOT imported from the storefront: apps do not import
 * across each other. tests/catalog-db-sync.test.ts fails if the two ever drift (slugs, names, size labels,
 * priceCents, comingSoon / no-price handling, real-vs-draft SKUs).
 *
 *  - priceCents is the storefront's DISCOUNTED price (the price the bag charges), integer cents.
 *    null means "no price yet" (the storefront marks that entry comingSoon). It is never invented.
 *  - sku is the storefront's real SKU where the storefront has one (GHK-Cu, TB-500). Every other product gets an
 *    internal draft SKU `DRAFT-<SLUG-UPPER>` (skuIsDraft: true). A draft SKU is a database uniqueness key only;
 *    it is NOT a supplier or catalog SKU and must never be shown as one.
 *  - sizeLabel is documentation only: Product has no size column, so it is not written to the database.
 */
export type SeedProduct = {
  slug: string;
  name: string;
  sku: string;
  skuIsDraft: boolean;
  priceCents: number | null;
  sizeLabel: string;
  comingSoon: boolean;
};

/** Internal draft SKU. Not a supplier SKU. */
export const draftSku = (slug: string): string => `DRAFT-${slug.toUpperCase()}`;

const priced = (slug: string, name: string, sizeLabel: string, priceCents: number): SeedProduct => ({
  slug, name, sku: draftSku(slug), skuIsDraft: true, priceCents, sizeLabel, comingSoon: false,
});

export const SEED_PRODUCTS: readonly SeedProduct[] = [
  { slug: 'ghk-cu', name: 'GHK-Cu', sku: 'HF-GHK-005', skuIsDraft: false, priceCents: 4200, sizeLabel: '5mg', comingSoon: false },
  priced('bpc-157', 'BPC-157', '10mg', 5400),
  { slug: 'tb-500', name: 'TB-500', sku: 'HF-TB5-005', skuIsDraft: false, priceCents: 5100, sizeLabel: '5mg', comingSoon: false },
  priced('reta', 'Reta', '10mg', 9000),
  priced('tirz', 'Tirz', '10mg', 6300),
  priced('semax', 'Semax', '10mg', 4050),
  priced('selank', 'Selank', '10mg', 4050),
  priced('klow', 'KLOW', '80mg', 12150),
  priced('ipamorelin', 'Ipamorelin', '10mg', 5400),
  priced('tesamorelin', 'Tesamorelin', '10mg', 8100),
  priced('mots-c', 'MOTS-c', '10mg', 4950),
  priced('nad-plus', 'NAD+', '500mg', 7200),
  priced('kpv', 'KPV', '10mg', 4500),
  priced('epithalon', 'Epithalon', '10mg', 4050),
  priced('thymosin-alpha-1', 'Thymosin Alpha-1', '10mg', 7200),
  priced('cjc-1295-ipamorelin', 'CJC-1295 + Ipamorelin', '10mg total', 7200),
  // No price on the storefront. Never orderable: see seed.ts (inactive, priceCents 0, no lot).
  { slug: 'bac-water', name: 'BAC Water', sku: draftSku('bac-water'), skuIsDraft: true, priceCents: null, sizeLabel: '30ml', comingSoon: true },
];

/** Placeholder lot constants. There is NO analytical data behind these values. */
export const PLACEHOLDER_COA_KEY = 'PENDING-NO-COA';
/** purity is a required Decimal(5,2) column; the platform must not invent test results, so 0.00 means "no data". */
export const PLACEHOLDER_PURITY = '0.00';
export const placeholderLotCode = (sku: string): string => `PREVIEW-${sku}`;
