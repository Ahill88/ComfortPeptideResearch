'use client';

import { useState } from 'react';
import Image from 'next/image';
import * as Dialog from '@radix-ui/react-dialog';
import { Expand, X } from 'lucide-react';
import type { Product } from '../lib/products';
import { productImageViews, resolveProductMedia } from '../lib/product-media';
import { ProductPrice, ProductPreviewLabel } from './product-price';

const views = ['Vial overview', 'Label detail', 'Alternate angle'] as const;

// `compact` is for small thumbnails (cart, checkout, drawer): no caption overlay, and `decorative`
// hides the long alt text when the product name is already announced next to the image.
export function ProductImage({ product, view = 0, sizes = '(min-width: 1024px) 44vw, 100vw', compact = false, decorative = false }: { product: Product; view?: number; sizes?: string; compact?: boolean; decorative?: boolean }) {
  const index = Number.isInteger(view) && view >= 0 && view < views.length ? view : 0;
  const media = resolveProductMedia(product.slug, productImageViews[index]);
  return <div className="relative h-full min-h-0 w-full overflow-hidden bg-[#edf0ed]">
    <Image
      src={media.src}
      alt={decorative ? '' : `${product.name} ${product.sizeLabel}: ${media.isFallback ? 'generic synthetic vial illustration standing in for' : 'original 3D concept render,'} ${views[index].toLowerCase()}; not verified product photography`}
      fill
      sizes={sizes}
      quality={90}
      className="object-contain"
    />
    {media.isFallback && !compact && <div className="absolute inset-x-2 bottom-[12%] text-center text-[#0B1220]" aria-hidden="true"><p className="text-[clamp(10px,2vw,20px)] font-semibold">{product.name} · {product.sizeLabel}</p><p className="text-[clamp(7px,1vw,11px)]">Draft preview · 3D concept render</p></div>}
  </div>;
}

export function ProductGallery({ product }: { product: Product }) {
  const [view, setView] = useState(0);
  return <div>
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button type="button" aria-label={`Enlarge ${product.name} 3D concept render: ${views[view]}`} className="relative block aspect-square w-full overflow-hidden rounded-2xl border border-slate-200 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-slate-500 [&>div]:h-full">
          <ProductImage product={product} view={view} />
          <span className="absolute left-4 top-4 rounded-full bg-white/90 px-3 py-1 text-xs font-medium uppercase tracking-[.14em] text-slate-700 sm:left-5 sm:top-5">3D concept / {String(view + 1).padStart(2, '0')}</span>
          <span className="absolute bottom-5 right-5 rounded-full border border-white bg-white/80 p-3"><Expand size={18} aria-hidden="true" /></span>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[80] bg-[#0B1220]/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[90] max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-2xl bg-[#F8FAFC] p-5 text-[#0B1220] shadow-2xl sm:p-8">
          <Dialog.Title className="pr-10 text-xl font-semibold">{product.name} · {product.sizeLabel} — {views[view]}</Dialog.Title>
          <p className="mt-2 text-xs text-slate-600"><ProductPreviewLabel product={product} /></p>
          <p className="mt-2"><ProductPrice product={product} /></p>
          <Dialog.Description className="mt-2 pr-8 text-sm text-slate-600">Original 3D concept renders for this preview catalog. A generic placeholder is shown when a product view is pending. Packaging and contents are not verified by this image.</Dialog.Description>
          <div className="mt-5 h-[min(55dvh,480px)] overflow-hidden rounded-xl"><ProductImage product={product} view={view} /></div>
          <Dialog.Close aria-label="Close enlarged product render" className="absolute right-4 top-4 rounded-full p-2 hover:bg-slate-200 focus-visible:outline focus-visible:outline-2"><X size={20} /></Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    <div className="mt-3 flex gap-3 sm:mt-4" role="group" aria-label="Product image views">
      {views.map((label, index) => <button key={label} type="button" onClick={() => setView(index)} aria-label={`Show ${label.toLowerCase()} for ${product.name}`} aria-pressed={view === index} className={`h-16 w-16 overflow-hidden sm:h-20 sm:w-20 lg:h-24 lg:w-24 rounded-xl border-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 ${view === index ? 'border-[#0B1220]' : 'border-transparent hover:border-slate-400'}`}><div className="pointer-events-none h-full w-full" aria-hidden="true"><ProductImage product={product} view={index} sizes="96px" /></div></button>)}
    </div>
    <p className="mt-3 text-xs leading-5 text-slate-600">Original 3D concept renders, not verified product photography. Select a view or open the image to enlarge.</p>
  </div>;
}
