import { ProductCard } from '../components/product-card';
import { products } from '../lib/products';
import { CinematicHero } from '../components/cinematic/CinematicHero';
import { SectionHeading } from '../components/cinematic/SectionHeading';
import { PremiumButton } from '../components/cinematic/PremiumButton';
import { MolecularSection } from '../components/cinematic/MolecularSection';
import { EditorialSplitSection } from '../components/cinematic/EditorialSplitSection';
import { LaboratoryShowcase } from '../components/cinematic/LaboratoryShowcase';
import { ScrollReveal } from '../components/cinematic/ScrollReveal';
import { FeaturedProductShowcase } from '../components/cinematic/FeaturedProductShowcase';

export default function Home() {
  return <main>
    <CinematicHero />
    <section className="section-space bg-white" aria-labelledby="collection-title"><div className="site-container">
      <ScrollReveal className="mb-12 flex flex-wrap items-end justify-between gap-8"><SectionHeading id="collection-title" eyebrow="01 / Research collection" title="A focused collection."><p>Research peptides with technical specifications and analytical documentation. For laboratory research use only.</p></SectionHeading><PremiumButton href="/catalog">Browse the catalog</PremiumButton></ScrollReveal>
      <div className="grid gap-6 md:grid-cols-3">{products.slice(0, 3).map((product) => <ProductCard key={product.slug} product={product} />)}</div>
    </div></section>
    <MolecularSection /><FeaturedProductShowcase /><EditorialSplitSection /><LaboratoryShowcase />
    <section className="section-space bg-white"><div className="site-container flex flex-wrap items-center justify-between gap-8"><div><p className="eyebrow mb-4 text-slate-500">Get in touch</p><h2 className="heading-section">Questions about a product?</h2></div><PremiumButton href="/contact">Contact our team</PremiumButton></div></section>
  </main>;
}
