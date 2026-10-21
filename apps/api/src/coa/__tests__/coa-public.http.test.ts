/** Public COA controller + service over HTTP with an in-memory Prisma double (no database): wiring, headers, conditional GET, query shape. */
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma.service';
import { COA_ANCHOR_INFO } from '../coa-anchor-info';
import { CoaPublicController, etagMatches } from '../coa-public.controller';
import { CoaPublicService } from '../coa-public.service';

const SHA = 'ab'.repeat(32);
const PDF = Buffer.from('%PDF-1.4 double');
const coaRow = (over: Record<string, unknown> = {}) => ({
  id: 'internal-coa-id', lotId: 'internal-lot-id', version: 1, status: 'PUBLISHED', labName: 'Lab', labReportId: 'R1', testedAt: new Date('2026-10-01T00:00:00Z'), method: 'HPLC',
  purityPercent: { toNumber: () => 98.5 }, notes: null, fileName: 'a.pdf', fileSize: PDF.length, fileSha256: SHA, createdByAdminId: 'internal-admin', createdAt: new Date(), publishedByAdminId: 'internal-admin',
  publishedAt: new Date('2026-10-02T00:00:00Z'), revokedByAdminId: null, revokedAt: null, revokeReason: null, anchors: [], ...over,
});

const queries: Array<{ model: string; method: string; args: any }> = [];
let lot: any = null;
let pdfRow: any = null;
let loads = 0;
const prismaDouble = {
  lot: { findUnique: async (args: any) => (queries.push({ model: 'lot', method: 'findUnique', args }), lot) },
  coa: {
    findFirst: async (args: any) => (queries.push({ model: 'coa', method: 'findFirst', args }), pdfRow),
    findMany: async (args: any) => (queries.push({ model: 'coa', method: 'findMany', args }), [{ version: 3, status: 'REVOKED', lot: { code: 'LOT-9' } }, { version: 1, status: 'PUBLISHED', lot: { code: 'LOT-9' } }]),
  },
  coaFile: { findUnique: async () => (loads += 1, { bytes: PDF }) },
};

let app: INestApplication;
let base = '';
let defaultApp: INestApplication;
let defaultBase = '';
const boot = async (providers: any[]) => {
  const moduleRef = await Test.createTestingModule({ controllers: [CoaPublicController], providers: [CoaPublicService, { provide: PrismaService, useValue: prismaDouble }, ...providers] }).compile();
  const instance = moduleRef.createNestApplication({ logger: false });
  instance.setGlobalPrefix('v1');
  await instance.listen(0, '127.0.0.1');
  return { instance, root: (await instance.getUrl()).replace('[::1]', '127.0.0.1') };
};
before(async () => {
  ({ instance: app, root: base } = await boot([{ provide: COA_ANCHOR_INFO, useValue: { network: 'solana-mainnet', publisher: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', anchoringEnabled: true, extra: 'ignored', privateKey: 'must-not-leak' } }]));
  ({ instance: defaultApp, root: defaultBase } = await boot([]));
});
after(async () => {
  await app?.close();
  await defaultApp?.close();
});
const get = async (path: string, headers: Record<string, string> = {}, root = base) => {
  const res = await fetch(`${root}${path}`, { headers });
  return { status: res.status, headers: res.headers, text: await res.text() };
};

test('lot record: the Prisma query only ever asks for non-draft coas and CONFIRMED anchors; response carries no internal ids', async () => {
  lot = { code: 'LOT-1', product: { slug: 'p', name: 'P', active: true }, coas: [coaRow()] };
  queries.length = 0;
  const res = await get('/v1/public/lots/LOT-1');
  assert.equal(res.status, 200);
  const args = queries[0].args;
  assert.deepEqual(args.select.coas.where, { status: { in: ['PUBLISHED', 'SUPERSEDED', 'REVOKED'] } });
  assert.deepEqual(args.select.coas.select.anchors.where, { status: 'CONFIRMED' });
  assert.ok(!JSON.stringify(args).includes('DRAFT'));
  assert.ok(!JSON.stringify(args).includes('"file"'), 'file bytes are never selected for the record');
  for (const leaked of ['internal-coa-id', 'internal-lot-id', 'internal-admin', 'createdBy']) assert.ok(!res.text.includes(leaked), leaked);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=30');
});

test('lot record 404 when the lot is missing or has no public coa; malformed codes never reach the database', async () => {
  queries.length = 0;
  lot = null;
  assert.equal((await get('/v1/public/lots/NOPE-1')).status, 404);
  lot = { code: 'LOT-2', product: { slug: 'p', name: 'P', active: true }, coas: [] };
  const res = await get('/v1/public/lots/LOT-2');
  assert.equal(res.status, 404);
  assert.equal(JSON.parse(res.text).message, 'Lot not found.');
  const before = queries.length;
  for (const bad of ['a', 'a%3Ab', 'x'.repeat(70), '-bad']) assert.equal((await get(`/v1/public/lots/${bad}`)).status, 404, bad);
  assert.equal(queries.length, before);
});

test('PDF: a conditional GET is answered from metadata and never loads the file bytes', async () => {
  pdfRow = { id: 'c1', fileSha256: SHA, fileSize: PDF.length };
  loads = 0;
  queries.length = 0;
  const ok = await get('/v1/public/lots/LOT-1/coa/1.pdf');
  assert.equal(ok.status, 200);
  assert.equal(ok.text, PDF.toString());
  assert.equal(loads, 1);
  assert.deepEqual(queries[0].args.where, { version: 1, status: { in: ['PUBLISHED', 'SUPERSEDED', 'REVOKED'] }, lot: { code: 'LOT-1' } });
  const notModified = await get('/v1/public/lots/LOT-1/coa/1.pdf', { 'if-none-match': `"${SHA}"` });
  assert.equal(notModified.status, 304);
  assert.equal(loads, 1, 'no bytes read for a 304');
  pdfRow = null;
  assert.equal((await get('/v1/public/lots/LOT-1/coa/1.pdf')).status, 404);
  const before = queries.length;
  for (const version of ['0', '00', '1a', '-1', '1.5', '9999999999']) assert.equal((await get(`/v1/public/lots/LOT-1/coa/${version}.pdf`)).status, 404, version);
  assert.equal(queries.length, before, 'bad version numbers do not hit the database');
});

test('etagMatches: quoted, weak, list, wildcard and bare forms; mismatches and absence do not match', () => {
  assert.ok(etagMatches(`"${SHA}"`, SHA));
  assert.ok(etagMatches(`W/"${SHA}"`, SHA));
  assert.ok(etagMatches(`"x", "${SHA}"`, SHA));
  assert.ok(etagMatches('*', SHA));
  assert.ok(etagMatches(SHA, SHA));
  assert.ok(!etagMatches('"other"', SHA));
  assert.ok(!etagMatches(`"${SHA}x"`, SHA));
  assert.ok(!etagMatches(undefined, SHA));
  assert.ok(!etagMatches('', SHA));
});

test('by-hash validates before querying, lower-cases the hash, never asks for drafts and caps the result set', async () => {
  queries.length = 0;
  assert.equal((await get('/v1/public/coa/by-hash/xyz')).status, 400);
  assert.equal(queries.length, 0);
  const res = await get(`/v1/public/coa/by-hash/${SHA.toUpperCase()}`);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.text), { found: true, matches: [{ lotCode: 'LOT-9', version: 3, status: 'revoked' }, { lotCode: 'LOT-9', version: 1, status: 'published' }] });
  const args = queries[0].args;
  assert.equal(args.where.fileSha256, SHA);
  assert.deepEqual(args.where.status, { in: ['PUBLISHED', 'SUPERSEDED', 'REVOKED'] });
  assert.equal(args.take, 50);
});

test('anchor-info: values are re-validated and only the contract fields are served; the default is anchoring off', async () => {
  const bound = await get('/v1/public/anchor-info');
  assert.equal(bound.status, 200);
  assert.deepEqual(JSON.parse(bound.text), {
    network: 'solana-mainnet', publisher: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', memoProgramId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
    memoFormat: 'helix-coa:v1:<kind>:<lotCode>:<version>:<sha256>', anchoringEnabled: true,
  });
  assert.ok(!bound.text.includes('must-not-leak'));
  const none = await get('/v1/public/anchor-info', {}, defaultBase);
  assert.deepEqual(JSON.parse(none.text), {
    network: null, publisher: null, memoProgramId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', memoFormat: 'helix-coa:v1:<kind>:<lotCode>:<version>:<sha256>', anchoringEnabled: false,
  });
  assert.equal(none.headers.get('cache-control'), 'public, max-age=30');
});
