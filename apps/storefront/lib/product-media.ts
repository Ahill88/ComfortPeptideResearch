export const productImageViews = ['overview', 'detail', 'angle'] as const;
export type ProductImageView = typeof productImageViews[number];

type ProductMedia = {
  // Intended delivery paths are retained even when an asset is not yet supplied.
  intended: Record<ProductImageView, string>;
  sources: Partial<Record<ProductImageView, string>>;
};

function intendedPaths(slug: string): Record<ProductImageView, string> {
  return {
    overview: `/media/products/${slug}-overview.webp`,
    detail: `/media/products/${slug}-detail.webp`,
    angle: `/media/products/${slug}-angle.webp`,
  };
}

// Only register sources after their local files exist. Missing entries resolve
// before rendering, rather than relying on a failed HTTP request / onError.
export const productMedia: Record<string, ProductMedia> = {
  'ghk-cu': { intended: intendedPaths('ghk-cu'), sources: intendedPaths('ghk-cu') },
  'bpc-157': { intended: intendedPaths('bpc-157'), sources: intendedPaths('bpc-157') },
  'tb-500': { intended: intendedPaths('tb-500'), sources: intendedPaths('tb-500') },
  'reta': { intended: intendedPaths('reta'), sources: intendedPaths('reta') },
  'tirz': { intended: intendedPaths('tirz'), sources: intendedPaths('tirz') },
  'semax': { intended: intendedPaths('semax'), sources: intendedPaths('semax') },
  'selank': { intended: intendedPaths('selank'), sources: intendedPaths('selank') },
  'klow': { intended: intendedPaths('klow'), sources: intendedPaths('klow') },
  'ipamorelin': { intended: intendedPaths('ipamorelin'), sources: intendedPaths('ipamorelin') },
  'tesamorelin': { intended: intendedPaths('tesamorelin'), sources: intendedPaths('tesamorelin') },
  'mots-c': { intended: intendedPaths('mots-c'), sources: intendedPaths('mots-c') },
  'nad-plus': { intended: intendedPaths('nad-plus'), sources: intendedPaths('nad-plus') },
  'kpv': { intended: intendedPaths('kpv'), sources: intendedPaths('kpv') },
  'epithalon': { intended: intendedPaths('epithalon'), sources: intendedPaths('epithalon') },
  'thymosin-alpha-1': { intended: intendedPaths('thymosin-alpha-1'), sources: intendedPaths('thymosin-alpha-1') },
  'cjc-1295-ipamorelin': { intended: intendedPaths('cjc-1295-ipamorelin'), sources: intendedPaths('cjc-1295-ipamorelin') },
  'bac-water': { intended: intendedPaths('bac-water'), sources: intendedPaths('bac-water') },
};

export const productMediaFallback = '/media/products/placeholder.svg';

export function resolveProductMedia(slug: string, view: ProductImageView) {
  const source = productMedia[slug]?.sources[view];
  return { src: source ?? productMediaFallback, isFallback: !source };
}
