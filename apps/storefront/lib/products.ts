export type Product = { slug: string; name: string; sku: string; cas: string; formula: string; weight: string; price: number; color: string; description: string; storage: string; lot: string };
export const products: Product[] = [
 { slug: 'ghk-cu', name: 'GHK-Cu', sku: 'HF-GHK-005', cas: '89030-95-5', formula: 'C14H24N6O4', weight: '340.38 g/mol', price: 42, color: 'bg-[#c6d9d2]', description: 'Copper-binding tripeptide supplied as a lyophilized research material.', storage: 'Store at -20°C, protected from light.', lot: 'HF-0426-GC' },
 { slug: 'bpc-157', name: 'BPC-157', sku: 'HF-BPC-005', cas: '137525-51-0', formula: 'C62H98N16O22', weight: '1419.54 g/mol', price: 48, color: 'bg-[#dcd0ba]', description: 'Synthetic pentadecapeptide characterized for laboratory investigation.', storage: 'Store at -20°C, dry and protected from light.', lot: 'HF-0426-BP' },
 { slug: 'tb-500', name: 'TB-500', sku: 'HF-TB5-005', cas: '885340-08-9', formula: 'C212H350N56O78S', weight: '4963.44 g/mol', price: 51, color: 'bg-[#d2cadd]', description: 'Thymosin beta-4 fragment for qualified research workflows.', storage: 'Store at -20°C. Avoid repeated freeze-thaw cycles.', lot: 'HF-0426-TB' }
];
export const getProduct = (slug: string) => products.find((product) => product.slug === slug);
