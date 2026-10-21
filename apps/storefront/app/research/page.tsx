import type { Metadata } from 'next';
import { MolecularSection } from '../../components/cinematic/MolecularSection';
import { EditorialSplitSection } from '../../components/cinematic/EditorialSplitSection';
import { PremiumButton } from '../../components/cinematic/PremiumButton';
import { ScrollReveal } from '../../components/cinematic/ScrollReveal';

export const metadata: Metadata = { title: 'Our Standards | Helix & Field', description: 'Learn about Helix & Field standards for material verification, purity documentation, and analytical testing. CAS verification, lot-specific COAs, and transparent specifications.' };

const evaluationItems = [
  ['01 / CAS Verification', 'Confirm identity.', 'Every product has a CAS number — a unique chemical identifier. Verify it matches the molecular formula and structure listed. Similar names do not mean the same compound.'],
  ['02 / Purity Documentation', 'Read the COA.', 'A certificate of analysis links a specific lot to its analytical results. Look for HPLC purity percentages, mass spec confirmation, and testing dates. A product name without a COA is incomplete.'],
  ['03 / Proper Context', 'Know the limits.', 'Lab materials serve defined research purposes. Information on our site supports material selection — it is not evidence of clinical use, safety, or efficacy for any application.'],
];

export default function ResearchPage() {
  return <main>
    <section className="section-space bg-midnight text-white"><div className="site-container"><p className="eyebrow mb-8 text-ice">Helix &amp; Field / Our standards</p><h1 className="heading-display max-w-4xl">How we verify<br /><span className="text-silver/70">every product.</span></h1><p className="mt-8 max-w-lg text-base leading-8 text-silver">A transparent look at our approach to material identity, analytical documentation, and the standards that guide every listing in our catalog.</p><p className="eyebrow mt-12 text-silver/60">Editorial standards / Not clinical guidance</p></div></section>
    <MolecularSection />
    <section className="section-space bg-white" aria-labelledby="reading-title"><div className="site-container"><p className="eyebrow mb-5 text-slate-500">Evaluating a research product</p><h2 id="reading-title" className="heading-section max-w-2xl">What to look for.</h2><div className="mt-14 grid gap-10 md:grid-cols-3">
      {evaluationItems.map(([label, title, text]) => <ScrollReveal key={label} className="border-t border-silver pt-6"><p className="eyebrow text-slate-500">{label}</p><h3 className="mb-4 mt-6 text-2xl tracking-tight">{title}</h3><p className="text-sm leading-7 text-slate-600">{text}</p></ScrollReveal>)}
    </div></div></section>
    <EditorialSplitSection />
    <section className="section-space bg-porcelain"><div className="site-container flex flex-wrap items-center justify-between gap-8"><h2 className="heading-section max-w-xl">Explore the collection.</h2><PremiumButton href="/catalog">Browse research peptides</PremiumButton></div></section>
  </main>;
}
