'use client';

import Link from 'next/link';
import { ArrowRight, Minus, Plus, ShoppingBag, Trash2 } from 'lucide-react';
import { useCart } from './cart-provider';
import { formatUsd } from '../lib/money';
import type { Product } from '../lib/products';
import { ProductPrice, ProductPreviewLabel } from './product-price';
import { ProductImage } from './product-gallery';

// Same media source as catalog cards and the product page (lib/product-media.ts via ProductImage).
export function CartThumbnail({ product }: { product: Product }) {
  return <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl border border-slate-200 bg-[#edf0ed] sm:h-24 sm:w-24"><ProductImage product={product} sizes="96px" compact decorative /></div>;
}

export function CartContents({ compact = false, onNavigate }: { compact?: boolean; onNavigate?: () => void }) {
  const { items, subtotalCents, isReady, updateQuantity, removeItem } = useCart();
  if (!isReady) return <div role="status" className="rounded-2xl bg-slate-50 p-8 text-center text-sm text-slate-600">Loading your research bag…</div>;
  if (!items.length) return <div className="rounded-2xl border border-slate-200 bg-slate-50 px-6 py-12 text-center font-sans text-[#0B1220]"><ShoppingBag className="mx-auto mb-5 text-slate-400" size={30} /><h2 className="text-xl font-medium">Your bag is empty.</h2><p className="mt-2 text-sm text-slate-600">Explore the catalog to select research materials.</p><Link onClick={onNavigate} className="mt-6 inline-flex items-center gap-3 rounded-full bg-[#0B1220] px-6 py-3 text-sm font-medium text-white hover:bg-slate-700" href="/catalog">Explore catalog <ArrowRight size={16} /></Link></div>;
  return <div className="space-y-7 font-sans text-[#0B1220]"><div className="divide-y divide-slate-200">{items.map(({ product, quantity, lineTotalCents }) => <article className={`flex gap-4 py-6 ${compact ? '' : 'sm:gap-6'}`} key={product.slug}>
    <Link href={`/catalog/${product.slug}`} onClick={onNavigate} aria-label={`View ${product.name}`}><CartThumbnail product={product} /></Link><div className="min-w-0 flex-1"><p className="text-xs font-medium uppercase tracking-[.12em] text-slate-600"><ProductPreviewLabel product={product} /></p><div className="mt-1 flex flex-wrap items-baseline justify-between gap-2"><Link onClick={onNavigate} className="text-lg font-semibold tracking-tight hover:text-slate-600" href={`/catalog/${product.slug}`}>{product.name}</Link><p className="text-sm font-medium tabular-nums"><ProductPrice product={product} quantity={quantity} /></p></div><p className="mt-1 text-xs text-slate-600"><ProductPrice product={product} /> each</p><div className="mt-4 flex items-center justify-between gap-3"><div className="flex items-center rounded-full border border-slate-200 bg-white"><button className="grid h-10 w-10 place-items-center rounded-full hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30" type="button" aria-label={`Decrease ${product.name} quantity`} disabled={quantity === 1} onClick={() => updateQuantity(product.slug, quantity - 1)}><Minus size={14} /></button><span className="w-7 text-center text-xs tabular-nums" aria-live="polite" aria-label={`${quantity} ${product.name}`}>{quantity}</span><button className="grid h-10 w-10 place-items-center rounded-full hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30" type="button" aria-label={`Increase ${product.name} quantity`} disabled={quantity >= 99} onClick={() => updateQuantity(product.slug, quantity + 1)}><Plus size={14} /></button></div><button className="grid h-10 w-10 place-items-center rounded-full text-slate-600 hover:bg-slate-100 hover:text-[#0B1220]" type="button" aria-label={`Remove ${product.name}`} onClick={() => removeItem(product.slug)}><Trash2 size={16} /></button></div></div>
  </article>)}</div><div className="rounded-2xl border border-slate-200 bg-slate-50 p-5"><div className="flex justify-between gap-4 text-sm font-medium" aria-live="polite"><span>Materials subtotal</span><span className="tabular-nums">{formatUsd(subtotalCents)}</span></div><p className="mt-3 text-xs leading-5 text-slate-600">USD. Taxes and shipping are not calculated here.</p><Link onClick={onNavigate} className="mt-5 flex items-center justify-between gap-3 rounded-full bg-[#0B1220] px-5 py-3.5 text-sm font-medium text-white transition hover:bg-slate-700" href="/checkout">Review checkout <ArrowRight size={16} /></Link><p className="mt-3 text-center text-xs leading-5 text-slate-600">Preview checkout · mock payments only</p></div></div>;
}
