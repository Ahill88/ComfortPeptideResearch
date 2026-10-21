/**
 * Public COA verification API + catalog/orders integration against REAL PostgreSQL through HTTP (see coa-integration-harness.ts).
 *
 *   TEST_DATABASE_URL='postgresql://helix@127.0.0.1:54329/helix_field?schema=<your own schema>' \
 *   NODE_ENV=test pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only src/coa/__tests__/coa-public.integration.test.ts
 */
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { type Harness, PUBLISHER, TX_SIGNATURE, bootHarness, pdfBytes, sha256 } from './coa-integration-harness';

let h: Harness;
before(async () => {
  h = await bootHarness('pub');
});
after(async () => {
  await h?.cleanup();
});

const pub = (path: string, headers: Record<string, string> = {}) => h.call('GET', path, { token: null, headers });
const PUBLIC_COA_KEYS = ['anchors', 'file', 'lab', 'method', 'notes', 'publishedAt', 'purityPercent', 'revokeReason', 'revokedAt', 'status', 'testedAt', 'version'];
const ANCHOR_KEYS = ['blockTime', 'explorerUrl', 'memo', 'network', 'slot', 'txSignature'];
const setup = async (label: string) => {
  const product = await h.mkProduct(label);
  const lot = await h.mkLot(`${h.tag}-${label}`, product.id);
  return { product, lot };
};
const confirmAnchor = (coaId: string, kind: 'PUBLISH' | 'REVOKE', lotCode: string, version: number, sha: string, suffix: string) =>
  h.prisma.coaAnchor.create({
    data: { coaId, kind, memo: `helix-coa:v1:${kind.toLowerCase()}:${lotCode}:${version}:${sha}`, network: 'solana-devnet', status: 'CONFIRMED', txSignature: `${TX_SIGNATURE}${suffix}`, slot: 4242n, blockTime: new Date('2026-10-02T03:04:05Z'), attempts: 1 },
  });

test('public lot record: exact contract shape, newest first, superseded listed, no draft, only CONFIRMED anchors, no internal ids or admin names', async () => {
  const { product, lot } = await setup('shape');
  const v1 = await h.uploadAndPublish(lot.id, 'shape-1', { purityPercent: '96.5', notes: 'first' });
  const v2 = await h.uploadAndPublish(lot.id, 'shape-2', { purityPercent: '99.12', notes: '' });
  const draft = await h.upload(lot.id, { seed: 'shape-draft' });
  assert.equal(draft.status, 201);
  await confirmAnchor(v2.id, 'PUBLISH', lot.code, 2, v2.file.sha256, 'P2');
  await h.prisma.coaAnchor.create({ data: { coaId: v2.id, kind: 'REVOKE', memo: 'pending revoke', network: 'solana-devnet', status: 'PENDING' } });
  await h.prisma.coaAnchor.create({ data: { coaId: v1.id, kind: 'PUBLISH', memo: 'failed publish', network: 'solana-devnet', status: 'FAILED', error: 'rpc down', txSignature: `${TX_SIGNATURE}F1` } });

  const res = await pub(`/v1/public/lots/${lot.code}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.headers.get('cache-control'), 'public, max-age=30');
  assert.deepEqual(Object.keys(res.body).sort(), ['current', 'lotCode', 'product', 'status', 'versions']);
  assert.equal(res.body.lotCode, lot.code);
  assert.deepEqual(res.body.product, { slug: product.slug, name: product.name });
  assert.equal(res.body.status, 'current');
  assert.deepEqual(res.body.versions.map((v: any) => [v.version, v.status]), [[2, 'published'], [1, 'superseded']]);
  assert.deepEqual(res.body.current, res.body.versions[0]);
  for (const version of res.body.versions) {
    assert.deepEqual(Object.keys(version).sort(), PUBLIC_COA_KEYS);
    assert.deepEqual(Object.keys(version.lab).sort(), ['name', 'reportId']);
    assert.deepEqual(Object.keys(version.file).sort(), ['name', 'sha256', 'sizeBytes', 'url']);
    assert.deepEqual(Object.keys(version.anchors).sort(), ['publish', 'revoke']);
  }
  const [c2, c1] = res.body.versions;
  assert.deepEqual(c2.lab, { name: 'Janoshik Analytical', reportId: 'JA-2026-0001' });
  assert.equal(c2.testedAt, '2026-10-01');
  assert.equal(c2.method, 'HPLC');
  assert.equal(c2.purityPercent, 99.12);
  assert.equal(c2.notes, null);
  assert.equal(c1.notes, 'first');
  assert.deepEqual(c2.file, { name: 'report.pdf', sizeBytes: v2.file.sizeBytes, sha256: v2.file.sha256, url: `/v1/public/lots/${lot.code}/coa/2.pdf` });
  assert.equal(c1.file.url, `/v1/public/lots/${lot.code}/coa/1.pdf`);
  assert.match(c2.publishedAt, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.equal(c2.revokedAt, null);
  assert.equal(c2.revokeReason, null);
  assert.deepEqual(Object.keys(c2.anchors.publish).sort(), ANCHOR_KEYS);
  assert.deepEqual(c2.anchors.publish, {
    network: 'solana-devnet', txSignature: `${TX_SIGNATURE}P2`, slot: 4242, blockTime: '2026-10-02T03:04:05.000Z',
    memo: `helix-coa:v1:publish:${lot.code}:2:${v2.file.sha256}`, explorerUrl: `https://explorer.solana.com/tx/${TX_SIGNATURE}P2?cluster=devnet`,
  });
  assert.equal(c2.anchors.revoke, null, 'a PENDING anchor is not public');
  assert.deepEqual(c1.anchors, { publish: null, revoke: null }, 'a FAILED anchor is not public');

  const text = JSON.stringify(res.body);
  for (const secretish of [h.admins.owner.name, h.admins.owner.id, v1.id, v2.id, draft.body.id, draft.body.file.sha256, lot.id, 'createdBy', 'publishedBy', 'rpc down', 'pending revoke', 'DRAFT']) {
    assert.ok(!text.includes(secretish), `leaked ${secretish}`);
  }
});

test('public lot 404s: unknown lot, lot without coas, lot with only drafts, malformed codes; errors are not cacheable', async () => {
  const { lot: none } = await setup('empty');
  const { lot: draftOnly } = await setup('draftonly');
  assert.equal((await h.upload(draftOnly.id, { seed: 'draftonly' })).status, 201);
  for (const code of [`${h.tag}-nope`, none.code, draftOnly.code, 'a%3Ab', 'x', 'a b', 'x'.repeat(80), encodeURIComponent('<script>')]) {
    const res = await pub(`/v1/public/lots/${code}`);
    assert.equal(res.status, 404, code);
    assert.equal(res.body.message, 'Lot not found.');
    assert.equal(res.headers.get('cache-control'), 'no-store', 'a 404 must not be cached as a public response');
  }
  assert.equal((await pub(`/v1/public/lots/${draftOnly.code}/coa/1.pdf`)).status, 404, 'a draft PDF is not public');
});

test('product is null unless the product is active; lot status revoked when no PUBLISHED coa remains; revoked version keeps reason and revoke anchor', async () => {
  const { product, lot } = await setup('revoked');
  const v1 = await h.uploadAndPublish(lot.id, 'rev-1');
  await confirmAnchor(v1.id, 'PUBLISH', lot.code, 1, v1.file.sha256, 'RP');
  await h.prisma.product.update({ where: { id: product.id }, data: { active: false } });
  const inactive = await pub(`/v1/public/lots/${lot.code}`);
  assert.equal(inactive.status, 200);
  assert.equal(inactive.body.product, null);
  assert.equal(inactive.body.status, 'current');
  await h.prisma.product.update({ where: { id: product.id }, data: { active: true } });
  assert.deepEqual((await pub(`/v1/public/lots/${lot.code}`)).body.product, { slug: product.slug, name: product.name });

  const revoked = await h.call('POST', `/v1/admin/coas/${v1.id}/revoke`, { json: { reason: 'Lab withdrew the report' } });
  assert.equal(revoked.status, 200);
  await confirmAnchor(v1.id, 'REVOKE', lot.code, 1, v1.file.sha256, 'RR');
  const res = await pub(`/v1/public/lots/${lot.code}`);
  assert.equal(res.status, 200, 'a revoked lot stays visible');
  assert.equal(res.body.status, 'revoked');
  assert.equal(res.body.current, null);
  assert.equal(res.body.versions.length, 1);
  const [version] = res.body.versions;
  assert.equal(version.status, 'revoked');
  assert.equal(version.revokeReason, 'Lab withdrew the report');
  assert.match(version.revokedAt, /Z$/);
  assert.equal(version.anchors.publish.txSignature, `${TX_SIGNATURE}RP`);
  assert.equal(version.anchors.revoke.txSignature, `${TX_SIGNATURE}RR`);
  assert.deepEqual(Object.keys(version.anchors.revoke).sort(), ANCHOR_KEYS);
  assert.ok(!JSON.stringify(res.body).includes(h.admins.owner.name));
  assert.equal((await pub(`/v1/public/lots/${lot.code}/coa/1.pdf`)).status, 200, 'a revoked PDF stays downloadable');
});

test('anchors that are not publicly checkable are hidden: CONFIRMED without a signature, unknown network, PENDING, FAILED', async () => {
  const { lot } = await setup('hidden');
  const v1 = await h.uploadAndPublish(lot.id, 'hidden-1');
  await h.prisma.coaAnchor.create({ data: { coaId: v1.id, kind: 'PUBLISH', memo: 'm', network: 'solana-testnet', status: 'CONFIRMED', txSignature: `${TX_SIGNATURE}T` } });
  await h.prisma.coaAnchor.create({ data: { coaId: v1.id, kind: 'REVOKE', memo: 'm', network: 'solana-devnet', status: 'CONFIRMED', txSignature: null } });
  const res = await pub(`/v1/public/lots/${lot.code}`);
  assert.deepEqual(res.body.current.anchors, { publish: null, revoke: null });
  await h.prisma.coaAnchor.updateMany({ where: { coaId: v1.id, kind: 'PUBLISH' }, data: { network: 'solana-mainnet' } });
  const mainnet = (await pub(`/v1/public/lots/${lot.code}`)).body.current.anchors.publish;
  assert.equal(mainnet.network, 'solana-mainnet');
  assert.equal(mainnet.explorerUrl, `https://explorer.solana.com/tx/${TX_SIGNATURE}T`, 'mainnet links carry no cluster parameter');
});

test('PDF route: exact headers, quoted ETag from the SHA-256, If-None-Match 304 (also weak/list/*), superseded + revoked served, drafts 404 publicly but served to admins', async () => {
  const { lot } = await setup('pdf');
  const bytes1 = pdfBytes('pdf-1');
  const bytes2 = pdfBytes('pdf-2', 5000);
  const up1 = await h.upload(lot.id, { bytes: bytes1 });
  await h.call('POST', `/v1/admin/coas/${up1.body.id}/publish`, { json: { confirmSha256: up1.body.file.sha256 } });
  const up2 = await h.upload(lot.id, { bytes: bytes2 });
  await h.call('POST', `/v1/admin/coas/${up2.body.id}/publish`, { json: { confirmSha256: up2.body.file.sha256 } });
  const draftBytes = pdfBytes('pdf-draft');
  const draft = await h.upload(lot.id, { bytes: draftBytes });

  const ok = await pub(`/v1/public/lots/${lot.code}/coa/2.pdf`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'application/pdf');
  assert.equal(ok.headers.get('content-disposition'), 'inline');
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(ok.headers.get('etag'), `"${sha256(bytes2)}"`);
  assert.equal(ok.headers.get('cache-control'), 'public, max-age=300');
  assert.equal(ok.headers.get('content-length'), String(bytes2.length));
  assert.ok(ok.raw.equals(bytes2));
  assert.equal(sha256(ok.raw), up2.body.file.sha256, 'what you download hashes to the published record');

  const superseded = await pub(`/v1/public/lots/${lot.code}/coa/1.pdf`);
  assert.equal(superseded.status, 200);
  assert.ok(superseded.raw.equals(bytes1));

  const etag = ok.headers.get('etag')!;
  for (const header of [etag, `W/${etag}`, `"nope", ${etag}`, '*', sha256(bytes2)]) {
    const res = await pub(`/v1/public/lots/${lot.code}/coa/2.pdf`, { 'if-none-match': header });
    assert.equal(res.status, 304, header);
    assert.equal(res.raw.length, 0);
    assert.equal(res.headers.get('etag'), etag);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
  }
  const stale = await pub(`/v1/public/lots/${lot.code}/coa/2.pdf`, { 'if-none-match': `"${sha256('other')}"` });
  assert.equal(stale.status, 200);
  assert.equal((await pub(`/v1/public/lots/${lot.code}/coa/1.pdf`, { 'if-none-match': etag })).status, 200, 'the other version has another ETag');

  for (const path of ['coa/3.pdf', 'coa/0.pdf', 'coa/01.pdf', 'coa/abc.pdf', 'coa/-1.pdf', 'coa/99999999999.pdf', 'coa/2']) {
    assert.equal((await pub(`/v1/public/lots/${lot.code}/${path}`)).status, 404, path);
  }
  assert.equal((await pub(`/v1/public/lots/${h.tag}-nope/coa/1.pdf`)).status, 404);
  assert.equal((await pub(`/v1/public/lots/${lot.code}/coa/3.pdf`)).headers.get('cache-control'), 'no-store');

  const asAdmin = await h.call('GET', `/v1/admin/coas/${draft.body.id}/file`);
  assert.equal(asAdmin.status, 200);
  assert.ok(asAdmin.raw.equals(draftBytes));
  // a bogus Authorization header does not matter on the public surface
  assert.equal((await h.call('GET', `/v1/public/lots/${lot.code}/coa/2.pdf`, { token: 'garbage' })).status, 200);
});

test('by-hash: matches across lots with status, case-insensitive, drafts never match, 400 for malformed hashes', async () => {
  const { lot: a } = await setup('hashA');
  const { lot: b } = await setup('hashB');
  const bytes = pdfBytes('shared-file');
  const upA = await h.upload(a.id, { bytes });
  await h.call('POST', `/v1/admin/coas/${upA.body.id}/publish`, { json: { confirmSha256: upA.body.file.sha256 } });
  const upB = await h.upload(b.id, { bytes });
  await h.call('POST', `/v1/admin/coas/${upB.body.id}/publish`, { json: { confirmSha256: upB.body.file.sha256 } });
  await h.uploadAndPublish(b.id, 'hash-b2');
  await h.call('POST', `/v1/admin/coas/${upB.body.id}/revoke`, { json: { reason: 'x' } });
  const sha = sha256(bytes);

  const res = await pub(`/v1/public/coa/by-hash/${sha}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=30');
  assert.deepEqual(Object.keys(res.body).sort(), ['found', 'matches']);
  assert.equal(res.body.found, true);
  const mine = res.body.matches.filter((m: any) => [a.code, b.code].includes(m.lotCode));
  assert.deepEqual(mine, [{ lotCode: a.code, version: 1, status: 'published' }, { lotCode: b.code, version: 1, status: 'revoked' }].sort((x, y) => (x.lotCode < y.lotCode ? -1 : 1)));
  for (const match of res.body.matches) assert.deepEqual(Object.keys(match).sort(), ['lotCode', 'status', 'version']);
  assert.deepEqual((await pub(`/v1/public/coa/by-hash/${sha.toUpperCase()}`)).body, res.body);

  const draftBytes = pdfBytes('hash-draft');
  await h.upload(a.id, { bytes: draftBytes });
  const draft = await pub(`/v1/public/coa/by-hash/${sha256(draftBytes)}`);
  assert.deepEqual(draft.body, { found: false, matches: [] });
  assert.deepEqual((await pub(`/v1/public/coa/by-hash/${'0'.repeat(64)}`)).body, { found: false, matches: [] });
  for (const bad of ['abc', 'g'.repeat(64), sha.slice(1), `${sha}0`, '%20'.repeat(10)]) {
    const r = await pub(`/v1/public/coa/by-hash/${bad}`);
    assert.equal(r.status, 400, bad);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
});

test('anchor-info: exact contract shape from the bound COA_ANCHOR_INFO value', async () => {
  const res = await pub('/v1/public/anchor-info');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=30');
  assert.deepEqual(res.body, {
    network: 'solana-devnet',
    publisher: PUBLISHER,
    memoProgramId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
    memoFormat: 'helix-coa:v1:<kind>:<lotCode>:<version>:<sha256>',
    anchoringEnabled: true,
  });
  assert.deepEqual(Object.keys(res.body), ['network', 'publisher', 'memoProgramId', 'memoFormat', 'anchoringEnabled']);
});

/* --------------------------------------------------------------------------------------------- catalog + orders integration */

async function withRequirement<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.REQUIRE_PUBLISHED_COA;
  if (value === undefined) delete process.env.REQUIRE_PUBLISHED_COA;
  else process.env.REQUIRE_PUBLISHED_COA = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.REQUIRE_PUBLISHED_COA;
    else process.env.REQUIRE_PUBLISHED_COA = previous;
  }
}

test('catalog: lot objects gain coaPublished; REQUIRE_PUBLISHED_COA=true (exact string) keeps only lots with a PUBLISHED coa; list route too', async () => {
  const product = await h.mkProduct('catalog');
  const withCoa = await h.mkLot(`${h.tag}-cat-yes`, product.id);
  const without = await h.mkLot(`${h.tag}-cat-no`, product.id);
  const revoked = await h.mkLot(`${h.tag}-cat-rev`, product.id);
  const draftOnly = await h.mkLot(`${h.tag}-cat-draft`, product.id);
  await h.uploadAndPublish(withCoa.id, 'cat-yes');
  const r = await h.uploadAndPublish(revoked.id, 'cat-rev');
  await h.call('POST', `/v1/admin/coas/${r.id}/revoke`, { json: { reason: 'x' } });
  await h.upload(draftOnly.id, { seed: 'cat-draft' });
  const byCode = (lots: any[]) => Object.fromEntries(lots.map((lot) => [lot.code.replace(`${h.tag}-cat-`, ''), lot.coaPublished]));
  const lotKeys = ['coaKey', 'coaPublished', 'code', 'id', 'productId', 'purity', 'releasedAt'];

  for (const value of [undefined, 'false', 'TRUE', '1', 'yes', '']) {
    await withRequirement(value, async () => {
      const one = await pub(`/v1/products/${product.slug}`);
      assert.equal(one.status, 200);
      assert.deepEqual(byCode(one.body.lots), { yes: true, no: false, rev: false, draft: false }, `value ${JSON.stringify(value)}`);
      for (const lot of one.body.lots) assert.deepEqual(Object.keys(lot).sort(), lotKeys);
      const list = (await pub('/v1/products')).body.find((item: any) => item.id === product.id);
      assert.deepEqual(byCode(list.lots), { yes: true, no: false, rev: false, draft: false });
      assert.deepEqual(Object.keys(one.body).sort(), ['active', 'id', 'inventory', 'lots', 'name', 'priceCents', 'sku', 'slug']);
    });
  }
  await withRequirement('true', async () => {
    const one = await pub(`/v1/products/${product.slug}`);
    assert.deepEqual(byCode(one.body.lots), { yes: true });
    const list = (await pub('/v1/products')).body.find((item: any) => item.id === product.id);
    assert.deepEqual(byCode(list.lots), { yes: true });
    assert.equal(one.body.lots[0].coaKey.startsWith('coa/'), true, 'publishing synced the legacy coaKey');
  });
  assert.equal((await pub(`/v1/products/${h.tag}-missing`)).status, 404);
});

test('orders: REQUIRE_PUBLISHED_COA=true rejects a line whose lot has no published coa (400 Unavailable product in order); off accepts; revoke closes the lot again', async () => {
  const product = await h.mkProduct('order');
  const good = await h.mkLot(`${h.tag}-ord-good`, product.id);
  const bad = await h.mkLot(`${h.tag}-ord-bad`, product.id);
  const goodCoa = await h.uploadAndPublish(good.id, 'ord-good');
  let n = 0;
  const order = async (lotCode: string, extra: Array<{ productId: string; lotCode: string; quantity: number }> = []) => {
    n += 1;
    const res = await fetch(`${h.base}/v1/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `${h.tag}-order-key-${n}` },
      body: JSON.stringify({ email: `${h.tag}-buyer@example.test`, shippingAddress: '1 Lab Way', researchUseAcknowledged: true, items: [{ productId: product.id, lotCode, quantity: 1 }, ...extra] }),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  await withRequirement(undefined, async () => {
    assert.equal((await order(bad.code)).status, 201, 'default off: a lot without a COA is orderable (preview seed)');
    assert.equal((await order(good.code)).status, 201);
  });
  await withRequirement('false', async () => assert.equal((await order(bad.code)).status, 201));
  await withRequirement('true', async () => {
    const refused = await order(bad.code);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.message, 'Unavailable product in order');
    const mixed = await order(good.code, [{ productId: product.id, lotCode: bad.code, quantity: 2 }]);
    assert.equal(mixed.status, 400, 'one bad line rejects the whole order');
    assert.equal(mixed.body.message, 'Unavailable product in order');
    assert.equal((await order(good.code)).status, 201);
    const revoke = await h.call('POST', `/v1/admin/coas/${goodCoa.id}/revoke`, { json: { reason: 'x' } });
    assert.equal(revoke.status, 200);
    assert.equal((await order(good.code)).status, 400, 'after the revoke the lot has no published COA');
    const wrongProduct = await order('NOT-A-LOT');
    assert.equal(wrongProduct.status, 400);
    assert.equal(wrongProduct.body.message, 'Invalid lot', 'existing lot validation is unchanged and still comes first');
  });
  const stored = await h.prisma.orderItem.count({ where: { order: { customer: { email: `${h.tag.toLowerCase()}-buyer@example.test` } } } });
  assert.equal(stored, 4, 'only the four accepted orders exist (2 default-off, 1 false, 1 required with a published COA)');
});
