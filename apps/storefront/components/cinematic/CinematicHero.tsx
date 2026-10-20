import { media } from '../../lib/media';
import { PremiumButton } from './PremiumButton';
import { VideoBackground } from './VideoBackground';

export function CinematicHero() {
  return <section className="cinematic-hero relative isolate flex items-center overflow-hidden bg-midnight text-white" aria-labelledby="hero-title">
    <VideoBackground asset={media.hero} priority className="max-md:translate-y-48 max-md:[&>img]:object-[72%_center] max-md:[&>video]:object-[72%_center]" />
    <div className="hero-shade absolute inset-0" />
    <div className="site-container relative z-10 py-24 max-md:self-start max-md:pt-16">
      <p className="eyebrow mb-7 text-ice">Helix &amp; Field / Research materials</p>
      <h1 id="hero-title" className="heading-display max-w-[720px]">Precision in<br />Every Detail.</h1>
      <p className="mt-7 max-w-md text-sm leading-7 text-silver">Research materials, technical specifications, and analytical documentation—presented with clarity.</p>
      <div className="mt-9 flex flex-wrap gap-3"><PremiumButton href="/catalog" variant="light">Explore Research Catalog</PremiumButton><PremiumButton href="/quality" variant="outline">Our Quality Standards</PremiumButton></div>
    </div>
    <div className="site-container absolute inset-x-0 bottom-6 flex flex-wrap justify-between gap-3 border-t border-white/15 pt-4 font-mono text-xs uppercase tracking-widest text-silver"><span>01 / A clearer starting point</span><span>{media.hero.caption}</span></div>
  </section>;
}
