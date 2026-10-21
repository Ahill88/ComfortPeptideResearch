/**
 * MANUAL LIVE END-TO-END RUN of the lot COA feature against a RUNNING stack (not part of run-all: the name does not end in .test.ts).
 *
 *   QA_ADMIN_FILE=/path/to/qa-admin.json   # {"password":"...","seed":"BASE32"} of a throwaway OWNER account (never printed)
 *   QA_ADMIN_EMAIL=qa-owner@example.test API=http://localhost:3001/v1 \
 *   pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only ../../tests/coa/live-e2e.run.ts
 *
 * Drives the real HTTP API: login (password + TOTP) -> create lot -> upload a clearly labelled TEST pdf -> publish (hash confirmation)
 * -> wait for the Solana devnet anchor -> verify everything the way an outside party would (public API, hash, chain memo + signer)
 * -> revoke -> confirm the revocation anchor. The PDF states that it is a test fixture and not a laboratory result.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { totpCodeAt } from '../../apps/api/src/admin/auth/credentials';

const apiRequire = createRequire(path.join(__dirname, '../../apps/api/package.json'));
const { Connection } = apiRequire('@solana/web3.js') as typeof import('@solana/web3.js');
const API = (process.env.API ?? 'http://localhost:3001/v1').replace(/\/+$/, '');
const creds = JSON.parse(fs.readFileSync(process.env.QA_ADMIN_FILE!, 'utf8')) as { password: string; seed: string };
const EMAIL = process.env.QA_ADMIN_EMAIL ?? 'qa-owner@example.test';
const LOT = process.env.QA_LOT_CODE ?? 'QA-TEST-LOT-1';
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Array<[string, boolean, string]> = [];
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try { const v = await fn(); results.push([name, true, '']); log('PASS', name); return v; }
  catch (e) { results.push([name, false, (e as Error).message]); log('FAIL', name, '->', (e as Error).message); throw e; }
}
function ok(cond: unknown, message: string): asserts cond { if (!cond) throw new Error(message); }
let token = '';
async function call(method: string, p: string, body?: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(`${API}${p}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...extra }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* binary */ }
  return { status: res.status, json, headers: res.headers };
}
/** A minimal but valid one-page PDF whose text says it is a test fixture. */
function testPdf(stamp: string): Buffer {
  const lines = ['TEST FIXTURE - NOT A LABORATORY REPORT', 'Automated end-to-end test of the Helix & Field COA workflow.', `Fixture id: ${stamp}`, 'No analytical data. Do not rely on this document.'];
  const content = ['BT /F1 14 Tf 50 760 Td 18 TL', ...lines.map((l, i) => `${i === 0 ? '' : 'T* '}(${l.replace(/[()\\]/g, '')}) Tj`), 'ET'].join('\n');
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n'; const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
async function waitFor<T>(what: string, ms: number, fn: () => Promise<T | null>): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(4000); }
  throw new Error(`timed out waiting for ${what}`);
}

(async () => {
  await step('admin login with password + TOTP (real session)', async () => {
    const r = await call('POST', '/admin/auth/login', { email: EMAIL, password: creds.password, totp: totpCodeAt(creds.seed, Date.now()) });
    ok(r.status === 200 && r.json?.token, `login ${r.status} ${JSON.stringify(r.json)}`);
    ok(r.json.admin.role === 'OWNER', 'expected OWNER'); token = r.json.token;
  });
  const info = await step('public anchor-info names the publisher (no auth)', async () => {
    const r = await call('GET', '/public/anchor-info');
    ok(r.status === 200 && r.json.anchoringEnabled === true && r.json.network === 'solana-devnet' && r.json.publisher, JSON.stringify(r.json));
    return r.json as { publisher: string; memoProgramId: string };
  });
  const productId = await step('pick a product and create the lot', async () => {
    const list = await call('GET', '/admin/catalog/products'); ok(list.status === 200 && list.json.items.length, 'no products');
    const product = list.json.items.find((p: any) => p.slug === 'ghk-cu') ?? list.json.items[0];
    const created = await call('POST', '/admin/lots', { productId: product.id, code: LOT });
    ok(created.status === 201 || created.status === 409, `create lot ${created.status} ${JSON.stringify(created.json)}`);
    return product.id as string;
  });
  const lot = await step('look up the lot in the admin register', async () => {
    const r = await call('GET', `/admin/lots?q=${LOT}`); const item = r.json.items.find((i: any) => i.code === LOT); ok(item, 'lot not listed'); return item as { id: string };
  });
  const stamp = `live-${Date.now()}`;
  const pdf = testPdf(stamp); const sha = createHash('sha256').update(pdf).digest('hex');
  const coa = await step('upload the lab PDF + reported fields (draft, hash computed server-side)', async () => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), 'qa-fixture.pdf');
    form.append('labName', 'Helix QA fixture (not a real lab)'); form.append('labReportId', `QA-${stamp}`); form.append('testedAt', new Date().toISOString().slice(0, 10));
    form.append('method', 'TEST FIXTURE'); form.append('purityPercent', '0'); form.append('notes', 'Automated test fixture. Not a real laboratory result.');
    const r = await call('POST', `/admin/lots/${lot.id}/coas`, form);
    ok(r.status === 201, `upload ${r.status} ${JSON.stringify(r.json)}`); ok(r.json.file.sha256 === sha, 'server hash differs from local hash'); ok(r.json.status === 'DRAFT', 'not a draft');
    return r.json as { id: string; version: number };
  });
  await step('a draft is NOT public yet', async () => { const r = await call('GET', `/public/lots/${LOT}`); ok(r.status === 404 || r.json?.current === null || r.json?.current?.version !== coa.version, `draft leaked: ${r.status}`); });
  await step('publishing with the wrong hash is refused', async () => { const r = await call('POST', `/admin/coas/${coa.id}/publish`, { confirmSha256: '0'.repeat(64) }); ok(r.status === 400, `expected 400 got ${r.status}`); });
  await step('publish with the confirmed hash (supersedes any earlier version)', async () => {
    const r = await call('POST', `/admin/coas/${coa.id}/publish`, { confirmSha256: sha }); ok(r.status === 200 && r.json.status === 'PUBLISHED', `publish ${r.status} ${JSON.stringify(r.json)}`);
  });
  const anchor = await step('the PUBLISH anchor is CONFIRMED on Solana devnet (finalized, memo re-read)', async () =>
    waitFor('publish anchor', 180_000, async () => {
      const r = await call('GET', `/admin/lots/${lot.id}`); const a = r.json.coas.find((c: any) => c.id === coa.id)?.anchors?.publish;
      if (a?.status === 'FAILED') throw new Error(`anchor FAILED: ${a.error}`);
      return a?.status === 'CONFIRMED' ? a : null;
    }));
  log('   anchor tx', anchor.txSignature, anchor.explorerUrl);
  const record = await step('PUBLIC record (no auth): current COA, confirmed anchor, correct shape', async () => {
    const r = await call('GET', `/public/lots/${LOT}`); ok(r.status === 200, `public ${r.status}`);
    ok(r.json.status === 'current' && r.json.current.version === coa.version, 'not current'); ok(r.json.current.file.sha256 === sha, 'public hash differs');
    ok(r.json.current.anchors.publish?.txSignature === anchor.txSignature, 'public anchor differs'); ok(!JSON.stringify(r.json).includes(EMAIL), 'admin identity leaked');
    return r.json;
  });
  await step('independent check 1: download the public PDF and hash it myself', async () => {
    const res = await fetch(`${API.replace(/\/v1$/, '')}${record.current.file.url}`); ok(res.status === 200, `pdf ${res.status}`);
    ok(res.headers.get('content-type') === 'application/pdf', 'content type'); const got = createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex'); ok(got === sha, 'downloaded bytes differ');
  });
  await step('independent check 2: by-hash lookup finds this lot and version', async () => {
    const r = await call('GET', `/public/coa/by-hash/${sha.toUpperCase()}`); ok(r.json.found && r.json.matches.some((m: any) => m.lotCode === LOT && m.version === coa.version), JSON.stringify(r.json));
  });
  await step('independent check 3: read the transaction straight from Solana devnet: signer, program and exact memo', async () => {
    const c = new Connection('https://api.devnet.solana.com', 'finalized');
    const tx = await c.getParsedTransaction(anchor.txSignature, { maxSupportedTransactionVersion: 0, commitment: 'finalized' }); ok(tx && !tx.meta?.err, 'tx missing/failed');
    ok(tx.transaction.message.accountKeys[0].pubkey.toBase58() === info.publisher, 'signer is not the published publisher key');
    const memo = tx.transaction.message.instructions.filter((i: any) => i.programId.toBase58() === info.memoProgramId);
    ok(memo.length === 1, `expected one memo instruction, got ${memo.length}`);
    const expected = `helix-coa:v1:publish:${LOT}:${coa.version}:${sha}`; ok((memo[0] as any).parsed === expected, `memo mismatch: ${(memo[0] as any).parsed}`);
  });
  await step('publishing the same document is a 409 for the same lot (duplicate hash)', async () => {
    const form = new FormData(); form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), 'dup.pdf');
    for (const [k, v] of Object.entries({ labName: 'x', labReportId: 'y', testedAt: new Date().toISOString().slice(0, 10), method: 'm', purityPercent: '0' })) form.append(k, v);
    const r = await call('POST', `/admin/lots/${lot.id}/coas`, form); ok(r.status === 409, `expected 409 got ${r.status}`);
  });
  if (process.env.QA_SKIP_REVOKE === '1') { log('SKIP revoke (QA_SKIP_REVOKE=1): the new version stays current'); return; }
  await step('REVOKE with a reason; public record flips to revoked; revoke anchor CONFIRMED', async () => {
    const r = await call('POST', `/admin/coas/${coa.id}/revoke`, { reason: 'QA fixture cleanup' }); ok(r.status === 200 && r.json.status === 'REVOKED', `revoke ${r.status} ${JSON.stringify(r.json)}`);
    const rev = await waitFor('revoke anchor', 180_000, async () => { const g = await call('GET', `/admin/lots/${lot.id}`); const a = g.json.coas.find((c: any) => c.id === coa.id)?.anchors?.revoke; if (a?.status === 'FAILED') throw new Error(a.error); return a?.status === 'CONFIRMED' ? a : null; });
    const pub = await call('GET', `/public/lots/${LOT}`); ok(pub.json.status === 'revoked' && pub.json.current === null, 'public status is not revoked');
    ok(pub.json.versions[0].revokeReason === 'QA fixture cleanup' && pub.json.versions[0].anchors.revoke?.txSignature === rev.txSignature, 'revocation details missing');
    log('   revoke tx', rev.txSignature);
  });
  void productId;
})().then(() => { console.log(`\nLIVE COA E2E: ${results.filter((r) => r[1]).length} passed, ${results.filter((r) => !r[1]).length} failed`); })
  .catch((e) => { console.log(`\nLIVE COA E2E: ${results.filter((r) => r[1]).length} passed, ${results.filter((r) => !r[1]).length} failed (${(e as Error).message})`); process.exit(1); });
