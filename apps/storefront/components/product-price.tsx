import type { Product } from '../lib/products';
import { formatUsd } from '../lib/money';

export function ProductPrice({ product, quantity = 1 }: { product: Product; quantity?: number }) {
  if (product.availability === 'comingSoon' || product.priceCents === null) return <span>COMING SOON</span>;
  return <span className="inline-flex flex-wrap items-baseline gap-2 tabular-nums">
    {product.originalPriceCents !== null && product.originalPriceCents > product.priceCents && <del className="text-sm font-normal text-slate-600"><span className="sr-only">Original price </span>{formatUsd(product.originalPriceCents * quantity)}</del>}
    <span><span className="sr-only">Preview price </span>{formatUsd(product.priceCents * quantity)}</span>
  </span>;
}

export function ProductPreviewLabel({ product }: { product: Product }) {
  return <span>{product.sizeLabel} · Unpublished {product.publicationStatus} · Preview only</span>;
}
