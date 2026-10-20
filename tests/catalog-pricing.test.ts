import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { products, getProduct } from '../apps/storefront/lib/products';

// Independent transcription of the sheet: amounts are cents, never dollars.
const sheet = [
  ['Reta', '10mg', 10000, 9000],
  ['Tirz', '10mg', 7000, 6300],
  ['Semax', '10mg', 4500, 4050],
  ['Selank', '10mg', 4500, 4050],
  ['KLOW', '80mg', 13500, 12150],
  ['Ipamorelin', '10mg', 6000, 5400],
  ['Tesamorelin', '10mg', 9000, 8100],
  ['MOTS-c', '10mg', 5500, 4950],
  ['NAD+', '500mg', 8000, 7200],
  ['BPC-157', '10mg', 6000, 5400],
  ['KPV', '10mg', 5000, 4500],
  ['Epithalon', '10mg', 4500, 4050],
  ['Thymosin Alpha-1', '10mg', 8000, 7200],
  ['CJC-1295 + Ipamorelin', '10mg total', 8000, 7200],
  ['BAC Water', '30ml', null, null],
] as const;

type CatalogEntry = Record<string, unknown>;
const catalog = products as unknown as CatalogEntry[];
const normalize = (value: unknown) => String(value ?? '').toLowerCase().replace(/\s+/g, '');

function entry(name: string): CatalogEntry {
  const matches = catalog.filter((product) => normalize(product.name) === normalize(name));
  assert.equal(matches.length, 1, `${name}: expected exactly one sheet entry`);
  return matches[0];
}

test('all 15 sheet entries exist once and every catalog slug resolves uniquely', () => {
  assert.equal(sheet.length, 15);
  for (const [name] of sheet) entry(name);
  const slugs = catalog.map((product) => product.slug);
  assert.equal(new Set(slugs).size, slugs.length, 'Duplicate catalog slug');
  for (const product of catalog) {
    assert.equal(typeof product.slug, 'string');
    assert.ok(String(product.slug).trim(), 'Empty catalog slug');
    assert.equal(getProduct(product.slug as string), product);
  }
  assert.equal(entry('BPC-157').slug, 'bpc-157', 'Update the existing BPC-157 route');
});

for (const [name, amount, original, discounted] of sheet) {
  test(`${name}: ${amount}, original ${original}, discounted ${discounted}`, () => {
    const product = entry(name);
    const actualAmount = product.sizeLabel;
    assert.equal(normalize(actualAmount), normalize(amount), `${name}: exact sheet amount (including blend total)`);
    const actualOriginal = product.originalPriceCents;
    const actualDiscounted = product.priceCents;

    if (original === null) {
      assert.ok(actualOriginal == null, 'BAC Water must have no original price, including no zero placeholder');
      assert.ok(actualDiscounted == null, 'BAC Water must have no sale price, including no zero placeholder');
      assert.equal(product.availability, 'comingSoon', 'BAC Water must be coming soon');
      return;
    }

    assert.equal(actualOriginal, original, `${name}: original price in cents`);
    assert.equal(actualDiscounted, discounted, `${name}: discounted selling price in cents`);
    assert.ok(Number.isSafeInteger(actualOriginal));
    assert.ok(Number.isSafeInteger(actualDiscounted));
    // Integer equality avoids floating-point percentage rounding.
    assert.equal((actualDiscounted as number) * 10, (actualOriginal as number) * 9);
  });
}

function isUnknown(value: unknown): boolean {
  return value == null || (typeof value === 'string' && /^(?:\s*|unknown|tbd|pending(?: verification| confirmation)?|not (?:provided|available|specified)|unverified|draft|[—–-])$/i.test(value.trim()));
}

test('sheet entries are drafts with unknown specifications, not invented scientific or lot data', () => {
  for (const [name] of sheet) {
    const product = entry(name);
    assert.equal(product.publicationStatus, 'draft', `${name}: sheet entries must default to draft`);
    for (const key of ['sku', 'cas', 'formula', 'weight', 'storage', 'lot', 'purity', 'sequence', 'coa']) {
      assert.ok(isUnknown(product[key]), `${name}.${key}: sheet provides no verified specification; found ${JSON.stringify(product[key])}`);
    }
  }
});
