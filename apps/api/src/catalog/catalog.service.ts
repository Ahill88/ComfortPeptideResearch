import { Injectable, NotFoundException } from '@nestjs/common';
import { isPublishedCoaRequired, lotsWithPublishedCoa } from '../coa/coa-requirement';
import { PrismaService } from '../prisma.service';

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const products = await this.prisma.product.findMany({ where: { active: true }, include: { lots: true } });
    return this.withCoaState(products);
  }

  async one(slug: string) {
    const product = await this.prisma.product.findUnique({ where: { slug }, include: { lots: true } });
    if (!product) throw new NotFoundException('Product not found');
    return (await this.withCoaState([product]))[0];
  }

  /**
   * Adds `coaPublished` to every lot object (true while the lot has a PUBLISHED COA). With REQUIRE_PUBLISHED_COA=true the `lots`
   * arrays keep only such lots. One shared check (lotsWithPublishedCoa) for the whole response.
   */
  private async withCoaState<P extends { lots: Array<{ code: string }> }>(products: P[]): Promise<Array<Omit<P, 'lots'> & { lots: Array<P['lots'][number] & { coaPublished: boolean }> }>> {
    const published = await lotsWithPublishedCoa(this.prisma, products.flatMap((product) => product.lots.map((lot) => lot.code)));
    const required = isPublishedCoaRequired();
    return products.map((product) => ({
      ...product,
      lots: product.lots.map((lot) => ({ ...lot, coaPublished: published.has(lot.code) })).filter((lot) => !required || lot.coaPublished),
    }));
  }
}
