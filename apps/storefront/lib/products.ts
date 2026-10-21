export type Product = { slug: string; name: string; sizeLabel: string; originalPriceCents: number | null; publicationStatus: 'draft'; availability: 'available' | 'comingSoon'; sku: string; cas: string; formula: string; weight: string; priceCents: number | null; color: string; description: string; storage: string; lot: string };

// Local preview data only. "available" means eligible for the mock bag, not verified stock.
function draft(slug: string, name: string, sizeLabel: string, originalPriceCents: number | null, priceCents: number | null, description: string): Product {
 return { slug, name, sizeLabel, originalPriceCents, priceCents, publicationStatus: 'draft' as const, availability: priceCents === null ? 'comingSoon' as const : 'available' as const, sku: 'Pending' as const, cas: 'Pending' as const, formula: 'Pending' as const, weight: 'Pending' as const, storage: 'Pending' as const, lot: 'Pending' as const, color: 'bg-[#edf0ed]', description };
}
export const products: Product[] = [
 { slug: 'ghk-cu', name: 'GHK-Cu', sizeLabel: '5mg', originalPriceCents: 4200, publicationStatus: 'draft', availability: 'available', sku: 'HF-GHK-005', cas: '89030-95-5', formula: 'C14H24N6O4', weight: '340.38 g/mol', priceCents: 4200, color: 'bg-[#c6d9d2]', description: 'Copper-binding tripeptide (Gly-His-Lys + Cu) supplied as a lyophilized research material. Studied for its role in tissue remodeling and antioxidant pathways.', storage: 'Store at -20°C, protected from light.', lot: 'HF-0426-GC' },
 draft('bpc-157', 'BPC-157', '10mg', 6000, 5400, 'Body-protective compound (pentadecapeptide) derived from human gastric juice peptide. Investigated in research for its potential role in tissue repair and regenerative pathways.'),
 { slug: 'tb-500', name: 'TB-500', sizeLabel: '5mg', originalPriceCents: 5100, publicationStatus: 'draft', availability: 'available', sku: 'HF-TB5-005', cas: '885340-08-9', formula: 'C212H350N56O78S', weight: '4963.44 g/mol', priceCents: 5100, color: 'bg-[#d2cadd]', description: 'Thymosin beta-4 fragment for qualified research workflows. Studied for its role in cell migration, angiogenesis, and tissue repair processes.', storage: 'Store at -20°C. Avoid repeated freeze-thaw cycles.', lot: 'HF-0426-TB' },
draft('reta', 'Reta', '10mg', 10000, 9000, 'Retatrutide — a triple agonist peptide (GLP-1/GIP/Glucagon) under research for metabolic pathway investigation. Supplied as lyophilized material.'),
draft('tirz', 'Tirz', '10mg', 7000, 6300, 'Tirzepatide — a dual glucose-dependent insulinotropic and glucagon-like peptide-1 receptor agonist. Investigated in research for metabolic and glucose regulation studies.'),
draft('semax', 'Semax', '10mg', 4500, 4050, 'Semax — a synthetic heptapeptide derived from ACTH4-7. Studied in research for its potential neuroprotective and nootropic properties.'),
draft('selank', 'Selank', '10mg', 4500, 4050, 'Selank — a synthetic tetradecapeptide modeled after tuftsin. Investigated in research for anxiolytic and immunomodulatory pathway studies.'),
draft('klow', 'KLOW', '80mg', 13500, 12150, 'KLKW(4-35) — a fragment of collagen type I. Studied in research for its potential role in extracellular matrix and tissue interaction pathways.'),
draft('ipamorelin', 'Ipamorelin', '10mg', 6000, 5400, 'Ipamorelin — a selective growth hormone secretagogue pentapeptide. Investigated in research for GH pathway stimulation studies.'),
draft('tesamorelin', 'Tesamorelin', '10mg', 9000, 8100, 'Tesamorelin — a synthetic analog of growth hormone-releasing factor (1-29). Studied for its role in GH/IGF-1 axis research.'),
draft('mots-c', 'MOTS-c', '10mg', 5500, 4950, 'MOTS-c — a mitochondrial-derived peptide encoded by the MT-TL1 gene. Investigated in research for metabolic regulation and cellular energy pathway studies.'),
draft('nad-plus', 'NAD+', '500mg', 8000, 7200, 'Nicotinamide adenine dinucleotide (NAD+) — a coenzyme central to redox reactions and cellular metabolism. Supplied as research-grade material for in vitro and ex vivo studies.'),
draft('kpv', 'KPV', '10mg', 5000, 4500, 'KPV (Lys-Pro-Val) — the C-terminal tripeptide of alpha-MSH. Studied in research for its anti-inflammatory and antimicrobial pathway investigation.'),
draft('epithalon', 'Epithalon', '10mg', 4500, 4050, 'Epithalon (Epitalon) — a synthetic tetrapeptide (Ser-Ala-Asp-Gly) modeled after epithalamin. Investigated in research for telomerase activation and aging pathway studies.'),
draft('thymosin-alpha-1', 'Thymosin Alpha-1', '10mg', 8000, 7200, 'Thymosin Alpha-1 — a naturally occurring peptide fragment of thymosin beta-4. Studied in research for immune modulation and cell signaling pathway investigation.'),
draft('cjc-1295-ipamorelin', 'CJC-1295 + Ipamorelin', '10mg total', 8000, 7200, 'Combination peptide research material — CJC-1295 (GHRH analog) paired with Ipamorelin (GH secretagogue). Studied for growth hormone pathway research.'),
draft('bac-water', 'BAC Water', '30ml', null, null, 'Bacteriostatic water — sterile solvent for reconstituting lyophilized peptides. For laboratory research use only. Not for injection.'),
];
export const getProduct = (slug: string) => products.find((product) => product.slug === slug);
export function canAddToPreviewCart(product: Product | undefined): product is Product & { priceCents: number } {
 return !!product && product.availability === 'available' && product.priceCents !== null && Number.isInteger(product.priceCents) && product.priceCents > 0;
}
