import type { Metadata } from 'next';
import { MolecularSection } from '../../components/cinematic/MolecularSection';
import { EditorialSplitSection } from '../../components/cinematic/EditorialSplitSection';
import { PremiumButton } from '../../components/cinematic/PremiumButton';
import { ScrollReveal } from '../../components/cinematic/ScrollReveal';

export const metadata: Metadata = { title: 'Research Perspective | Helix & Field', description: 'An editorial perspective on material identity, documentation, and the context of laboratory research.' };

export default function ResearchPage() {
  return <main>
    <section className="section-space bg-midnight text-white"><div className="site-container"><p className="eyebrow mb-8 text-ice">Helix &amp; Field / Research perspective</p><h1 className="heading-display max-w-4xl">Better questions.<br /><span className="text-silver/70">Deeper context.</span></h1><p className="mt-8 max-w-lg text-base leading-8 text-silver">A space to consider what a material is, what its documentation can tell us, and where the evidence ends.</p><p className="eyebrow mt-12 text-silver/60">Editorial / Not experimental findings or clinical guidance</p></div></section>
    <MolecularSection />
    <section className="section-space bg-white" aria-labelledby="reading-title"><div className="site-container"><p className="eyebrow mb-5 text-slate-500">Reading a research material</p><h2 id="reading-title" className="heading-section max-w-2xl">Context before conclusions.</h2><div className="mt-14 grid gap-10 md:grid-cols-3">
      {[
        ['01 / Identity', 'Begin with the material.', 'A name is a starting point. Review the stated identity, form, and specifications in the context of the intended laboratory work. Similar names do not establish equivalence.'],
        ['02 / Evidence', 'Read the record closely.', 'A meaningful analytical record links a sample or lot to a method and its results. A number without those details cannot tell the complete story.'],
        ['03 / Interpretation', 'Keep the limits in view.', 'An observation in one experimental setting does not establish an outcome in another. Laboratory materials and editorial information are not evidence of clinical suitability.'],
      ].map(([label, title, text]) => <ScrollReveal key={label} className="border-t border-silver pt-6"><p className="eyebrow text-slate-500">{label}</p><h3 className="mb-4 mt-6 text-2xl tracking-tight">{title}</h3><p className="text-sm leading-7 text-slate-600">{text}</p></ScrollReveal>)}
    </div></div></section>
    <EditorialSplitSection />
    <section className="section-space bg-porcelain"><div className="site-container flex flex-wrap items-center justify-between gap-8"><h2 className="heading-section max-w-xl">Explore with context.</h2><PremiumButton href="/catalog">Browse research materials</PremiumButton></div></section>
  </main>;
}
