import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, ChevronDown, FileText, Truck } from 'lucide-react';
import { getProduct, products } from '../../../lib/products';
import { ProductPrice, ProductPreviewLabel } from '../../../components/product-price';
import { ProductPurchase } from '../../../components/product-purchase';
import { ProductGallery } from '../../../components/product-gallery';
import { ProductCard } from '../../../components/product-card';
import { LotCoaPanel } from '../../../components/coa/lot-coa-panel';

export function generateStaticParams() { return products.map(({ slug }) => ({ slug })); }

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const product = getProduct((await params).slug);
  if (!product) notFound();
  return <main className="bg-[#F8FAFC] text-[#0B1220]"><div className="mx-auto max-w-[1440px] px-5 py-4 sm:px-8 sm:py-8 lg:px-16 lg:py-12">
    <Link className="mx-auto flex min-h-11 w-full max-w-xl items-center gap-2 lg:max-w-none text-xs text-slate-600 transition hover:text-[#0B1220]" href="/catalog"><ArrowLeft size={14} /> Back to catalog</Link>
    {/* Mobile/tablet order (CSS only): name, gallery, purchase card, description, notes, details. Desktop: gallery + details left, sticky purchase column right. */}
    <div className="mx-auto mt-2 grid max-w-xl items-start gap-y-6 sm:mt-6 lg:mt-8 lg:max-w-none lg:grid-cols-[1.05fr_.95fr] lg:gap-x-16 lg:gap-y-10">
      <div className="order-2 min-w-0 lg:order-none lg:col-start-1 lg:row-start-1"><ProductGallery product={product} /></div>
      <div className="contents lg:block lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:min-w-0 lg:sticky lg:top-28">
        <div className="order-1 min-w-0 lg:order-none">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs uppercase tracking-[.14em] text-slate-600"><span>SKU: {product.sku}</span><span className="rounded-full border border-slate-200 bg-white px-3 py-1.5"><ProductPreviewLabel product={product} /></span></div>
          <h1 id="product-heading" className="mt-3 text-4xl font-medium tracking-[-.05em] sm:text-6xl lg:mt-4">{product.name}</h1>
          <p aria-hidden="true" className="mt-2 text-xl font-medium tracking-tight lg:hidden"><ProductPrice product={product} /></p>
        </div>
        <p className="order-4 min-w-0 max-w-md text-sm leading-6 text-slate-600 lg:order-none lg:mt-5 lg:leading-7">{product.description}</p>
        <div className="order-3 min-w-0 rounded-2xl border border-slate-200 bg-white p-5 sm:p-7 lg:order-none lg:mt-8"><div className="flex items-end justify-between gap-4 border-b border-slate-200 pb-5"><div><p className="text-xs uppercase tracking-[.14em] text-slate-600">Preview price / {product.sizeLabel}</p><p className="mt-2 text-3xl font-medium tracking-tight"><ProductPrice product={product} /></p></div><span className="pb-1 text-xs text-slate-600">USD</span></div><ProductPurchase slug={product.slug} /></div>
        <LotCoaPanel slug={product.slug} className="order-3 min-w-0 lg:order-none lg:mt-4" />
        <div className="order-5 min-w-0 space-y-4 text-xs leading-5 text-slate-600 lg:order-none lg:mt-6"><p className="flex gap-3"><FileText size={17} className="mt-0.5 shrink-0" /><span><strong className="font-medium text-[#0B1220]">Documentation pending</strong><br />Seed-data preview. Specifications and availability are not yet verified.</span></p><p className="flex gap-3"><Truck size={17} className="mt-0.5 shrink-0" /><span><strong className="font-medium text-[#0B1220]">Shipping at checkout</strong><br />Review shipping costs before completing your order.</span></p></div>
        <p className="order-6 min-w-0 border-t border-slate-200 pt-5 text-xs leading-5 text-slate-600 lg:order-none lg:mt-6">For research use only. Not for human or veterinary use.</p>
      </div>
      <section aria-labelledby="technical-heading" className="order-7 min-w-0 lg:order-none lg:col-start-1 lg:row-start-2"><h2 id="technical-heading" className="mb-5 text-xl font-medium tracking-tight">Material details</h2>
        <div className="divide-y divide-slate-200 border-y border-slate-200">
          <details open className="group py-2"><summary className="flex min-h-11 cursor-pointer list-none items-center justify-between [&::-webkit-details-marker]:hidden gap-4 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">Technical reference<ChevronDown size={16} aria-hidden="true" className="shrink-0 text-slate-600 transition-transform group-open:rotate-180" /></summary><p className="mt-4 text-xs leading-5 text-slate-600">Seed-data reference only. Specifications require verification against final material documentation.</p><dl className="mt-4 divide-y divide-slate-100 text-xs">{[['SKU', product.sku], ['CAS number', product.cas], ['Molecular formula', product.formula], ['Molecular weight', product.weight], ['Preview lot reference', product.lot]].map(([label, value]) => <div key={label} className="flex justify-between gap-6 py-3"><dt className="shrink-0 text-slate-600">{label}</dt><dd className="break-all text-right">{value}</dd></div>)}</dl></details>
          <details className="group py-2"><summary className="flex min-h-11 cursor-pointer list-none items-center justify-between [&::-webkit-details-marker]:hidden gap-4 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">Storage & handling<ChevronDown size={16} aria-hidden="true" className="shrink-0 text-slate-600 transition-transform group-open:rotate-180" /></summary><p className="mt-4 text-sm leading-6 text-slate-600">Preview storage reference: {product.storage}</p><p className="mt-3 text-xs leading-5 text-slate-600">Confirm handling requirements against verified documentation before use.</p></details>
          <details className="group py-2"><summary className="flex min-h-11 cursor-pointer list-none items-center justify-between [&::-webkit-details-marker]:hidden gap-4 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">Documentation<ChevronDown size={16} aria-hidden="true" className="shrink-0 text-slate-600 transition-transform group-open:rotate-180" /></summary><p className="mt-4 text-sm leading-6 text-slate-600">Documentation pending. A verified lot record and certificate of analysis are not provided for this preview listing.</p></details>
          <details className="group py-2"><summary className="flex min-h-11 cursor-pointer list-none items-center justify-between [&::-webkit-details-marker]:hidden gap-4 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">Shipping information<ChevronDown size={16} aria-hidden="true" className="shrink-0 text-slate-600 transition-transform group-open:rotate-180" /></summary><p className="mt-4 text-sm leading-6 text-slate-600">Shipping options and costs are shown at checkout. Dispatch timing and transport requirements for this preview material are pending confirmation.</p></details>
        </div>
      </section>
    </div>
    <section id="related-section" aria-labelledby="related-heading" className="mt-20 border-t border-slate-200 pt-10"><div className="mb-7 flex flex-wrap items-center justify-between gap-4"><h2 id="related-heading" className="text-2xl font-medium tracking-tight">Continue exploring</h2><Link href="/catalog" className="inline-flex items-center gap-2 text-xs text-slate-600 hover:text-[#0B1220]">The full collection <ArrowRight size={15} /></Link></div><div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">{products.filter((related) => related.slug !== product.slug).map((related) => <ProductCard key={related.slug} product={related} />)}</div></section>
  </div></main>;
}
