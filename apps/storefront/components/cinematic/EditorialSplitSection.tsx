import { SectionHeading } from './SectionHeading';
import { PremiumButton } from './PremiumButton';
import { ScrollReveal } from './ScrollReveal';

export function EditorialSplitSection() {
  return <section className="section-space bg-white" aria-labelledby="documentation-title"><div className="site-container grid gap-14 lg:grid-cols-2 lg:gap-24">
    <ScrollReveal><SectionHeading id="documentation-title" eyebrow="03 / Documentation" title="Documentation That Supports Your Work."><p>Every product listing links to lot-specific certificates of analysis. Review purity data, analytical methods, and handling information before your research begins — all from the same page.</p></SectionHeading><div className="mt-8"><PremiumButton href="/quality">View our quality standards</PremiumButton></div></ScrollReveal>
    <div className="border border-silver bg-porcelain p-6 sm:p-9"><div className="flex items-center justify-between gap-4 border-b border-silver pb-6"><span className="eyebrow text-slate-500">Document index</span><span className="rounded-full border border-silver px-3 py-1 font-mono text-xs text-slate-600">Coming soon</span></div>
      {[['01', 'Lot-specific COA', 'Available per product'], ['02', 'Analytical methods', 'HPLC / Mass spec verification'], ['03', 'Handling & storage', 'Linked to product details']].map(([number, title, status]) => <div key={number} className="flex gap-5 border-b border-silver py-6"><span className="font-mono text-xs text-slate-500">{number}</span><div><h3 className="text-sm font-medium">{title}</h3><p className="mt-2 text-xs text-slate-500">{status}</p></div></div>)}
      <p className="mt-6 text-xs leading-6 text-slate-500">Certificates of analysis and independent testing results are being added to each product listing. Documentation will be fully available at launch.</p>
    </div>
  </div></section>;
}
