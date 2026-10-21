import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { type AnchorRow, type CoaRow, explorerUrl, toAdminAnchor, toAdminCoa, toLotSummary, toPublicAnchor, toPublicCoa } from '../coa-mappers';

const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
const anchor = (over: Partial<AnchorRow> = {}): AnchorRow => ({ kind: 'PUBLISH', status: 'CONFIRMED', network: 'solana-devnet', txSignature: SIG, slot: 7n, blockTime: new Date('2026-10-02T00:00:00Z'), memo: 'memo', attempts: 1, error: null, ...over });
const coa = (over: Partial<CoaRow> = {}): CoaRow => ({
  id: 'coa1', lotId: 'lot1', version: 2, status: 'PUBLISHED', labName: 'Lab', labReportId: 'R1', testedAt: new Date('2026-10-01T00:00:00Z'), method: 'HPLC',
  purityPercent: { toNumber: () => 98.5 }, notes: null, fileName: 'a.pdf', fileSize: 10, fileSha256: 'a'.repeat(64), createdByAdminId: 'admin-created-1', createdAt: new Date('2026-10-01T10:00:00Z'),
  publishedByAdminId: 'admin-published-2', publishedAt: new Date('2026-10-02T10:00:00Z'), revokedByAdminId: null, revokedAt: null, revokeReason: null, anchors: [], ...over,
});

test('explorerUrl: devnet carries the cluster, mainnet does not, unknown network or bad signature gives no link', () => {
  assert.equal(explorerUrl('solana-devnet', SIG), `https://explorer.solana.com/tx/${SIG}?cluster=devnet`);
  assert.equal(explorerUrl('solana-mainnet', SIG), `https://explorer.solana.com/tx/${SIG}`);
  assert.equal(explorerUrl('solana-testnet', SIG), null);
  assert.equal(explorerUrl('solana-devnet', null), null);
  assert.equal(explorerUrl('solana-devnet', 'not base58 !!'), null);
  assert.equal(explorerUrl('solana-devnet', '../../evil'), null);
});

test('toPublicAnchor only exposes CONFIRMED rows with a signature on a known network', () => {
  assert.deepEqual(Object.keys(toPublicAnchor(anchor())!), ['network', 'txSignature', 'slot', 'blockTime', 'memo', 'explorerUrl']);
  assert.equal(toPublicAnchor(anchor())!.slot, 7);
  assert.equal(toPublicAnchor(anchor({ slot: null, blockTime: null }))!.slot, null);
  for (const hidden of [anchor({ status: 'PENDING' }), anchor({ status: 'FAILED' }), anchor({ txSignature: null }), anchor({ network: 'solana-testnet' }), anchor({ txSignature: 'x y' }), undefined]) {
    assert.equal(toPublicAnchor(hidden), null);
  }
});

test('toPublicCoa: contract keys only, status lower-case, no admin ids/names, url built from the lot code', () => {
  const out = toPublicCoa('LOT-1', coa({ anchors: [anchor(), anchor({ kind: 'REVOKE', status: 'PENDING' })] }));
  assert.deepEqual(Object.keys(out), ['version', 'status', 'lab', 'testedAt', 'method', 'purityPercent', 'notes', 'file', 'publishedAt', 'revokedAt', 'revokeReason', 'anchors']);
  assert.equal(out.status, 'published');
  assert.equal(out.testedAt, '2026-10-01');
  assert.equal(out.purityPercent, 98.5);
  assert.deepEqual(out.file, { name: 'a.pdf', sizeBytes: 10, sha256: 'a'.repeat(64), url: '/v1/public/lots/LOT-1/coa/2.pdf' });
  assert.equal(out.anchors.revoke, null);
  assert.ok(out.anchors.publish);
  assert.ok(!/admin-|Alice|Bob/.test(JSON.stringify(out)), 'no admin ids or names');
  assert.deepEqual(['SUPERSEDED', 'REVOKED'].map((status) => toPublicCoa('L', coa({ status: status as CoaRow['status'] })).status), ['superseded', 'revoked']);
  assert.equal(toPublicCoa('L', coa({ purityPercent: '97.25' })).purityPercent, 97.25);
});

test('toAdminCoa / toAdminAnchor keep the contract fields, resolve names and bound the error text', () => {
  const names = new Map([['admin-created-1', 'Alice'], ['admin-published-2', 'Bob']]);
  const out = toAdminCoa(coa({ anchors: [anchor({ status: 'FAILED', error: 'e'.repeat(800), txSignature: null })] }), names);
  assert.deepEqual(out.createdBy, { name: 'Alice' });
  assert.deepEqual(out.publishedBy, { name: 'Bob' });
  assert.equal(out.revokedBy, null);
  assert.equal(out.anchors.publish!.error!.length, 500);
  assert.equal(out.anchors.publish!.explorerUrl, null);
  assert.equal(out.anchors.revoke, null);
  assert.deepEqual(toAdminCoa(coa({ createdByAdminId: 'gone' }), names).createdBy, { name: 'Unknown admin' });
  assert.equal(toAdminAnchor(undefined), null);
  assert.equal(toAdminAnchor(anchor({ status: undefined, attempts: undefined }))!.status, 'PENDING');
});

test('toLotSummary: published beats newer drafts; else the newest draft/revoked; superseded is history; anchorStatus is the PUBLISH anchor', () => {
  const base = { id: 'l', code: 'LOT-1', productId: 'p', releasedAt: new Date('2026-01-01T00:00:00Z'), product: { name: 'P', sku: 'S' } };
  const row = (version: number, status: 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED' | 'REVOKED', publishAnchor?: 'PENDING' | 'CONFIRMED' | 'FAILED') => ({
    version, status, anchors: publishAnchor ? [{ kind: 'PUBLISH' as const, status: publishAnchor }, { kind: 'REVOKE' as const, status: 'FAILED' as const }] : [],
  });
  const pick = (coas: ReturnType<typeof row>[]) => { const s = toLotSummary({ ...base, coas }); return [s.currentCoaVersion, s.coaStatus, s.anchorStatus]; };
  assert.deepEqual(pick([]), [null, 'none', 'none']);
  assert.deepEqual(pick([row(1, 'DRAFT')]), [1, 'draft', 'none']);
  assert.deepEqual(pick([row(1, 'PUBLISHED', 'CONFIRMED'), row(2, 'DRAFT')]), [1, 'published', 'confirmed']);
  assert.deepEqual(pick([row(1, 'SUPERSEDED', 'CONFIRMED'), row(2, 'PUBLISHED', 'PENDING')]), [2, 'published', 'pending']);
  assert.deepEqual(pick([row(1, 'REVOKED', 'FAILED'), row(2, 'DRAFT')]), [2, 'draft', 'none']);
  assert.deepEqual(pick([row(1, 'DRAFT'), row(2, 'REVOKED', 'FAILED')]), [2, 'revoked', 'failed']);
  assert.deepEqual(pick([row(1, 'SUPERSEDED', 'CONFIRMED')]), [null, 'none', 'none']);
  assert.deepEqual(Object.keys(toLotSummary({ ...base, coas: [] })), ['id', 'code', 'productId', 'productName', 'productSku', 'releasedAt', 'currentCoaVersion', 'coaStatus', 'anchorStatus']);
});
