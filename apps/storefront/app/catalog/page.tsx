import { ProductCard } from '../../components/product-card';
import { products } from '../../lib/products';

export default function Catalog() {
  return <main className="bg-[#F8FAFC] text-[#0B1220]">
    <section className="border-b border-slate-200 bg-[linear-gradient(120deg,#F8FAFC_45%,#e8eff6)]"><div className="mx-auto max-w-[1440px] px-5 py-16 sm:px-8 lg:px-16 lg:py-24">
      <p className="text-xs font-medium uppercase tracking-[.22em] text-slate-600">The research collection / 01</p>
      <div className="mt-7 grid gap-8 md:grid-cols-[1.2fr_.8fr]"><h1 className="text-5xl font-medium leading-[1.05] tracking-[-.055em] sm:text-7xl">A closer look.<br /><span className="text-slate-500">The catalog.</span></h1><div className="max-w-md self-end"><p className="text-base leading-7 text-slate-600">Explore the research material collection, with reference details and a considered view of each listing.</p><p className="mt-5 text-xs leading-5 text-slate-600">Preview catalog. Product records are seed data; documentation and availability are pending verification.</p></div></div>
    </div></section>
    <section aria-label="Research material catalog" className="mx-auto max-w-[1440px] px-5 py-10 sm:px-8 lg:px-16 lg:py-14">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-5"><h2 className="text-sm font-medium">All materials <span className="ml-2 text-slate-600">({String(products.length).padStart(2, '0')})</span></h2><p className="text-xs uppercase tracking-[.16em] text-slate-600">Collection / Preview edition</p></div>
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">{products.map((product) => <ProductCard key={product.slug} product={product} />)}</div>
      <p className="mt-12 border-l-2 border-slate-300 pl-4 text-xs leading-6 text-slate-600">For research use only. Not for human or veterinary use. Review verified material documentation before research use.</p>
    </section>
  </main>;
}
