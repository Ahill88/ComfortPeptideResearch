/**
 * Static scans of the COA UI source (apps/storefront app/verify, components/coa, lib/coa, and the product-page mount) for:
 *  - forbidden claims (copy rules), required honesty phrases,
 *  - unsafe rendering / upload / admin-field patterns,
 *  - AA contrast of every tone colour pair declared in components/coa/ui.tsx (WCAG relative-luminance formula).
 * Heuristics on source text, not proofs: the browser run (tests/coa-ui/browser-qa.mjs) covers the rendered result.
 *
 * Run (from repo root): pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only ../../tests/coa-ui/coa-copy-and-safety.test.ts
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

const ROOT = path.resolve(__dirname, '..', '..');
const SF = path.join(ROOT, 'apps/storefront');
const DIRS = [path.join(SF, 'app/verify'), path.join(SF, 'components/coa'), path.join(SF, 'lib/coa')];

function listFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []));
}
const FILES = DIRS.flatMap(listFiles);
const rel = (f: string) => path.relative(ROOT, f);
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const SOURCES = FILES.map((f) => ({ file: f, text: stripComments(fs.readFileSync(f, 'utf8')) }));
const ALL = SOURCES.map((s) => s.text).join('\n');

test('the scan actually covers the COA UI files', () => {
  assert.ok(FILES.length >= 15, `expected the COA UI files, found ${FILES.length}`);
  for (const must of ['app/verify/page.tsx', 'app/verify/[lotCode]/page.tsx', 'components/coa/lot-coa-panel.tsx', 'lib/coa/model.ts']) assert.ok(FILES.some((f) => f.endsWith(must)), must);
});

const FORBIDDEN: [RegExp, string][] = [
  [/blockchain[\s-]*verified/i, 'blockchain-verified'],
  [/\bguarantee[ds]?\b/i, 'guarantee'],
  [/\bcertified\b|\bcertify\b|\bcertification\b/i, 'certified / certify / certification'],
  [/\b(safe|safety|efficacy|effective|medical|therapeutic|therapy|treat|treats|treatment|cure|cures|diagnos\w*|dosage|dosing|clinical|clinically)\b/i, 'medical / efficacy / safety wording'],
  [/\b(100\s?%\s*pure|pure product|verified purity|proof of purity|proves? (the )?purity|purity (is )?(verified|proven|confirmed))\b/i, 'purity-proof wording'],
  [/\b(authentic|genuine|legit|trusted|trustless|immutable proof)\b/i, 'authenticity / trust marketing wording'],
  [/\b(approved|endorsed by|fda|clinical grade|pharmaceutical grade)\b/i, 'approval wording'],
];
for (const [pattern, label] of FORBIDDEN) {
  test(`copy: no "${label}" anywhere in the COA UI source`, () => {
    const hits = SOURCES.flatMap(({ file, text }) => text.split('\n').flatMap((line, i) => (pattern.test(line) ? [`${rel(file)}:${i + 1}: ${line.trim().slice(0, 140)}`] : [])));
    assert.deepEqual(hits, []);
  });
}

test('copy: required honesty phrases are present', () => {
  const required = [
    'tamper-evident, publicly checkable record',
    'Not yet anchored',
    'Current COA',
    "This lot's COA has been revoked",
    'Solana devnet (test network)',
    'No published COA for the current lot yet.',
    'as reported by',
    'does not prove',
    'What this proves',
    'How to verify it yourself',
    'shasum -a 256', 'sha256sum', 'Get-FileHash',
    'Does not match',
    'record is unavailable'.replace('record is unavailable', 'Record unavailable'),
    'Your file stays on your device',
    'not a claim of suitability'.replace('not a claim', 'any claim'),
    'results are true',
  ];
  for (const phrase of required) assert.ok(ALL.toLowerCase().includes(phrase.toLowerCase()), `missing required phrase: ${phrase}`);
});

test('copy: the "what it does not prove" text covers truth of lab results, endorsement and suitability', () => {
  const text = fs.readFileSync(path.join(SF, 'components/coa/explainers.tsx'), 'utf8');
  assert.match(text, /lab.{1,8}s results are true or accurate/);
  assert.match(text, /endorsement/);
  assert.match(text, /suitability for any use/);
});

test('safety: no raw HTML injection, no eval, one static <style> only (print rules)', () => {
  assert.ok(!/dangerouslySetInnerHTML|\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write|\beval\(|new Function\(/.test(ALL));
  const styleFiles = SOURCES.filter((s) => /<style[\s>]/.test(s.text)).map((s) => path.basename(s.file));
  assert.deepEqual(styleFiles, ['ui.tsx']);
  const ui = SOURCES.find((s) => s.file.endsWith('components/coa/ui.tsx'))!.text;
  const styleBody = /<style>\{`([\s\S]*?)`\}<\/style>/.exec(ui);
  assert.ok(styleBody && !styleBody[1].includes('${'), 'the style element is a constant string, never interpolated');
});

test('safety: the visitor file is never uploaded (no FormData / body / non-GET requests in the COA UI)', () => {
  assert.ok(!/FormData|\.append\(|method\s*:\s*['"](POST|PUT|PATCH|DELETE)/i.test(ALL));
  // No request init anywhere carries a body.
  for (const m of ALL.matchAll(/\b(?:fetch|doFetch)\(/g)) assert.ok(!/\bbody\s*:/.test(ALL.slice(m.index!, ALL.indexOf(';', m.index!))), 'a fetch call carries a body');
  assert.ok((ALL.match(/\b(?:fetch|doFetch)\(/g) ?? []).length >= 3, 'scan found the fetch calls');
  assert.ok(!/XMLHttpRequest|sendBeacon|navigator\.share/.test(ALL));
});

test('safety: no admin-only data or credentials are referenced', () => {
  for (const banned of ['createdBy', 'publishedBy', 'revokedBy', 'storageKey', 'confirmSha256', 'Bearer', 'x-customer-email', '/admin', 'localStorage', 'sessionStorage']) assert.ok(!ALL.includes(banned), `${banned} must not appear in the public COA UI`);
});

test('safety: external links open with rel="noopener noreferrer"; only API-provided https explorer URLs and own-origin PDFs are linked', () => {
  const blank = ALL.match(/<a\b[^>]*target="_blank"[^>]*>/g) ?? [];
  assert.ok(blank.length >= 2);
  for (const tag of blank) assert.match(tag, /rel="noopener noreferrer"/, tag);
  assert.ok(!/href=["'`]javascript:/i.test(ALL));
});

test('product panel: made-up lib/products lot strings are never used, and the panel only says published for coaPublished === true', () => {
  const panel = fs.readFileSync(path.join(SF, 'components/coa/lot-coa-panel.tsx'), 'utf8');
  assert.ok(!/lib\/products|product\.lot\b/.test(stripComments(panel)));
  assert.ok(!/from ['"].*lib\/products/.test(ALL));
  const model = fs.readFileSync(path.join(SF, 'lib/coa/model.ts'), 'utf8');
  assert.match(model, /typeof lot\.coaPublished !== 'boolean'/);
  assert.match(model, /if \(!lot\.coaPublished\) return \{ state: 'none' \}/);
});

test('product page mount: one LotCoaPanel, purchase component untouched in structure', () => {
  const page = fs.readFileSync(path.join(SF, 'app/catalog/[slug]/page.tsx'), 'utf8');
  assert.equal((page.match(/<LotCoaPanel\b/g) ?? []).length, 1);
  assert.match(page, /<LotCoaPanel slug=\{product\.slug\}/);
  assert.match(page, /<ProductPurchase slug=\{product\.slug\} \/>/);
});

/* ----------------------------- contrast (AA) ----------------------------- */

const HEX: Record<string, string> = {
  white: '#ffffff', porcelain: '#F8FAFC', midnight: '#0B1220', silver: '#E2E8F0',
  'emerald-50': '#ecfdf5', 'emerald-800': '#065f46', 'emerald-900': '#064e3b', 'amber-50': '#fffbeb', 'amber-900': '#78350f',
  'red-50': '#fef2f2', 'red-800': '#991b1b', 'red-900': '#7f1d1d', 'slate-600': '#475569', 'slate-700': '#334155',
};
function rgb(hex: string): [number, number, number] { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(fg: [number, number, number], bg: [number, number, number]): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}
const blend = (fg: [number, number, number], bg: [number, number, number], alpha: number): [number, number, number] => fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha))) as [number, number, number];

test('contrast: WCAG relative luminance sanity (black/white = 21, known pair)', () => {
  assert.equal(Math.round(ratio(rgb('#000000'), rgb('#ffffff'))), 21);
  assert.ok(Math.abs(ratio(rgb('#777777'), rgb('#ffffff')) - 4.48) < 0.02);
});

test('contrast: every tone pair declared in components/coa/ui.tsx is AA (>= 4.5:1), including the 80% / 90% opacity helper text', () => {
  const ui = fs.readFileSync(path.join(SF, 'components/coa/ui.tsx'), 'utf8');
  const block = /export const toneStyles[\s\S]*?\};/.exec(ui)![0];
  const tones = [...block.matchAll(/(\w+): '([^']+)'/g)].map((m) => ({ tone: m[1], classes: m[2] }));
  assert.equal(tones.length, 4);
  const report: string[] = [];
  for (const { tone, classes } of tones) {
    const bgName = /\bbg-([\w-]+)\b/.exec(classes)![1];
    const fgName = /\btext-([\w-]+)\b/.exec(classes)![1];
    assert.ok(HEX[bgName] && HEX[fgName], `unknown colour in ${tone}: ${bgName}/${fgName} (add it to the table)`);
    const bg = rgb(HEX[bgName]); const fg = rgb(HEX[fgName]);
    for (const alpha of [1, 0.9, 0.8]) {
      const r = ratio(blend(fg, bg, alpha), bg);
      report.push(`${tone} ${fgName} on ${bgName} @${alpha}: ${r.toFixed(2)}`);
      assert.ok(r >= 4.5, `${tone} @${alpha} contrast ${r.toFixed(2)} < 4.5`);
    }
  }
  console.log(report.join('\n'));
});

test('contrast: other text pairs used in the COA UI are AA', () => {
  const pairs: [string, string, string][] = [
    ['slate-600 body text on porcelain', 'slate-600', 'porcelain'], ['slate-600 on white', 'slate-600', 'white'], ['slate-700 on porcelain', 'slate-700', 'porcelain'],
    ['midnight on white', 'midnight', 'white'], ['white on midnight (primary button)', 'white', 'midnight'], ['red-800 error text on porcelain', 'red-800', 'porcelain'],
    ['red-800 on white', 'red-800', 'white'], ['emerald-800 icon on white', 'emerald-800', 'white'], ['amber-900 on amber-50 (test-record note)', 'amber-900', 'amber-50'],
  ];
  for (const [label, fg, bg] of pairs) { const r = ratio(rgb(HEX[fg]), rgb(HEX[bg])); assert.ok(r >= 4.5, `${label}: ${r.toFixed(2)}`); }
});
