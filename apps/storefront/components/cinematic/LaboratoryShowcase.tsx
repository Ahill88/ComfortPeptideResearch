import { media } from '../../lib/media';
import { VideoBackground } from './VideoBackground';
import { PremiumButton } from './PremiumButton';

export function LaboratoryShowcase() {
  return <section className="bg-silver p-3 sm:p-6" aria-labelledby="laboratory-title"><div className="relative isolate overflow-hidden bg-midnight text-white">
    <VideoBackground asset={media.laboratory} /><div className="absolute inset-0 bg-gradient-to-r from-midnight/95 via-midnight/80 to-midnight/20" />
    <div className="site-container relative py-20 lg:py-28"><p className="eyebrow mb-6 text-ice">04 / Why Helix &amp; Field</p><h2 id="laboratory-title" className="heading-section max-w-xl">Quality you can<br />trust. Purity you can verify.</h2><p className="mb-8 mt-6 max-w-md text-sm leading-7 text-silver">Every product has a CAS number, a molecular formula, and a lot-specific certificate. Clear specifications. Honest pricing. A straightforward path from catalog to your lab bench.</p><PremiumButton href="/catalog" variant="light">Browse the collection</PremiumButton><p className="mt-16 font-mono text-xs uppercase tracking-widest text-silver">{media.laboratory.caption}</p></div>
  </div></section>;
}
