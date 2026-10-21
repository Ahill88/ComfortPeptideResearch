// FAKE implementation of the PUBLIC COA API in docs/api/coa-contract.md, for storefront UI verification only.
// Plain node:http, no dependencies.  Usage: node tests/coa-ui/fake-coa-api.mjs [port]   (default 3290)
// Every signature, publisher key and explorer link here is FABRICATED: nothing is on any chain.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** A minimal but valid one-page PDF (correct xref offsets). `text` must be plain ASCII without parentheses. */
export function makePdf(text) {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function fakeBase58(seed, length) {
  let out = '';
  let hex = sha256(seed);
  while (out.length < length) { for (let i = 0; i < hex.length && out.length < length; i += 2) out += B58[parseInt(hex.slice(i, i + 2), 16) % 58]; hex = sha256(hex); }
  return out;
}
export const PUBLISHER = fakeBase58('fake-publisher', 44);
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

function anchor(network, kind, lot, version, hash, when, slot) {
  const sig = fakeBase58(`${network}${kind}${lot}${version}`, 88);
  const cluster = network === 'solana-devnet' ? '?cluster=devnet' : '';
  return {
    network, txSignature: sig, slot, blockTime: when,
    memo: `helix-coa:v1:${kind}:${lot}:${version}:${hash}`,
    explorerUrl: `https://explorer.solana.com/tx/${sig}${cluster}`,
  };
}

/** @param spec {lot, version, status, lab, report, tested, method, purity, notes, published, revoked, reason, anchors:{publish?:network, revoke?:network}, label, servedLabel, extra} */
function makeCoa(spec) {
  const served = makePdf(spec.servedLabel ?? spec.label ?? `FAKE COA ${spec.lot} v${spec.version}`);
  const recorded = spec.servedLabel ? makePdf(spec.label ?? `FAKE COA ${spec.lot} v${spec.version}`) : served; // mismatch: record hash is of a different document
  const hash = sha256(recorded);
  const lot = spec.lot;
  const coa = {
    version: spec.version, status: spec.status,
    lab: { name: spec.lab ?? 'Northgate Analytical Labs', reportId: spec.report ?? `NAL-${lot}-${spec.version}` },
    testedAt: spec.tested ?? '2026-09-28', method: spec.method ?? 'HPLC-UV, 220 nm', purityPercent: spec.purity ?? 99.2, notes: spec.notes ?? null,
    file: { name: `${lot}-v${spec.version}.pdf`, sizeBytes: recorded.length, sha256: hash, url: `/v1/public/lots/${lot}/coa/${spec.version}.pdf` },
    publishedAt: spec.published ?? '2026-10-01T14:03:11.000Z', revokedAt: spec.revoked ?? null, revokeReason: spec.reason ?? null,
    anchors: {
      publish: spec.anchors?.publish ? anchor(spec.anchors.publish, 'publish', lot, spec.version, hash, '2026-10-01T14:04:02.000Z', 412_883_190 + spec.version) : null,
      revoke: spec.anchors?.revoke ? anchor(spec.anchors.revoke, 'revoke', lot, spec.version, hash, '2026-10-12T09:30:45.000Z', 413_990_551) : null,
    },
    ...(spec.extra ?? {}),
  };
  return { coa, pdf: served };
}

const GHK = { slug: 'ghk-cu', name: 'GHK-Cu' };
const TB = { slug: 'tb-500', name: 'TB-500' };
const BPC = { slug: 'bpc-157', name: 'BPC-157' };

function build() {
  const lots = new Map(); // code -> { record, pdfs: Map<version, Buffer>, status?: number, raw?: unknown }
  const add = (lotCode, product, status, current, versions) => {
    lots.set(lotCode, { record: { lotCode, product, status, current: current ? current.coa : null, versions: versions.map((v) => v.coa) }, pdfs: new Map(versions.map((v) => [v.coa.version, v.pdf])) });
  };

  // 1. current, confirmed devnet anchor
  { const v1 = makeCoa({ lot: 'HF-GHK-2610A', version: 1, status: 'published', purity: 99.43, anchors: { publish: 'solana-devnet' }, notes: 'Single main peak; no peaks above 0.5% area other than the main peak.' }); add('HF-GHK-2610A', GHK, 'current', v1, [v1]); }
  // 2. current, NOT anchored
  { const v1 = makeCoa({ lot: 'HF-NOANC-2610B', version: 1, status: 'published', purity: 98.7, tested: '2026-10-05', lab: 'Harbor Peptide Testing', method: 'HPLC-UV, 214 nm' }); add('HF-NOANC-2610B', null, 'current', v1, [v1]); }
  // 3. superseded v1 + current v2
  { const v1 = makeCoa({ lot: 'HF-TB5-2609C', version: 1, status: 'superseded', purity: 97.9, tested: '2026-09-02', published: '2026-09-10T10:00:00.000Z', anchors: { publish: 'solana-devnet' } });
    const v2 = makeCoa({ lot: 'HF-TB5-2609C', version: 2, status: 'published', purity: 98.6, tested: '2026-09-22', published: '2026-09-25T16:20:00.000Z', anchors: { publish: 'solana-devnet' }, notes: 'Re-tested after re-integration of the chromatogram.' });
    add('HF-TB5-2609C', TB, 'current', v2, [v2, v1]); }
  // 4. revoked, with reason and a revoke anchor
  { const v1 = makeCoa({ lot: 'HF-REV-2608D', version: 1, status: 'revoked', purity: 96.1, tested: '2026-08-14', published: '2026-08-20T12:00:00.000Z', revoked: '2026-10-12T09:28:00.000Z', reason: 'The lab issued a corrected report: the original purity figure was transcribed incorrectly.', anchors: { publish: 'solana-devnet', revoke: 'solana-devnet' } }); add('HF-REV-2608D', null, 'revoked', null, [v1]); }
  // 5. mainnet-anchored
  { const v1 = makeCoa({ lot: 'HF-MAIN-2610E', version: 1, status: 'published', purity: 99.01, anchors: { publish: 'solana-mainnet' } }); add('HF-MAIN-2610E', GHK, 'current', v1, [v1]); }
  // 6. product inactive -> product null
  { const v1 = makeCoa({ lot: 'HF-ORPH-2607F', version: 1, status: 'published', purity: 99.8, tested: '2026-07-11', anchors: { publish: 'solana-devnet' } }); add('HF-ORPH-2607F', null, 'current', v1, [v1]); }
  // 7. DELIBERATE MISMATCH: the PDF the API serves is not the PDF the record's sha256 describes
  { const v1 = makeCoa({ lot: 'HF-MISMATCH-2610G', version: 1, status: 'published', purity: 99.0, anchors: { publish: 'solana-devnet' }, label: 'FAKE COA ORIGINAL RECORDED DOCUMENT', servedLabel: 'FAKE COA TAMPERED DOCUMENT' }); add('HF-MISMATCH-2610G', null, 'current', v1, [v1]); }
  // 8. hostile text + leaked admin fields: everything must render as inert plain text, extra fields must never appear
  { const v1 = makeCoa({ lot: 'HF-XSS-2610H', version: 1, status: 'published', lab: '<script>window.__pwned=1</script>Evil Labs', report: '"><img src=x onerror=window.__pwned=2>', method: '<b>HPLC</b>', purity: 95, notes: '<img src=x onerror=window.__pwned=3>\njavascript:alert(4)\n\u202Ereversed', anchors: { publish: 'solana-devnet' },
      extra: { createdBy: { name: 'SECRET-ADMIN-NAME' }, internalNote: 'SECRET-INTERNAL-NOTE' } });
    v1.coa.file.storageKey = 'SECRET-STORAGE-KEY';
    add('HF-XSS-2610H', { slug: 'xss', name: '<i>Hostile product</i>' }, 'current', v1, [v1]); }
  // 9. contract violation: status current but no current coa -> the page must say "record unavailable", not crash or show raw data
  { const v1 = makeCoa({ lot: 'HF-BROKEN-1', version: 1, status: 'published' }); const l = { record: { lotCode: 'HF-BROKEN-1', product: null, status: 'current', current: null, versions: [v1.coa] }, pdfs: new Map() }; lots.set('HF-BROKEN-1', l); }
  // 10. API failure
  lots.set('HF-DOWN-1', { status: 500 });
  return lots;
}

const PRODUCTS = {
  'ghk-cu': { slug: 'ghk-cu', name: 'GHK-Cu', lots: [{ code: 'HF-GHK-2610A', coaPublished: true }] },
  'bpc-157': { slug: 'bpc-157', name: 'BPC-157', lots: [{ code: 'HF-DRAFTONLY-1', coaPublished: false }] },
  'tb-500': { slug: 'tb-500', name: 'TB-500', lots: [{ code: 'HF-TB5-2609C', coaPublished: true }] },
};

export function createFakeCoaApi() {
  const lots = build();
  const hashes = []; // every recorded hash -> match
  for (const [code, entry] of lots) for (const v of entry.record?.versions ?? []) hashes.push({ sha: v.file.sha256, lotCode: code, version: v.version, status: v.status });
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'ETag' };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (status, body) => { res.writeHead(status, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': status === 200 ? 'public, max-age=30' : 'no-store' }); res.end(JSON.stringify(body)); };
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, OPTIONS' }); return res.end(); }
    const path = url.pathname.replace(/\/+$/, '');
    let m;
    if (path === '/v1/public/anchor-info') return json(200, { network: 'solana-devnet', publisher: PUBLISHER, memoProgramId: MEMO_PROGRAM, memoFormat: 'helix-coa:v1:<kind>:<lotCode>:<version>:<sha256>', anchoringEnabled: true });
    if ((m = /^\/v1\/public\/lots\/([^/]+)\/coa\/(\d+)\.pdf$/.exec(path))) {
      const pdf = lots.get(decodeURIComponent(m[1]))?.pdfs?.get(Number(m[2]));
      if (!pdf) return json(404, { message: 'Not found.' });
      res.writeHead(200, { ...cors, 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff', ETag: `"${sha256(pdf)}"`, 'Cache-Control': 'public, max-age=300' });
      return res.end(pdf);
    }
    if ((m = /^\/v1\/public\/lots\/([^/]+)$/.exec(path))) {
      const entry = lots.get(decodeURIComponent(m[1]));
      if (!entry) return json(404, { message: 'Lot not found.' });
      if (entry.status) return json(entry.status, { message: 'boom' });
      return json(200, entry.record);
    }
    if ((m = /^\/v1\/public\/coa\/by-hash\/(.+)$/.exec(path))) {
      if (!/^[0-9a-fA-F]{64}$/.test(m[1])) return json(400, { message: 'Malformed hash.' });
      const matches = hashes.filter((h) => h.sha === m[1].toLowerCase()).map(({ lotCode, version, status }) => ({ lotCode, version, status }));
      return json(200, { found: matches.length > 0, matches });
    }
    if ((m = /^\/v1\/products\/([^/]+)$/.exec(path))) {
      const product = PRODUCTS[decodeURIComponent(m[1])];
      return product ? json(200, product) : json(404, { message: 'Product not found.' });
    }
    return json(404, { message: 'Not found.' });
  });
  return { server, lots };
}

export const FIXTURE_LOTS = ['HF-GHK-2610A', 'HF-NOANC-2610B', 'HF-TB5-2609C', 'HF-REV-2608D', 'HF-MAIN-2610E', 'HF-ORPH-2607F', 'HF-MISMATCH-2610G', 'HF-XSS-2610H', 'HF-BROKEN-1', 'HF-DOWN-1'];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? process.env.PORT ?? 3290);
  const { server } = createFakeCoaApi();
  server.listen(port, '127.0.0.1', () => console.log(`fake COA API listening on http://127.0.0.1:${port}/v1`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
