import { SectionHeading } from './SectionHeading';
import { PremiumButton } from './PremiumButton';
import { ScrollReveal } from './ScrollReveal';

export function EditorialSplitSection() {
  return <section className="section-space bg-white" aria-labelledby="documentation-title"><div className="site-container grid gap-14 lg:grid-cols-2 lg:gap-24">
    <ScrollReveal><SectionHeading id="documentation-title" eyebrow="03 / Documentation" title="Documentation That Matters."><p>Documentation should inform a decision, not decorate it. Review the material, the relevant lot, and the supporting records before drawing conclusions.</p></SectionHeading><div className="mt-8"><PremiumButton href="/quality">View documentation information</PremiumButton></div></ScrollReveal>
    <div className="border border-silver bg-porcelain p-6 sm:p-9"><div className="flex items-center justify-between gap-4 border-b border-silver pb-6"><span className="eyebrow text-slate-500">Document index</span><span className="rounded-full border border-silver px-3 py-1 font-mono text-xs text-slate-600">Preview only</span></div>
      {[['01', 'Lot-specific certificate', 'Not published here'], ['02', 'Analytical methods & results', 'Not published here'], ['03', 'Handling & storage reference', 'See material details']].map(([number, title, status]) => <div key={number} className="flex gap-5 border-b border-silver py-6"><span className="font-mono text-xs text-slate-500">{number}</span><div><h3 className="text-sm font-medium">{title}</h3><p className="mt-2 text-xs text-slate-500">{status}</p></div></div>)}
      <p className="mt-6 text-xs leading-6 text-slate-500">This index is a placeholder for future supporting records. No certificate, independent testing, or verified purity is represented by this preview.</p>
    </div>
  </div></section>;
}
