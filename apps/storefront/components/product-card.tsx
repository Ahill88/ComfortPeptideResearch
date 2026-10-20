import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import type { Product } from '../lib/products';
import { ProductPrice, ProductPreviewLabel } from './product-price';
import { AddToCartButton } from './add-to-cart-button';
import { ProductImage } from './product-gallery';

export function ProductCard({ product }: { product: Product }) {
  return <article className="group overflow-hidden rounded-2xl border border-slate-200 bg-white text-[#0B1220] transition-shadow duration-300 hover:shadow-[0_16px_40px_-24px_#64748b]">
    <Link href={`/catalog/${product.slug}`} aria-label={`View ${product.name} details`} className="relative block aspect-square overflow-hidden border-b border-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-4px]">
      <ProductImage product={product} sizes="(min-width: 1440px) 420px, (min-width: 1024px) 30vw, (min-width: 768px) 46vw, 100vw" />
      <span className="absolute left-5 top-5 rounded-full border border-white bg-white/90 px-3 py-1 text-xs font-medium uppercase tracking-[.12em] text-slate-700">Catalog preview</span>
      <span className="absolute bottom-4 left-5 rounded-full bg-white/90 px-2.5 py-1 text-xs uppercase tracking-[.12em] text-slate-700">3D concept render</span>
      <span className="absolute bottom-4 right-4 rounded-full bg-white p-2.5 transition-transform group-hover:-translate-y-1"><ArrowUpRight size={18} aria-hidden="true" /></span>
    </Link>
    <div className="p-6">
      <p className="text-xs uppercase tracking-[.16em] text-slate-600">Research material / {product.sku}</p>
      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-3"><h3 className="text-2xl font-medium tracking-tight"><Link href={`/catalog/${product.slug}`} className="hover:text-slate-600">{product.name}</Link></h3><p className="text-base font-medium tabular-nums"><ProductPrice product={product} /></p></div>
      <p className="mt-3 text-xs leading-5 text-slate-600"><ProductPreviewLabel product={product} /></p>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4"><Link href={`/catalog/${product.slug}`} className="text-xs font-medium underline-offset-4 hover:underline">Explore material</Link><AddToCartButton slug={product.slug} className="rounded-lg bg-[#F1F5F9] px-4 py-2.5 text-xs font-medium transition hover:bg-[#dceaf5]">Add to bag<span className="sr-only"> — {product.name}</span></AddToCartButton></div>
    </div>
  </article>;
}
