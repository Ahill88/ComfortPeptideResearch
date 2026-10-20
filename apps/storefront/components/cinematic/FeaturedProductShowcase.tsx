import { products } from '../../lib/products';
import { ProductPrice, ProductPreviewLabel } from '../product-price';
import { media } from '../../lib/media';
import { PremiumButton } from './PremiumButton';
import { ScrollReveal } from './ScrollReveal';

export function FeaturedProductShowcase() {
  const product = products[0];
  if (!product) return null;

  return <section className="section-space bg-porcelain" aria-labelledby="featured-product-title">
    <div className="site-container grid items-center gap-12 lg:grid-cols-2 lg:gap-24">
      <figure className="relative aspect-square overflow-hidden bg-midnight">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={media.hero.poster} alt="Original 3D concept render of a glass research vial on a porcelain pedestal." loading="lazy" className="h-full w-full object-cover object-[85%_center]" />
        <figcaption className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-midnight to-midnight/80 px-6 py-5 font-mono text-xs uppercase leading-5 tracking-widest text-silver">Original 3D concept render / not verified product photography or packaging</figcaption>
      </figure>
      <ScrollReveal>
        <p className="eyebrow mb-5 text-slate-500">Featured material / {product.sku}</p>
        <h2 id="featured-product-title" className="heading-section">{product.name}</h2>
        <p className="mt-4 text-xs text-slate-500"><ProductPreviewLabel product={product} /></p>
        <p className="mt-6 text-2xl tracking-tight"><ProductPrice product={product} /></p>
        <p className="mt-5 max-w-md text-sm leading-7 text-slate-600">Explore this material’s catalog entry for technical specifications and product details. For laboratory research use only.</p>
        <div className="mt-8"><PremiumButton href={`/catalog/${product.slug}`}>View {product.name} Details</PremiumButton></div>
      </ScrollReveal>
    </div>
  </section>;
}
