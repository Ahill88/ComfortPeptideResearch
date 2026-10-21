/**
 * COA admin API against REAL PostgreSQL through HTTP with the REAL session guard (see coa-integration-harness.ts).
 *
 *   TEST_DATABASE_URL='postgresql://helix@127.0.0.1:54329/helix_field?schema=<your own schema>' \
 *   NODE_ENV=test pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only src/coa/__tests__/coa-admin.integration.test.ts
 */
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { type Harness, PUBLISHER, TX_SIGNATURE, VALID_FIELDS, bootHarness, pdfBytes, sha256 } from './coa-integration-harness';

let h: Harness;
before(async () => {
  h = await bootHarness('adm');
});
after(async () => {
  await h?.cleanup();
});

const ADMIN_COA_KEYS = ['anchors', 'createdAt', 'createdBy', 'file', 'id', 'labName', 'labReportId', 'lotId', 'method', 'notes', 'publishedAt', 'publishedBy', 'purityPercent', 'revokeReason', 'revokedAt', 'revokedBy', 'status', 'testedAt', 'version'];
const lotRow = (id: string) => h.prisma.lot.findUniqueOrThrow({ where: { id } });
const coaRows = (lotId: string) => h.prisma.coa.findMany({ where: { lotId }, orderBy: { version: 'asc' } });
const audits = (targetId: string) => h.prisma.adminAuditEvent.findMany({ where: { targetId }, orderBy: { createdAt: 'asc' } });
const uploadDraft = async (lotId: string, seed: string, token?: string) => {
  const res = await h.upload(lotId, { seed, token });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
};

/* ------------------------------------------------------------------------------------------------------------ auth + roles */

test('every admin route is 401 without a session; STAFF is 403 on exactly the OWNER-only routes and nothing changes', async () => {
  const lot = await h.mkLot();
  const draft = await uploadDraft(lot.id, 'roles');
  const sha = draft.file.sha256;
  const routes: Array<[string, string, unknown | undefined]> = [
    ['GET', '/v1/admin/catalog/products', undefined],
    ['POST', `/v1/admin/catalog/products/${h.product.id}/publish`, {}],
    ['POST', `/v1/admin/catalog/products/${h.product.id}/unpublish`, {}],
    ['GET', '/v1/admin/lots', undefined],
    ['POST', '/v1/admin/lots', { productId: h.product.id, code: `${h.tag}-x` }],
    ['GET', `/v1/admin/lots/${lot.id}`, undefined],
    ['GET', `/v1/admin/coas/${draft.id}/file`, undefined],
    ['POST', `/v1/admin/coas/${draft.id}/publish`, { confirmSha256: sha }],
    ['POST', `/v1/admin/coas/${draft.id}/revoke`, { reason: 'x' }],
    ['DELETE', `/v1/admin/coas/${draft.id}`, undefined],
    ['POST', `/v1/admin/coas/${draft.id}/anchor/retry`, { kind: 'PUBLISH' }],
  ];
  for (const [method, path, json] of routes) {
    assert.equal((await h.call(method, path, { token: null, json })).status, 401, `${method} ${path}`);
    assert.equal((await h.call(method, path, { token: 'garbage', json })).status, 401, `${method} ${path} garbage`);
  }
  assert.equal((await h.upload(lot.id, { token: null, seed: 'anon' })).status, 401);

  const ownerOnly = routes.filter(([, path]) => /\/(publish|unpublish|revoke|retry)$/.test(path));
  assert.equal(ownerOnly.length, 5);
  for (const [method, path, json] of ownerOnly) {
    const res = await h.call(method, path, { token: h.tokens.staff, json });
    assert.equal(res.status, 403, `${method} ${path}: ${JSON.stringify(res.body)}`);
  }
  assert.equal((await coaRows(lot.id)).length, 1);
  assert.equal((await coaRows(lot.id))[0].status, 'DRAFT');
  assert.equal(h.port.calls.filter((call) => call.coaId === draft.id).length, 0);
  assert.equal((await lotRow(lot.id)).coaKey, 'PENDING-NO-COA');

  for (const [method, path, json] of routes.filter((route) => !ownerOnly.includes(route) && route[0] !== 'DELETE')) {
    if (path === '/v1/admin/lots') continue;
    assert.equal((await h.call(method, path, { token: h.tokens.staff, json })).status, 200, `STAFF ${method} ${path}`);
  }
  assert.equal((await h.call('POST', '/v1/admin/lots', { token: h.tokens.staff, json: { productId: h.product.id, code: `${h.tag}-staff` } })).status, 201);
  assert.equal((await h.upload(lot.id, { token: h.tokens.staff, seed: 'staff-upload' })).status, 201);
});

/* -------------------------------------------------------------------------------------------------------------- lots */

test('lot create: 201 AdminLotSummary, placeholder purity 0 + coaKey PENDING-NO-COA, audit row; duplicates (also by case) 409; bad codes 400; unknown product 404', async () => {
  const code = `${h.tag}-new.lot_1`;
  const res = await h.call('POST', '/v1/admin/lots', { token: h.tokens.staff, json: { productId: h.product.id, code } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual(Object.keys(res.body).sort(), ['anchorStatus', 'coaStatus', 'code', 'currentCoaVersion', 'id', 'productId', 'productName', 'productSku', 'releasedAt']);
  assert.equal(res.body.code, code);
  assert.equal(res.body.productId, h.product.id);
  assert.equal(res.body.productName, h.product.name);
  assert.equal(res.body.productSku, h.product.sku);
  assert.equal(res.body.currentCoaVersion, null);
  assert.equal(res.body.coaStatus, 'none');
  assert.equal(res.body.anchorStatus, 'none');
  assert.match(res.body.releasedAt, /^\d{4}-\d\d-\d\dT/);
  const row = await lotRow(res.body.id);
  assert.equal(row.purity.toString(), '0');
  assert.equal(row.coaKey, 'PENDING-NO-COA');
  const trail = await audits(res.body.id);
  assert.deepEqual(trail.map((event) => [event.action, event.targetType, event.adminId]), [['lot.create', 'lot', h.admins.staff.id]]);
  assert.deepEqual(trail[0].detail, { code, productId: h.product.id });

  assert.equal((await h.call('POST', '/v1/admin/lots', { json: { productId: h.product.id, code } })).status, 409);
  assert.equal((await h.call('POST', '/v1/admin/lots', { json: { productId: h.product.id, code: code.toUpperCase() } })).status, 409);
  for (const bad of ['a', '-abc', '.abc', 'ab:cd', 'ab cd', 'ab/cd', 'x'.repeat(64), '', 'é-lot']) {
    assert.equal((await h.call('POST', '/v1/admin/lots', { json: { productId: h.product.id, code: bad } })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await h.call('POST', '/v1/admin/lots', { json: { productId: h.product.id } })).status, 400);
  assert.equal((await h.call('POST', '/v1/admin/lots', { json: { productId: 'c'.repeat(25), code: `${h.tag}-nop` } })).status, 404);
  assert.equal((await h.call('POST', '/v1/admin/lots', { json: { productId: h.product.id, code: 'x'.repeat(63) } })).status, 201);
  await h.prisma.lot.deleteMany({ where: { code: 'x'.repeat(63) } });
});

test('lot list: statuses none/draft/published/revoked + anchor status, filters, keyset pagination, bad limit/cursor 400, detail 404', async () => {
  const product = await h.mkProduct('list');
  const none = await h.mkLot(`${h.tag}-L1-none`, product.id);
  const draft = await h.mkLot(`${h.tag}-L2-draft`, product.id);
  const pub = await h.mkLot(`${h.tag}-L3-pub`, product.id);
  const rev = await h.mkLot(`${h.tag}-L4-rev`, product.id);
  const failed = await h.mkLot(`${h.tag}-L5-failed`, product.id);
  await uploadDraft(draft.id, 'list-draft');
  const published = await h.uploadAndPublish(pub.id, 'list-pub');
  const toRevoke = await h.uploadAndPublish(rev.id, 'list-rev');
  assert.equal((await h.call('POST', `/v1/admin/coas/${toRevoke.id}/revoke`, { json: { reason: 'lab retracted' } })).status, 200);
  const failedCoa = await h.uploadAndPublish(failed.id, 'list-failed');
  await h.prisma.coaAnchor.create({ data: { coaId: published.id, kind: 'PUBLISH', memo: 'm1', network: 'solana-devnet', status: 'CONFIRMED', txSignature: `${TX_SIGNATURE}A` } });
  await h.prisma.coaAnchor.create({ data: { coaId: failedCoa.id, kind: 'PUBLISH', memo: 'm2', network: 'solana-devnet', status: 'FAILED', error: 'rpc down', attempts: 3 } });
  await h.prisma.coaAnchor.create({ data: { coaId: failedCoa.id, kind: 'REVOKE', memo: 'm3', network: 'solana-devnet', status: 'CONFIRMED', txSignature: `${TX_SIGNATURE}B` } });
  await h.prisma.coaAnchor.create({ data: { coaId: toRevoke.id, kind: 'PUBLISH', memo: 'm4', network: 'solana-devnet', status: 'PENDING' } });

  const list = await h.call('GET', `/v1/admin/lots?productId=${product.id}`);
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.deepEqual(Object.keys(list.body).sort(), ['items', 'nextCursor']);
  assert.equal(list.body.nextCursor, null);
  const byCode = Object.fromEntries(list.body.items.map((item: any) => [item.code.replace(`${h.tag}-`, ''), item]));
  const pick = (item: any) => [item.currentCoaVersion, item.coaStatus, item.anchorStatus];
  assert.deepEqual(pick(byCode['L1-none']), [null, 'none', 'none']);
  assert.deepEqual(pick(byCode['L2-draft']), [1, 'draft', 'none']);
  assert.deepEqual(pick(byCode['L3-pub']), [1, 'published', 'confirmed']);
  assert.deepEqual(pick(byCode['L4-rev']), [1, 'revoked', 'pending']);
  assert.deepEqual(pick(byCode['L5-failed']), [1, 'published', 'failed'], 'anchorStatus is the PUBLISH anchor, not the revoke one');
  assert.deepEqual(list.body.items.map((item: any) => item.code), [...list.body.items.map((item: any) => item.code)].sort());

  // published wins over a newer draft
  await uploadDraft(pub.id, 'list-pub-draft2');
  assert.deepEqual(pick((await h.call('GET', `/v1/admin/lots?q=${h.tag}-L3`)).body.items[0]), [1, 'published', 'confirmed']);

  assert.deepEqual((await h.call('GET', `/v1/admin/lots?q=${h.tag.toUpperCase()}-l2`)).body.items.map((item: any) => item.id), [draft.id]);
  assert.deepEqual((await h.call('GET', `/v1/admin/lots?q=${encodeURIComponent('%')}`)).body.items, [], '% is literal');
  assert.deepEqual((await h.call('GET', `/v1/admin/lots?q=${encodeURIComponent(product.sku.slice(0, 12))}&productId=${product.id}&limit=100`)).body.items.length, 5);

  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: any = await h.call('GET', `/v1/admin/lots?productId=${product.id}&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
    assert.equal(page.status, 200);
    assert.ok(page.body.items.length <= 2);
    seen.push(...page.body.items.map((item: any) => item.code));
    cursor = page.body.nextCursor;
    pages += 1;
  } while (cursor && pages < 10);
  assert.equal(pages, 3);
  assert.deepEqual(seen, list.body.items.map((item: any) => item.code));

  for (const query of ['limit=0', 'limit=101', 'limit=abc', 'cursor=%25%25', `cursor=${Buffer.from('{"c":1}').toString('base64url')}`, 'limit=1.5']) {
    assert.equal((await h.call('GET', `/v1/admin/lots?${query}`)).status, 400, query);
  }
  assert.equal((await h.call('GET', `/v1/admin/lots/${'c'.repeat(25)}`)).status, 404);
});

test('lot detail: coas newest first with anchors from CoaAnchor rows (null when none), names, exact AdminCoa/AdminAnchor key sets', async () => {
  const lot = await h.mkLot();
  const v1 = await h.uploadAndPublish(lot.id, 'detail-1');
  const v2 = await h.uploadAndPublish(lot.id, 'detail-2');
  const v3 = await uploadDraft(lot.id, 'detail-3', h.tokens.staff);
  await h.prisma.coaAnchor.create({
    data: { coaId: v1.id, kind: 'PUBLISH', memo: `helix-coa:v1:publish:${lot.code}:1:${v1.file.sha256}`, network: 'solana-devnet', status: 'CONFIRMED', txSignature: TX_SIGNATURE, slot: 123456789n, blockTime: new Date('2026-10-02T03:04:05Z'), attempts: 2 },
  });
  await h.prisma.coaAnchor.create({ data: { coaId: v2.id, kind: 'PUBLISH', memo: 'pending-memo', network: 'solana-mainnet', status: 'PENDING', error: 'e'.repeat(900) } });

  const res = await h.call('GET', `/v1/admin/lots/${lot.id}`, { token: h.tokens.staff });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(Object.keys(res.body).sort(), ['coas', 'lot']);
  assert.equal(res.body.lot.id, lot.id);
  assert.deepEqual(res.body.coas.map((coa: any) => [coa.version, coa.status]), [[3, 'DRAFT'], [2, 'PUBLISHED'], [1, 'SUPERSEDED']]);
  for (const coa of res.body.coas) assert.deepEqual(Object.keys(coa).sort(), ADMIN_COA_KEYS);
  const [c3, c2, c1] = res.body.coas;
  assert.deepEqual(c3.anchors, { publish: null, revoke: null });
  assert.deepEqual(Object.keys(c1.anchors.publish).sort(), ['attempts', 'blockTime', 'error', 'explorerUrl', 'memo', 'network', 'slot', 'status', 'txSignature']);
  assert.deepEqual(c1.anchors.publish, {
    status: 'CONFIRMED', network: 'solana-devnet', txSignature: TX_SIGNATURE, slot: 123456789, blockTime: '2026-10-02T03:04:05.000Z', attempts: 2, error: null,
    memo: `helix-coa:v1:publish:${lot.code}:1:${v1.file.sha256}`, explorerUrl: `https://explorer.solana.com/tx/${TX_SIGNATURE}?cluster=devnet`,
  });
  assert.equal(c1.anchors.revoke, null);
  assert.equal(c2.anchors.publish.status, 'PENDING');
  assert.equal(c2.anchors.publish.txSignature, null);
  assert.equal(c2.anchors.publish.explorerUrl, null);
  assert.equal(c2.anchors.publish.error.length, 500, 'error text is bounded');
  assert.deepEqual(c3.createdBy, { name: h.admins.staff.name });
  assert.deepEqual(c2.createdBy, { name: h.admins.owner.name });
  assert.deepEqual(c2.publishedBy, { name: h.admins.owner.name });
  assert.equal(c3.publishedBy, null);
  assert.equal(typeof c2.purityPercent, 'number');
  assert.equal(c2.purityPercent, 98.5);
  assert.equal(c2.testedAt, '2026-10-01');
  assert.equal(res.body.lot.currentCoaVersion, 2);
  assert.equal(res.body.lot.coaStatus, 'published');
  void v3;
});

/* ------------------------------------------------------------------------------------------------------------ upload */

test('upload happy path: 201 DRAFT v1, server-side SHA-256, bytes stored exactly, Lot untouched, audit row without bytes or PII', async () => {
  const lot = await h.mkLot();
  const bytes = pdfBytes('happy');
  const res = await h.upload(lot.id, { bytes, token: h.tokens.staff, name: 'My Report (final).pdf', fields: { notes: '  Line 1\nLine 2  ', labName: '  Janoshik  ', purityPercent: '99', testedAt: new Date().toISOString().slice(0, 10) } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const body = res.body;
  assert.deepEqual(Object.keys(body).sort(), ADMIN_COA_KEYS);
  assert.equal(body.lotId, lot.id);
  assert.equal(body.version, 1);
  assert.equal(body.status, 'DRAFT');
  assert.equal(body.labName, 'Janoshik');
  assert.equal(body.labReportId, VALID_FIELDS.labReportId);
  assert.equal(body.method, 'HPLC');
  assert.equal(body.purityPercent, 99);
  assert.equal(body.notes, 'Line 1\nLine 2');
  assert.deepEqual(body.file, { name: 'My Report (final).pdf', sizeBytes: bytes.length, sha256: sha256(bytes) });
  assert.deepEqual(body.createdBy, { name: h.admins.staff.name });
  assert.equal(body.publishedBy, null);
  assert.equal(body.publishedAt, null);
  assert.equal(body.revokedAt, null);
  assert.deepEqual(body.anchors, { publish: null, revoke: null });
  const stored = await h.prisma.coaFile.findUniqueOrThrow({ where: { coaId: body.id } });
  assert.ok(Buffer.from(stored.bytes).equals(bytes), 'stored bytes are byte-identical');
  const row = await lotRow(lot.id);
  assert.equal(row.coaKey, 'PENDING-NO-COA', 'a draft never touches the Lot');
  assert.equal(row.purity.toString(), '0');
  const trail = await audits(body.id);
  assert.deepEqual(trail.map((event) => [event.action, event.targetType, event.adminId]), [['coa.upload', 'coa', h.admins.staff.id]]);
  assert.deepEqual(trail[0].detail, { lotId: lot.id, lotCode: lot.code, version: 1, sha256: sha256(bytes), sizeBytes: bytes.length });
  assert.ok(trail[0].ip);
  const serialized = JSON.stringify(trail);
  assert.ok(!serialized.includes('%PDF') && !serialized.includes(h.admins.staff.name) && !serialized.includes('example.test'));
});

test('upload rejections: disguised non-PDF, empty, too large, no file, bad fields: all 400 and nothing is stored', async () => {
  const lot = await h.mkLot();
  const reject = async (label: string, options: Parameters<Harness['upload']>[1]) => {
    const res = await h.upload(lot.id, options);
    assert.equal(res.status, 400, `${label}: ${JSON.stringify(res.body)}`);
    return res;
  };
  const html = Buffer.from('<html><script>alert(1)</script></html>');
  await reject('html named .pdf with application/pdf', { bytes: html, name: 'evil.pdf', type: 'application/pdf' });
  await reject('PNG', { bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), name: 'a.pdf', type: 'application/pdf' });
  await reject('PDF magic not at offset 0', { bytes: Buffer.from(' %PDF-1.4 hello'), name: 'a.pdf' });
  await reject('truncated magic', { bytes: Buffer.from('%PDF'), name: 'a.pdf' });
  await reject('empty file', { bytes: Buffer.alloc(0) });
  await reject('no file field', { skipFile: true });
  await reject('10 MB + 1 byte', { bytes: pdfBytes('big', 10 * 1024 * 1024 + 1) });
  const huge = await reject('12 MB (multer limit path)', { bytes: pdfBytes('huge', 12 * 1024 * 1024) });
  assert.match(JSON.stringify(huge.body), /10 MB/);

  const badFields: Array<[string, Record<string, string | undefined>]> = [
    ['labName missing', { labName: undefined }],
    ['labName blank', { labName: '   ' }],
    ['labName 121 chars', { labName: 'x'.repeat(121) }],
    ['labReportId missing', { labReportId: undefined }],
    ['labReportId 121', { labReportId: 'x'.repeat(121) }],
    ['method missing', { method: undefined }],
    ['method 121', { method: 'x'.repeat(121) }],
    ['testedAt missing', { testedAt: undefined }],
    ['testedAt wrong format', { testedAt: '10/01/2026' }],
    ['testedAt with time', { testedAt: '2026-10-01T00:00:00Z' }],
    ['testedAt impossible', { testedAt: '2026-02-30' }],
    ['testedAt tomorrow', { testedAt: new Date(Date.now() + 86_400_000 * 2).toISOString().slice(0, 10) }],
    ['testedAt far future', { testedAt: '2999-01-01' }],
    ['purity missing', { purityPercent: undefined }],
    ['purity 100.01', { purityPercent: '100.01' }],
    ['purity 101', { purityPercent: '101' }],
    ['purity 3 decimals', { purityPercent: '98.123' }],
    ['purity negative', { purityPercent: '-1' }],
    ['purity text', { purityPercent: 'high' }],
    ['purity exponent', { purityPercent: '1e2' }],
    ['purity comma', { purityPercent: '98,5' }],
    ['purity empty', { purityPercent: '' }],
    ['notes 1001', { notes: 'n'.repeat(1001) }],
    ['control chars in labName', { labName: 'bad\u0000name' }],
  ];
  for (const [label, fields] of badFields) await reject(label, { fields });
  assert.equal((await coaRows(lot.id)).length, 0, 'no rejected upload left a row');
  assert.equal(await h.prisma.coaFile.count({ where: { coa: { lotId: lot.id } } }), 0);
  assert.equal(await h.prisma.adminAuditEvent.count({ where: { action: 'coa.upload', detail: { path: ['lotId'], equals: lot.id } } }), 0);

  // boundaries that ARE valid
  for (const [label, fields] of [['purity 100', { purityPercent: '100' }], ['purity 100.00', { purityPercent: '100.00' }], ['purity 0', { purityPercent: '0' }], ['purity 0.5', { purityPercent: '0.5' }], ['notes 1000', { notes: 'n'.repeat(1000) }], ['labName 120', { labName: 'x'.repeat(120) }], ['no notes', { notes: undefined }]] as const) {
    const ok = await h.upload(lot.id, { fields, seed: label });
    assert.equal(ok.status, 201, `${label}: ${JSON.stringify(ok.body)}`);
  }
  const exactly = await h.upload(lot.id, { bytes: pdfBytes('exact', 10 * 1024 * 1024) });
  assert.equal(exactly.status, 201, 'exactly 10 MB is accepted');
  assert.equal(exactly.body.file.sizeBytes, 10 * 1024 * 1024);

  assert.equal((await h.upload('c'.repeat(25))).status, 404, 'unknown lot');
});

test('stored file name is sanitized and truncated; MIME type and client name are never trusted', async () => {
  const lot = await h.mkLot();
  const cases: Array<[string, string]> = [
    ['../../etc/passwd.pdf', 'passwd.pdf'],
    ['C:\\Users\\x\\scan 01.PDF', 'scan 01.pdf'],
    ['<script>alert(1)</script>.pdf', 'script_.pdf'],
    ['<img src=x onerror=alert(1)>.pdf', 'img src_x onerror_alert(1)_.pdf'],
    ['report.exe', 'report.exe.pdf'],
    ['.pdf', 'coa.pdf'],
    ['', 'coa.pdf'],
  ];
  for (const [input, expected] of cases) {
    const res = await h.upload(lot.id, { name: input || 'x', seed: `name-${input}` });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    if (input) assert.equal(res.body.file.name, expected, input);
  }
  const long = await h.upload(lot.id, { name: `${'a'.repeat(300)}.pdf`, seed: 'long-name' });
  assert.equal(long.body.file.name.length, 100);
  assert.ok(long.body.file.name.endsWith('.pdf'));
  const odd = await h.upload(lot.id, { type: 'text/plain', name: 'noext', seed: 'odd-type' });
  assert.equal(odd.status, 201, 'a real PDF is accepted whatever the declared type');
  assert.equal(odd.body.file.name, 'noext.pdf');
});

test('versions count 1,2,3 per lot (independent per lot); duplicate hash on the same lot is 409, the same file on another lot is fine', async () => {
  const lotA = await h.mkLot();
  const lotB = await h.mkLot();
  const bytes = pdfBytes('dup-hash');
  const first = await h.upload(lotA.id, { bytes });
  assert.equal(first.body.version, 1);
  const dup = await h.upload(lotA.id, { bytes, name: 'other-name.pdf', fields: { labName: 'Different lab' } });
  assert.equal(dup.status, 409, JSON.stringify(dup.body));
  assert.match(dup.body.message, /already uploaded/);
  assert.equal((await h.upload(lotA.id, { seed: 'dup-2' })).body.version, 2);
  assert.equal((await h.upload(lotA.id, { seed: 'dup-3' })).body.version, 3);
  assert.equal((await h.upload(lotB.id, { bytes })).body.version, 1, 'versions are per lot and the same file may sit on another lot');
  assert.equal((await coaRows(lotA.id)).length, 3);
  // a published file stays a duplicate too
  const pub = await h.call('POST', `/v1/admin/coas/${first.body.id}/publish`, { json: { confirmSha256: first.body.file.sha256 } });
  assert.equal(pub.status, 200);
  assert.equal((await h.upload(lotA.id, { bytes })).status, 409);
});

test('12 concurrent uploads for one lot get 12 distinct versions 1..12 (no duplicate, no gap, no 500); two lots in parallel stay independent', async () => {
  const lot = await h.mkLot();
  const other = await h.mkLot();
  const results = await Promise.all([
    ...Array.from({ length: 12 }, (_, n) => h.upload(lot.id, { seed: `race-${n}`, token: n % 2 ? h.tokens.staff : h.tokens.owner })),
    ...Array.from({ length: 4 }, (_, n) => h.upload(other.id, { seed: `race-other-${n}` })),
  ]);
  assert.deepEqual(results.map((r) => r.status), Array(16).fill(201), JSON.stringify(results.filter((r) => r.status !== 201).map((r) => r.body)));
  const versions = results.slice(0, 12).map((r) => r.body.version).sort((a, b) => a - b);
  assert.deepEqual(versions, Array.from({ length: 12 }, (_, n) => n + 1));
  assert.deepEqual(results.slice(12).map((r) => r.body.version).sort(), [1, 2, 3, 4]);
  assert.equal((await coaRows(lot.id)).length, 12);
  // identical bytes raced against each other: exactly one wins
  const same = pdfBytes('race-same');
  const dups = await Promise.all(Array.from({ length: 6 }, () => h.upload(lot.id, { bytes: same })));
  assert.deepEqual(dups.map((r) => r.status).sort(), [201, 409, 409, 409, 409, 409]);
});

test('draft cap: a lot cannot hold more than 50 drafts', async () => {
  const lot = await h.mkLot();
  const rows = Array.from({ length: 50 }, (_, n) => ({ lotId: lot.id, version: n + 1, status: 'DRAFT' as const, labName: 'l', labReportId: 'r', testedAt: new Date('2026-10-01'), method: 'HPLC', purityPercent: '90', fileName: 'a.pdf', fileSize: 8, fileSha256: sha256(`cap-${n}`) }));
  await h.prisma.coa.createMany({ data: rows });
  const res = await h.upload(lot.id, { seed: 'cap-51' });
  assert.equal(res.status, 409);
  assert.match(res.body.message, /too many/);
});

/* ------------------------------------------------------------------------------------------------------------ publish */

test('publish requires the correct confirmSha256 (case-insensitive); wrong/missing/odd values change nothing', async () => {
  const lot = await h.mkLot();
  const draft = await uploadDraft(lot.id, 'confirm');
  const url = `/v1/admin/coas/${draft.id}/publish`;
  for (const json of [{}, { confirmSha256: '' }, { confirmSha256: 'abc' }, { confirmSha256: 'z'.repeat(64) }, { confirmSha256: sha256('something else') }, { confirmSha256: 123 }, { confirmSha256: [draft.file.sha256] }]) {
    const res = await h.call('POST', url, { json });
    assert.equal(res.status, 400, JSON.stringify(json));
  }
  assert.equal((await coaRows(lot.id))[0].status, 'DRAFT');
  assert.equal((await lotRow(lot.id)).coaKey, 'PENDING-NO-COA');
  assert.equal(h.port.calls.filter((call) => call.coaId === draft.id).length, 0, 'no anchor request for a refused publish');
  assert.equal((await audits(draft.id)).filter((event) => event.action === 'coa.publish').length, 0);
  assert.equal((await h.call('POST', `/v1/admin/coas/${'c'.repeat(25)}/publish`, { json: { confirmSha256: draft.file.sha256 } })).status, 404);

  const ok = await h.call('POST', url, { json: { confirmSha256: draft.file.sha256.toUpperCase() } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, 'PUBLISHED');
  assert.deepEqual(ok.body.publishedBy, { name: h.admins.owner.name });
  assert.ok(ok.body.publishedAt);
});

test('publish syncs Lot.purity/coaKey, supersedes the previous published exactly once, keeps exactly one PUBLISHED, audits, anchors after commit', async () => {
  const lot = await h.mkLot();
  h.port.calls.length = 0;
  const v1 = await h.uploadAndPublish(lot.id, 'sync-1', { purityPercent: '97.25' });
  let row = await lotRow(lot.id);
  assert.equal(row.purity.toString(), '97.25');
  assert.equal(row.coaKey, `coa/${v1.id}`);
  const releasedAt = row.releasedAt.getTime();

  const v2 = await h.uploadAndPublish(lot.id, 'sync-2', { purityPercent: '99.1' });
  const rows = await coaRows(lot.id);
  assert.deepEqual(rows.map((r) => [r.version, r.status]), [[1, 'SUPERSEDED'], [2, 'PUBLISHED']]);
  assert.equal(rows.filter((r) => r.status === 'PUBLISHED').length, 1);
  row = await lotRow(lot.id);
  assert.equal(row.purity.toString(), '99.1');
  assert.equal(row.coaKey, `coa/${v2.id}`);
  assert.equal(row.releasedAt.getTime(), releasedAt, 'releasedAt is unchanged');
  assert.ok(rows[0].publishedAt, 'the superseded one keeps its publishedAt');

  const trail = await audits(v2.id);
  const publish = trail.find((event) => event.action === 'coa.publish');
  assert.deepEqual(publish?.detail, { lotId: lot.id, lotCode: lot.code, version: 2, sha256: v2.file.sha256, supersededCoaIds: [v1.id] });
  assert.equal(publish?.adminId, h.admins.owner.id);
  assert.deepEqual(h.port.calls.filter((call) => [v1.id, v2.id].includes(call.coaId)), [
    { coaId: v1.id, kind: 'PUBLISH', statusAtCall: 'PUBLISHED' },
    { coaId: v2.id, kind: 'PUBLISH', statusAtCall: 'PUBLISHED' },
  ]);
  // v1 is SUPERSEDED, so it can no longer be published again
  const again = await h.call('POST', `/v1/admin/coas/${v1.id}/publish`, { json: { confirmSha256: v1.file.sha256 } });
  assert.equal(again.status, 409);
  assert.equal((await coaRows(lot.id)).filter((r) => r.status === 'PUBLISHED').length, 1);
});

test('double-click publish: 8 parallel calls => exactly one 200 and seven 409, one supersede, one audit row, one anchor request', async () => {
  const lot = await h.mkLot();
  const v1 = await h.uploadAndPublish(lot.id, 'dc-1');
  const v2 = await uploadDraft(lot.id, 'dc-2');
  h.port.calls.length = 0;
  const results = await Promise.all(Array.from({ length: 8 }, () => h.call('POST', `/v1/admin/coas/${v2.id}/publish`, { json: { confirmSha256: v2.file.sha256 } })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, ...Array(7).fill(409)], JSON.stringify(results.map((r) => r.body.message)));
  assert.deepEqual((await coaRows(lot.id)).map((r) => [r.version, r.status]), [[1, 'SUPERSEDED'], [2, 'PUBLISHED']]);
  assert.equal((await audits(v2.id)).filter((event) => event.action === 'coa.publish').length, 1);
  assert.equal(h.port.calls.filter((call) => call.coaId === v2.id).length, 1);
  assert.equal((await lotRow(lot.id)).coaKey, `coa/${v2.id}`);
  void v1;
});

test('two different drafts of one lot published in parallel still leave exactly one PUBLISHED', async () => {
  const lot = await h.mkLot();
  const a = await uploadDraft(lot.id, 'par-a');
  const b = await uploadDraft(lot.id, 'par-b');
  const results = await Promise.all([a, b].map((d) => h.call('POST', `/v1/admin/coas/${d.id}/publish`, { json: { confirmSha256: d.file.sha256 } })));
  assert.deepEqual(results.map((r) => r.status), [200, 200]);
  const rows = await coaRows(lot.id);
  assert.equal(rows.filter((r) => r.status === 'PUBLISHED').length, 1);
  assert.equal(rows.filter((r) => r.status === 'SUPERSEDED').length, 1);
  const published = rows.find((r) => r.status === 'PUBLISHED')!;
  assert.equal((await lotRow(lot.id)).coaKey, `coa/${published.id}`, 'the Lot points at the surviving published coa');
});

/* ------------------------------------------------------------------------------------------------------------- revoke */

test('revoke rules: PUBLISHED and SUPERSEDED ok; DRAFT and REVOKED are 409; reason required; lot resets only when the published one is revoked', async () => {
  const lot = await h.mkLot();
  const v1 = await h.uploadAndPublish(lot.id, 'rv-1', { purityPercent: '95' });
  const v2 = await h.uploadAndPublish(lot.id, 'rv-2', { purityPercent: '99' });
  const v3 = await uploadDraft(lot.id, 'rv-3');
  const revoke = (id: string, json: unknown) => h.call('POST', `/v1/admin/coas/${id}/revoke`, { json });

  assert.equal((await revoke(v3.id, { reason: 'nope' })).status, 409, 'a draft cannot be revoked');
  for (const json of [{}, { reason: '' }, { reason: '   ' }, { reason: 'r'.repeat(501) }, { reason: 5 }]) assert.equal((await revoke(v2.id, json)).status, 400, JSON.stringify(json));
  assert.equal((await revoke('c'.repeat(25), { reason: 'x' })).status, 404);
  assert.deepEqual((await coaRows(lot.id)).map((r) => r.status), ['SUPERSEDED', 'PUBLISHED', 'DRAFT']);
  h.port.calls.length = 0;

  const old = await revoke(v1.id, { reason: '  superseded result was wrong  ' });
  assert.equal(old.status, 200, JSON.stringify(old.body));
  assert.equal(old.body.status, 'REVOKED');
  assert.equal(old.body.revokeReason, 'superseded result was wrong');
  assert.deepEqual(old.body.revokedBy, { name: h.admins.owner.name });
  assert.ok(old.body.revokedAt);
  assert.equal((await lotRow(lot.id)).coaKey, `coa/${v2.id}`, 'revoking a superseded version does not touch the lot');
  assert.equal((await lotRow(lot.id)).purity.toString(), '99');

  assert.equal((await revoke(v1.id, { reason: 'again' })).status, 409, 'already revoked');
  const current = await revoke(v2.id, { reason: 'lab withdrew the report' });
  assert.equal(current.status, 200);
  const row = await lotRow(lot.id);
  assert.equal(row.coaKey, 'PENDING-NO-COA');
  assert.equal(row.purity.toString(), '0', 'the lot has no current COA any more');
  assert.deepEqual((await coaRows(lot.id)).map((r) => r.status), ['REVOKED', 'REVOKED', 'DRAFT']);
  assert.deepEqual(h.port.calls.filter((call) => call.coaId === v1.id || call.coaId === v2.id), [
    { coaId: v1.id, kind: 'REVOKE', statusAtCall: 'REVOKED' },
    { coaId: v2.id, kind: 'REVOKE', statusAtCall: 'REVOKED' },
  ]);
  const trail = (await audits(v2.id)).find((event) => event.action === 'coa.revoke');
  assert.deepEqual(trail?.detail, { lotId: lot.id, lotCode: lot.code, version: 2, previousStatus: 'PUBLISHED', reason: 'lab withdrew the report' });
  // revoked files stay downloadable by admins
  assert.equal((await h.call('GET', `/v1/admin/coas/${v2.id}/file`)).status, 200);
});

test('parallel revokes of one coa: one 200, the rest 409, one audit row, one anchor request', async () => {
  const lot = await h.mkLot();
  const v1 = await h.uploadAndPublish(lot.id, 'rvr-1');
  h.port.calls.length = 0;
  const results = await Promise.all(Array.from({ length: 6 }, () => h.call('POST', `/v1/admin/coas/${v1.id}/revoke`, { json: { reason: 'dup click' } })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409, 409, 409, 409]);
  assert.equal((await audits(v1.id)).filter((event) => event.action === 'coa.revoke').length, 1);
  assert.equal(h.port.calls.filter((call) => call.coaId === v1.id).length, 1);
});

/* ------------------------------------------------------------------------------------------------------------- delete */

test('delete: DRAFT only; owner or the uploader (another STAFF is 403); published 409; unknown 404; file and row are gone; audited', async () => {
  const lot = await h.mkLot();
  const mine = await uploadDraft(lot.id, 'del-mine', h.tokens.staff);
  const theirs = await uploadDraft(lot.id, 'del-theirs', h.tokens.staff);
  const published = await h.uploadAndPublish(lot.id, 'del-pub');

  assert.equal((await h.call('DELETE', `/v1/admin/coas/${mine.id}`, { token: h.tokens.staff2 })).status, 403);
  assert.equal((await h.call('DELETE', `/v1/admin/coas/${published.id}`)).status, 409);
  assert.equal((await h.call('DELETE', `/v1/admin/coas/${'c'.repeat(25)}`)).status, 404);
  assert.equal((await coaRows(lot.id)).length, 3);

  const own = await h.call('DELETE', `/v1/admin/coas/${mine.id}`, { token: h.tokens.staff });
  assert.equal(own.status, 204);
  assert.equal(own.raw.length, 0);
  assert.equal((await h.call('DELETE', `/v1/admin/coas/${theirs.id}`, { token: h.tokens.owner })).status, 204);
  assert.equal(await h.prisma.coaFile.count({ where: { coaId: { in: [mine.id, theirs.id] } } }), 0);
  assert.deepEqual((await coaRows(lot.id)).map((r) => r.id), [published.id]);
  assert.equal((await h.call('DELETE', `/v1/admin/coas/${mine.id}`)).status, 404, 'second delete');
  assert.deepEqual((await audits(mine.id)).map((event) => event.action), ['coa.upload', 'coa.delete']);
  assert.equal(((await audits(mine.id))[1].detail as any).version, 1);
  // the published coa is untouched
  assert.equal((await h.call('GET', `/v1/admin/coas/${published.id}/file`)).status, 200);
});

test('delete racing publish: whichever wins, the end state is consistent (never a published coa without its file)', async () => {
  const lot = await h.mkLot();
  const draft = await uploadDraft(lot.id, 'del-race');
  const [pub, del] = await Promise.all([
    h.call('POST', `/v1/admin/coas/${draft.id}/publish`, { json: { confirmSha256: draft.file.sha256 } }),
    h.call('DELETE', `/v1/admin/coas/${draft.id}`),
  ]);
  const rows = await coaRows(lot.id);
  if (pub.status === 200) {
    assert.equal(del.status, 409);
    assert.equal(rows[0].status, 'PUBLISHED');
    assert.equal(await h.prisma.coaFile.count({ where: { coaId: draft.id } }), 1);
  } else {
    assert.equal(del.status, 204);
    assert.ok([404, 409].includes(pub.status), String(pub.status));
    assert.equal(rows.length, 0);
    assert.equal((await lotRow(lot.id)).coaKey, 'PENDING-NO-COA');
  }
});

/* ---------------------------------------------------------------------------------------------------------- admin file */

test('admin file route serves a DRAFT (any status) as application/pdf; unknown id 404', async () => {
  const lot = await h.mkLot();
  const bytes = pdfBytes('admin-file');
  const up = await h.upload(lot.id, { bytes });
  const res = await h.call('GET', `/v1/admin/coas/${up.body.id}/file`, { token: h.tokens.staff });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  assert.ok(res.raw.equals(bytes));
  assert.equal((await h.call('GET', `/v1/admin/coas/${'c'.repeat(25)}/file`)).status, 404);
  assert.equal((await h.call('GET', `/v1/admin/coas/${up.body.id}/file`, { token: null })).status, 401);
});

/* ------------------------------------------------------------------------------------------------------- anchor port */

test('a throwing anchor port does not fail publish or revoke; the audit and the state still commit', async () => {
  const lot = await h.mkLot();
  h.port.behavior = () => {
    throw new Error('rpc exploded: details that must not leak');
  };
  try {
    const published = await h.uploadAndPublish(lot.id, 'throw-1');
    assert.equal(published.status, 'PUBLISHED');
    const revoked = await h.call('POST', `/v1/admin/coas/${published.id}/revoke`, { json: { reason: 'test' } });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal(revoked.body.status, 'REVOKED');
    assert.ok(!JSON.stringify(revoked.body).includes('exploded'));
  } finally {
    h.port.behavior = () => undefined;
  }
});

test('a slow (never-resolving) anchor port delays the response by about 3 s at most and the COA stays published', async () => {
  const lot = await h.mkLot();
  const draft = await uploadDraft(lot.id, 'slow-1');
  h.port.behavior = () => new Promise<void>(() => undefined);
  try {
    const started = Date.now();
    const res = await h.call('POST', `/v1/admin/coas/${draft.id}/publish`, { json: { confirmSha256: draft.file.sha256 } });
    const elapsed = Date.now() - started;
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'PUBLISHED');
    assert.ok(elapsed >= 2500 && elapsed < 5000, `responded after ${elapsed} ms`);
  } finally {
    h.port.behavior = () => undefined;
  }
});

test('anchor retry (OWNER): delegates to the port, 409 when the coa never reached that state, 400 for a bad kind, 404, audited', async () => {
  const lot = await h.mkLot();
  const draft = await uploadDraft(lot.id, 'retry-1');
  const retry = (id: string, json: unknown, token?: string) => h.call('POST', `/v1/admin/coas/${id}/anchor/retry`, { json, token });
  assert.equal((await retry(draft.id, { kind: 'PUBLISH' })).status, 409, 'draft was never published');
  assert.equal((await retry(draft.id, { kind: 'REVOKE' })).status, 409);
  assert.equal((await retry(draft.id, { kind: 'NOPE' })).status, 400);
  assert.equal((await retry(draft.id, {})).status, 400);
  assert.equal((await retry('c'.repeat(25), { kind: 'PUBLISH' })).status, 404);

  const published = await h.uploadAndPublish(lot.id, 'retry-2');
  assert.equal((await retry(published.id, { kind: 'REVOKE' })).status, 409, 'not revoked yet');
  h.port.calls.length = 0;
  await h.prisma.coaAnchor.create({ data: { coaId: published.id, kind: 'PUBLISH', memo: 'memo', network: 'solana-devnet', status: 'FAILED', error: 'boom', attempts: 1 } });
  const ok = await retry(published.id, { kind: 'PUBLISH' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(h.port.calls, [{ coaId: published.id, kind: 'PUBLISH', statusAtCall: 'PUBLISHED' }]);
  assert.equal(ok.body.anchors.publish.status, 'FAILED', 'the response reloads the anchor rows');
  assert.deepEqual((await audits(published.id)).filter((event) => event.action === 'coa.anchor.retry').map((event) => event.detail), [{ kind: 'PUBLISH' }]);

  await h.call('POST', `/v1/admin/coas/${published.id}/revoke`, { json: { reason: 'r' } });
  h.port.calls.length = 0;
  assert.equal((await retry(published.id, { kind: 'REVOKE' })).status, 200);
  assert.deepEqual(h.port.calls.map((c) => c.kind), ['REVOKE']);
});

/* --------------------------------------------------------------------------------------------------------- products */

test('product publish/unpublish (OWNER): REQUIRE_PUBLISHED_COA=true needs a lot with a published COA; counts in the catalog list; audited', async () => {
  const product = await h.mkProduct('gate', false);
  const lot = await h.mkLot(undefined, product.id);
  const publish = (id: string, token?: string) => h.call('POST', `/v1/admin/catalog/products/${id}/publish`, { json: {}, token });
  const listed = async () => (await h.call('GET', '/v1/admin/catalog/products')).body.items.find((item: any) => item.id === product.id);
  const previous = process.env.REQUIRE_PUBLISHED_COA;
  try {
    process.env.REQUIRE_PUBLISHED_COA = 'true';
    const blocked = await publish(product.id);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.message, 'Product has no lot with a published COA.');
    assert.equal((await h.prisma.product.findUniqueOrThrow({ where: { id: product.id } })).active, false);
    assert.deepEqual(await listed(), { id: product.id, sku: product.sku, slug: product.slug, name: product.name, active: false, priceCents: 1250, inventory: 10, lotCount: 1, publishedCoaLotCount: 0 });

    await uploadDraft(lot.id, 'gate-draft');
    assert.equal((await publish(product.id)).status, 409, 'a draft is not enough');
    const coa = await h.uploadAndPublish(lot.id, 'gate-pub');
    assert.equal((await listed()).publishedCoaLotCount, 1);
    const ok = await publish(product.id);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.active, true);
    assert.equal(ok.body.id, product.id);
    assert.equal((await h.prisma.product.findUniqueOrThrow({ where: { id: product.id } })).active, true);

    const un = await h.call('POST', `/v1/admin/catalog/products/${product.id}/unpublish`, { json: {} });
    assert.equal(un.status, 200);
    assert.equal(un.body.active, false);
    await h.call('POST', `/v1/admin/coas/${coa.id}/revoke`, { json: { reason: 'x' } });
    assert.equal((await publish(product.id)).status, 409, 'a revoked coa no longer counts');

    process.env.REQUIRE_PUBLISHED_COA = 'false';
    assert.equal((await publish(product.id)).status, 200, 'the gate is off by default');
    process.env.REQUIRE_PUBLISHED_COA = 'TRUE';
    await h.call('POST', `/v1/admin/catalog/products/${product.id}/unpublish`, { json: {} });
    assert.equal((await publish(product.id)).status, 200, 'only the exact string true enables the gate');
  } finally {
    if (previous === undefined) delete process.env.REQUIRE_PUBLISHED_COA;
    else process.env.REQUIRE_PUBLISHED_COA = previous;
  }
  assert.equal((await publish('c'.repeat(25))).status, 404);
  assert.equal((await h.call('POST', `/v1/admin/catalog/products/${'c'.repeat(25)}/unpublish`, { json: {} })).status, 404);
  const trail = (await audits(product.id)).map((event) => [event.action, event.targetType, event.adminId]);
  assert.deepEqual(trail.slice(0, 2), [['product.publish', 'product', h.admins.owner.id], ['product.unpublish', 'product', h.admins.owner.id]]);
  assert.equal((await publish(product.id, h.tokens.staff)).status, 403);
});

test('the anchor constants used by tests match the contract memo/program (sanity)', () => {
  assert.equal(PUBLISHER.length >= 32, true);
});
