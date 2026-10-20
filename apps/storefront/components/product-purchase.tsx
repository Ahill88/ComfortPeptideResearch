'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { canAddToPreviewCart, getProduct } from '../lib/products';
import { ProductPrice } from './product-price';
import { AddToCartButton } from './add-to-cart-button';

// Mobile/tablet only: a fixed bottom bar keeps the add action reachable while the full purchase card is out of view.
// It hides itself (and leaves the tab order) whenever the in-flow card, the related-products section or the footer is on screen.
function useStickyBarVisible(anchor: React.RefObject<HTMLElement | null>) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const targets = [anchor.current, document.getElementById('related-section'), document.querySelector('footer')].filter((node): node is HTMLElement => Boolean(node));
    if (!targets.length || typeof IntersectionObserver === 'undefined') return;
    const seen = new Map<Element, boolean>();
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => seen.set(entry.target, entry.isIntersecting));
      setVisible(![...seen.values()].some(Boolean));
    });
    targets.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [anchor]);
  return visible;
}

export function ProductPurchase({ slug }: { slug: string }) {
  const [quantity, setQuantity] = useState(1);
  const quantityId = useId();
  const anchor = useRef<HTMLDivElement>(null);
  const barVisible = useStickyBarVisible(anchor);
  const product = getProduct(slug);
  if (!product) return null;
  if (!canAddToPreviewCart(product)) return <p className="mt-6 text-sm text-slate-600">COMING SOON · Price pending. Not available for the preview bag.</p>;
  return <div className="mt-6" ref={anchor}>
    <div className="mb-5 flex items-end justify-between gap-4">
      <div><label htmlFor={quantityId} className="mb-2 block text-xs font-medium text-slate-600">Quantity</label><div className="flex h-12 items-center rounded-lg border border-slate-300 bg-white">
        <button type="button" aria-label="Decrease quantity" disabled={quantity <= 1} onClick={() => setQuantity(quantity - 1)} className="h-full rounded-l-lg px-3 hover:bg-slate-100 disabled:opacity-30"><Minus size={16} /></button>
        <input id={quantityId} type="number" min={1} max={99} step={1} value={quantity} onChange={(event) => { const value = Number(event.target.value); if (Number.isInteger(value)) setQuantity(Math.max(1, Math.min(99, value))); }} className="h-full w-14 border-x border-slate-200 bg-transparent text-center text-sm [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
        <button type="button" aria-label="Increase quantity" disabled={quantity >= 99} onClick={() => setQuantity(quantity + 1)} className="h-full rounded-r-lg px-3 hover:bg-slate-100 disabled:opacity-30"><Plus size={16} /></button>
      </div></div>
      <div className="text-right" aria-live="polite"><p className="text-xs text-slate-600">Item total</p><p className="mt-1 text-2xl font-medium tracking-tight"><ProductPrice product={product} quantity={quantity} /></p></div>
    </div>
    <AddToCartButton slug={slug} quantity={quantity} className="w-full rounded-lg bg-[#0B1220] px-6 py-4 text-sm font-medium text-white transition hover:bg-slate-700">Add to research bag</AddToCartButton>
    <p className="mt-3 text-xs leading-5 text-slate-600">USD. Shipping and any applicable taxes calculated at checkout.</p>
    <div role="group" aria-label="Quick add" aria-hidden={!barVisible} inert={!barVisible} className={`fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 px-5 pb-[max(.75rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-8px_24px_-16px_#0B1220] backdrop-blur transition-transform duration-200 motion-reduce:transition-none lg:hidden ${barVisible ? 'translate-y-0' : 'pointer-events-none translate-y-full'}`}>
      <div className="mx-auto flex max-w-xl items-center gap-4">
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{product.name} <span className="font-normal text-slate-600">· {product.sizeLabel}</span></p><p className="text-sm tabular-nums"><ProductPrice product={product} quantity={quantity} /></p></div>
        <AddToCartButton slug={slug} quantity={quantity} className="min-h-11 shrink-0 rounded-lg bg-[#0B1220] px-5 py-3 text-sm font-medium text-white transition hover:bg-slate-700">Add to bag<span className="sr-only"> — {product.name}, quick add</span></AddToCartButton>
      </div>
    </div>
  </div>;
}
