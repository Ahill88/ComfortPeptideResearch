/**
 * AnchorService against REAL PostgreSQL (unique constraints, compare-and-set updates, BigInt slot) with a fake chain.
 *
 *   TEST_DATABASE_URL=postgresql://helix@127.0.0.1:54329/helix_field?schema=<your own schema> \
 *   NODE_ENV=test pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only ../../tests/coa/anchor-db.integration.test.ts
 *
 * tests/run-all.mjs reports this file as SKIPPED when TEST_DATABASE_URL is unset. Refuses non-local databases. Rows are tagged and removed in `after`.
 */
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { Logger } from '@nestjs/common';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for the integration suite.');
const parsed = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || !/helix|test/i.test(parsed.pathname)) throw new Error('Refusing to run: not a local helix/test database.');
if (parsed.searchParams.get('schema') === 'public' || parsed.searchParams.get('schema') === 'dev') throw new Error('Refusing to run against the public/dev schema.');
process.env.DATABASE_URL = url;

import { AnchorService } from '../../apps/api/src/coa/anchor/anchor.service';
import { PrismaService } from '../../apps/api/src/prisma.service';
import { FakeAnchorChain, InMemoryPublisherSigner, SHA_A, ago, makeConfig } from './_anchor-helpers';

Logger.overrideLogger(false);
const tag = `anc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const prisma = new PrismaService();
let coaId = '';
let lotId = '';
let productId = '';
const lotCode = `LOT-${tag}`;

before(async () => {
  const product = await prisma.product.create({ data: { sku: `SKU-${tag}`, slug: `slug-${tag}`, name: 'Anchor test', priceCents: 100 } });
  productId = product.id;
  const lot = await prisma.lot.create({ data: { code: lotCode, productId, coaKey: 'PENDING-NO-COA', purity: 0 } });
  lotId = lot.id;
  const coa = await prisma.coa.create({
    data: { lotId, version: 1, status: 'PUBLISHED', labName: 'Lab', labReportId: 'R1', testedAt: new Date('2026-01-01'), method: 'HPLC', purityPercent: '99.10', fileName: 'a.pdf', fileSize: 10, fileSha256: SHA_A, publishedAt: new Date() },
  });
  coaId = coa.id;
});

after(async () => {
  await prisma.coaAnchor.deleteMany({ where: { coaId } });
  await prisma.coa.deleteMany({ where: { lotId } });
  await prisma.lot.deleteMany({ where: { id: lotId } });
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.$disconnect();
});

test('real DB: 10 parallel requests across two service instances => one CoaAnchor row and one transaction; then it confirms with BigInt slot', async () => {
  const chain = new FakeAnchorChain();
  chain.broadcastDelayMs = 15;
  const signer = new InMemoryPublisherSigner();
  const a = new AnchorService(prisma, makeConfig(), chain, signer);
  const b = new AnchorService(prisma, makeConfig(), chain, signer);
  await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).requestAnchor({ coaId, kind: 'PUBLISH' })));
  const rows = await prisma.coaAnchor.findMany({ where: { coaId } });
  assert.equal(rows.length, 1);
  assert.equal(chain.sent.length, 1);
  assert.equal(rows[0].status, 'PENDING');
  assert.equal(rows[0].memo, `helix-coa:v1:publish:${lotCode}:1:${SHA_A}`);
  assert.equal(rows[0].txSignature, chain.sent[0].signature);
  assert.equal(rows[0].attempts, 1);

  chain.land(chain.sent[0].signature, { slot: 9_000_000_000, blockTime: 1_800_000_000 });
  const summary = await a.reconcile();
  assert.equal(summary.confirmed, 1);
  const confirmed = await prisma.coaAnchor.findUniqueOrThrow({ where: { coaId_kind: { coaId, kind: 'PUBLISH' } } });
  assert.equal(confirmed.status, 'CONFIRMED');
  assert.equal(confirmed.slot, 9_000_000_000n);
  assert.equal(confirmed.blockTime?.toISOString(), new Date(1_800_000_000_000).toISOString());
  await assert.rejects(a.retry(coaId, 'PUBLISH'), /already confirmed/);
});

test('real DB: REVOKE anchor, unknown outcome, stale resend and retry reset against real constraints', async () => {
  await prisma.coa.update({ where: { id: coaId }, data: { status: 'REVOKED', revokedAt: new Date(), revokeReason: 'test' } });
  const chain = new FakeAnchorChain();
  const signer = new InMemoryPublisherSigner();
  const service = new AnchorService(prisma, makeConfig(), chain, signer);
  chain.broadcastMode = 'unknown';
  await service.requestAnchor({ coaId, kind: 'REVOKE' });
  const first = await prisma.coaAnchor.findUniqueOrThrow({ where: { coaId_kind: { coaId, kind: 'REVOKE' } } });
  assert.equal(first.status, 'PENDING');
  assert.ok(first.txSignature);
  assert.equal(first.memo, `helix-coa:v1:revoke:${lotCode}:1:${SHA_A}`);

  // unknown to the chain and older than 10 minutes: re-sent (a new signature), one row only
  await prisma.$executeRaw`UPDATE "CoaAnchor" SET "updatedAt" = ${ago(11 * 60_000)} WHERE id = ${first.id}`;
  chain.broadcastMode = 'ok';
  await service.reconcile();
  const second = await prisma.coaAnchor.findUniqueOrThrow({ where: { id: first.id } });
  assert.notEqual(second.txSignature, first.txSignature);
  assert.equal(second.attempts, 2);
  assert.equal(chain.sent.length, 2);

  // a definitive failure on chain, then an operator retry
  chain.land(second.txSignature!, { succeeded: false });
  await service.reconcile();
  assert.equal((await prisma.coaAnchor.findUniqueOrThrow({ where: { id: first.id } })).status, 'FAILED');
  const retried = await service.retry(coaId, 'REVOKE');
  assert.equal(retried.status, 'PENDING');
  assert.equal(retried.attempts, 1);
  assert.equal(chain.sent.length, 3);
  assert.equal(await prisma.coaAnchor.count({ where: { coaId } }), 2);
});
