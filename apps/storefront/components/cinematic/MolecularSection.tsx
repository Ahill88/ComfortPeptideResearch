import { media } from '../../lib/media';
import { VideoBackground } from './VideoBackground';
import { SectionHeading } from './SectionHeading';
import { PremiumButton } from './PremiumButton';
import { ScrollReveal } from './ScrollReveal';

export function MolecularSection() {
  return <section className="section-space bg-midnight text-white" aria-labelledby="molecular-title"><div className="site-container grid items-center gap-12 lg:grid-cols-2 lg:gap-24">
    <figure className="relative aspect-square overflow-hidden bg-silver"><VideoBackground asset={media.molecular} /><figcaption className="absolute inset-x-6 bottom-6 border-t border-midnight/15 bg-white/90 px-3 pb-2 pt-3 font-mono text-xs uppercase tracking-widest text-slate-700">{media.molecular.caption}</figcaption></figure>
    <ScrollReveal><SectionHeading id="molecular-title" eyebrow="02 / Research perspective" title="Built Around Scientific Precision."><p>Research begins with curiosity and gains meaning through context. Material identity, experimental design, and the limits of available evidence all belong in the same conversation.</p><p className="mt-4">Our editorial space explores those questions. The visual alongside is an abstract study of connection, not a model of a specific molecule.</p></SectionHeading><div className="mt-8"><PremiumButton href="/research" variant="light">Explore the perspective</PremiumButton></div></ScrollReveal>
  </div></section>;
}
