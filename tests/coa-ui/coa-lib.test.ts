/**
 * Pure helpers behind the public COA pages (apps/storefront/lib/coa): hashing, lot-code rules, strict response validators,
 * status/banner/badge mapping and the API client (with an injected fetch). Runs against records produced by the FAKE API.
 *
 * Run (from repo root): pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only ../../tests/coa-ui/coa-lib.test.ts
 */
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { LOT_CODE_EXAMPLE, checkLotCode, isSha256Hex, lotCodeFromParam, lotPath } from '../../apps/storefront/lib/coa/codes';
import { FileTooLargeError, MAX_HASH_BYTES, bytesToHex, compareHashes, sha256Hex, sha256OfBlob } from '../../apps/storefront/lib/coa/hash';
import {
  cleanText, isCalendarDay, isIsoInstant, isSafeExplorerUrl, parseAnchor, parseAnchorInfo, parseByHashResult, parseCoa, parseProductLot, parsePublicLotRecord,
} from '../../apps/storefront/lib/coa/model';
import type { PublicLotRecord } from '../../apps/storefront/lib/coa/model';
import { BANNER_CURRENT_TITLE, BANNER_REVOKED_TITLE, byHashSummary, expectedMemo, featuredVersion, formatBytes, formatDay, formatInstantUtc, formatPurity, lotBanner, memoAgreesWithRecord, networkBadge, versionStatus } from '../../apps/storefront/lib/coa/status';
import { fetchAnchorInfo, fetchByHash, fetchLotRecord, fetchProductLot, hashRemotePdf, pdfHref, publicApiBase, serverApiBase } from '../../apps/storefront/lib/coa/client';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain .mjs fake API (no types)
import { FIXTURE_LOTS, createFakeCoaApi, makePdf } from './fake-coa-api.mjs';

const fake = createFakeCoaApi();
const fixture = (code: string): any => JSON.parse(JSON.stringify(fake.lots.get(code).record));
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');

/* ------------------------------- hashing ------------------------------- */

test('sha256Hex matches known vectors (empty, abc, long, binary)', async () => {
  assert.equal(await sha256Hex(new Uint8Array()), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await sha256Hex(new TextEncoder().encode('a'.repeat(1_000_000))), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.equal(await sha256Hex(bytes), sha(bytes));
  assert.equal(await sha256Hex(bytes.buffer), sha(bytes), 'ArrayBuffer input');
});
test('sha256Hex of a subarray view hashes only the view, and does not mutate input', async () => {
  const whole = Uint8Array.from([1, 2, 3, 4, 5, 6]);
  const view = whole.subarray(2, 5);
  assert.equal(await sha256Hex(view), sha(Uint8Array.from([3, 4, 5])));
  assert.deepEqual([...whole], [1, 2, 3, 4, 5, 6]);
});
test('sha256OfBlob hashes a Blob; oversize input is refused before hashing', async () => {
  assert.equal(await sha256OfBlob(new Blob(['abc'])), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  await assert.rejects(sha256Hex(new Uint8Array(MAX_HASH_BYTES + 1)), FileTooLargeError);
  await assert.rejects(sha256OfBlob({ size: MAX_HASH_BYTES + 1 } as Blob), FileTooLargeError);
});
test('bytesToHex pads and lowercases', () => assert.equal(bytesToHex(Uint8Array.from([0, 1, 15, 16, 255])), '00010f10ff'));
test('compareHashes: case-insensitive match; anything not a clean 64-hex pair is a mismatch', () => {
  const h = sha('x');
  assert.equal(compareHashes(h, h), 'match');
  assert.equal(compareHashes(h.toUpperCase(), h), 'match');
  assert.equal(compareHashes(` ${h}\n`, h), 'match');
  assert.equal(compareHashes(h, sha('y')), 'mismatch');
  assert.equal(compareHashes('', ''), 'mismatch', 'two empty strings must not "match"');
  assert.equal(compareHashes('abc', 'abc'), 'mismatch', 'short strings must not match');
  assert.equal(compareHashes(h.slice(0, 63), h), 'mismatch');
});
test('the fake API serves PDFs whose sha256 equals the record, except the deliberate mismatch', async () => {
  for (const code of ['HF-GHK-2610A', 'HF-TB5-2609C', 'HF-REV-2608D', 'HF-MAIN-2610E']) {
    const entry = fake.lots.get(code);
    for (const v of entry.record.versions) {
      assert.equal(sha(entry.pdfs.get(v.version)), v.file.sha256, `${code} v${v.version}`);
      assert.equal(entry.pdfs.get(v.version).subarray(0, 5).toString(), '%PDF-');
    }
  }
  const bad = fake.lots.get('HF-MISMATCH-2610G');
  assert.notEqual(sha(bad.pdfs.get(1)), bad.record.versions[0].file.sha256);
  assert.equal(sha(makePdf('x')), sha(makePdf('x')), 'deterministic');
});

/* ------------------------------ lot codes ------------------------------ */

test('checkLotCode accepts the contract charset and rejects everything else, with a reason', () => {
  for (const ok of ['HF-GHK-2610A', 'ab', 'A1', 'x.y_z-9', 'a'.repeat(63), LOT_CODE_EXAMPLE]) assert.deepEqual(checkLotCode(ok), { ok: true, code: ok }, ok);
  assert.deepEqual(checkLotCode('  HF-GHK-2610A \n'), { ok: true, code: 'HF-GHK-2610A' }, 'surrounding whitespace is trimmed, case is preserved');
  for (const bad of ['', '   ', 'a', 'a'.repeat(64), '-abc', '.abc', '_abc', 'ab cd', 'a:b', 'a/b', 'a\\b', 'a%20b', 'ab?x=1', 'ab#c', 'ab\u0000', 'ab<script>', 'lot\u202Ecode', 'ünï', '../x', 'a;b']) {
    const r = checkLotCode(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(!r.ok && r.reason.length > 10, 'has a human reason');
  }
});
test('lotPath percent-encodes; lotCodeFromParam only returns canonical valid codes', () => {
  assert.equal(lotPath('HF-GHK-2610A'), '/verify/HF-GHK-2610A');
  assert.equal(lotPath('a/b?c'), '/verify/a%2Fb%3Fc');
  assert.equal(lotCodeFromParam('HF-GHK-2610A'), 'HF-GHK-2610A');
  assert.equal(lotCodeFromParam('HF%2DGHK'), 'HF-GHK', 'a percent-encoded hyphen decodes to the valid code');
  for (const bad of ['bad%20code', 'a%3Ab', '%E0%A4%A', '%', 'a%2Fb', '..%2F..%2Fetc', ' abc', 'x'.repeat(80)]) assert.equal(lotCodeFromParam(bad), null, bad);
});
test('isSha256Hex', () => {
  assert.equal(isSha256Hex(sha('a')), true);
  assert.equal(isSha256Hex(sha('a').toUpperCase()), true);
  for (const bad of [sha('a').slice(1), `${sha('a')}0`, 'g'.repeat(64), '', null, undefined, 5]) assert.equal(isSha256Hex(bad), false);
});

/* ------------------------------ validators ------------------------------ */

test('validators accept every well-formed fixture of the fake API (the contract)', () => {
  for (const code of FIXTURE_LOTS.filter((c: string) => !['HF-BROKEN-1', 'HF-DOWN-1'].includes(c))) {
    const parsed = parsePublicLotRecord(fixture(code));
    assert.ok(parsed, `${code} should validate`);
    assert.equal(parsed!.lotCode, code);
  }
  assert.equal(parsePublicLotRecord(fixture('HF-ORPH-2607F'))!.product, null);
  assert.equal(parsePublicLotRecord(fixture('HF-REV-2608D'))!.current, null);
});
test('the deliberately broken fixture (status current, no current coa) is rejected', () => assert.equal(parsePublicLotRecord(fixture('HF-BROKEN-1')), null));

test('parsers return ONLY contract fields (extra / admin-only fields are dropped, deeply)', () => {
  const raw = fixture('HF-XSS-2610H');
  raw.adminOnly = 'x';
  raw.versions[0].file.storageKey = 'SECRET';
  raw.versions[0].anchors.publish.error = 'rpc blew up';
  const parsed = parsePublicLotRecord(raw)!;
  const json = JSON.stringify(parsed);
  for (const leaked of ['SECRET-ADMIN-NAME', 'SECRET-INTERNAL-NOTE', 'SECRET-STORAGE-KEY', 'SECRET', 'adminOnly', 'rpc blew up', 'createdBy', 'internalNote']) assert.ok(!json.includes(leaked), leaked);
  assert.deepEqual(Object.keys(parsed).sort(), ['current', 'lotCode', 'product', 'status', 'versions']);
  assert.deepEqual(Object.keys(parsed.versions[0]).sort(), ['anchors', 'file', 'lab', 'method', 'notes', 'publishedAt', 'purityPercent', 'revokeReason', 'revokedAt', 'status', 'testedAt', 'version']);
  assert.deepEqual(Object.keys(parsed.versions[0].file).sort(), ['name', 'sha256', 'sizeBytes', 'url']);
  assert.deepEqual(Object.keys(parsed.versions[0].anchors.publish!).sort(), ['blockTime', 'explorerUrl', 'memo', 'network', 'slot', 'txSignature']);
});

test('parsePublicLotRecord rejects malformed and dangerous values (each mutation on its own)', () => {
  const base = () => fixture('HF-TB5-2609C');
  const mutations: Record<string, (r: any) => void> = {
    'non-object': (r) => { Object.keys(r).forEach((k) => delete r[k]); r.x = 1; },
    'lotCode with colon': (r) => { r.lotCode = 'A:B'; },
    'lotCode with path': (r) => { r.lotCode = '../x'; },
    'lotCode too short': (r) => { r.lotCode = 'a'; },
    'bad lot status': (r) => { r.status = 'ok'; },
    'status current but current null': (r) => { r.current = null; },
    'status current but current revoked': (r) => { r.current.status = 'revoked'; },
    'status revoked but a published version exists': (r) => { r.status = 'revoked'; r.current = null; },
    'two published versions': (r) => { r.versions[1].status = 'published'; },
    'duplicate version numbers': (r) => { r.versions[1].version = 2; },
    'empty versions': (r) => { r.versions = []; },
    'versions not array': (r) => { r.versions = {}; },
    'unknown coa status': (r) => { r.versions[0].status = 'draft'; },
    'version zero': (r) => { r.versions[0].version = 0; },
    'version float': (r) => { r.versions[0].version = 1.5; },
    'version string': (r) => { r.versions[0].version = '2'; },
    'purity > 100': (r) => { r.versions[0].purityPercent = 100.1; },
    'purity negative': (r) => { r.versions[0].purityPercent = -1; },
    'purity NaN-ish string': (r) => { r.versions[0].purityPercent = '99'; },
    'testedAt not a date': (r) => { r.versions[0].testedAt = '2026-02-30'; },
    'testedAt timestamp': (r) => { r.versions[0].testedAt = '2026-09-02T00:00:00Z'; },
    'sha256 short': (r) => { r.versions[0].file.sha256 = 'abc'; },
    'sha256 non-hex': (r) => { r.versions[0].file.sha256 = 'z'.repeat(64); },
    'file url off-contract': (r) => { r.versions[0].file.url = 'https://evil.example/x.pdf'; },
    'file url for another lot': (r) => { r.versions[0].file.url = '/v1/public/lots/OTHER-1/coa/2.pdf'; },
    'file url wrong version': (r) => { r.versions[0].file.url = '/v1/public/lots/HF-TB5-2609C/coa/9.pdf'; },
    'file url javascript:': (r) => { r.versions[0].file.url = 'javascript:alert(1)'; },
    'negative size': (r) => { r.versions[0].file.sizeBytes = -1; },
    'lab name empty': (r) => { r.versions[0].lab.name = '   '; },
    'lab name too long': (r) => { r.versions[0].lab.name = 'x'.repeat(121); },
    'lab object missing': (r) => { delete r.versions[0].lab; },
    'notes number': (r) => { r.versions[0].notes = 5; },
    'notes too long': (r) => { r.versions[0].notes = 'x'.repeat(1001); },
    'publishedAt not ISO': (r) => { r.versions[0].publishedAt = 'yesterday'; },
    'revokedAt number': (r) => { r.versions[0].revokedAt = 1700000000; },
    'revokeReason object': (r) => { r.versions[0].revokeReason = { a: 1 }; },
    'anchor wrong network': (r) => { r.versions[0].anchors.publish.network = 'ethereum'; },
    'anchor bad signature': (r) => { r.versions[0].anchors.publish.txSignature = 'not base58 !!'; },
    'anchor memo off-format': (r) => { r.versions[0].anchors.publish.memo = 'hello'; },
    'anchor memo with newline': (r) => { r.versions[0].anchors.publish.memo += '\nextra'; },
    'anchor explorer javascript:': (r) => { r.versions[0].anchors.publish.explorerUrl = 'javascript:alert(1)'; },
    'anchor explorer http': (r) => { r.versions[0].anchors.publish.explorerUrl = 'http://explorer.solana.com/tx/x'; },
    'anchor explorer with credentials': (r) => { r.versions[0].anchors.publish.explorerUrl = 'https://user:pw@explorer.solana.com/tx/x'; },
    'anchor slot negative': (r) => { r.versions[0].anchors.publish.slot = -3; },
    'anchor blockTime junk': (r) => { r.versions[0].anchors.publish.blockTime = 'noon'; },
    'anchors missing': (r) => { delete r.versions[0].anchors; },
    'product slug with html': (r) => { r.product = { slug: '<b>', name: 'x' }; },
    'product not object': (r) => { r.product = 'x'; },
    'too many versions': (r) => { r.versions = Array.from({ length: 201 }, (_, i) => ({ ...clone(r.versions[0]), version: i + 1, status: 'superseded', file: { ...r.versions[0].file, url: `/v1/public/lots/HF-TB5-2609C/coa/${i + 1}.pdf` } })); r.current = null; r.status = 'revoked'; },
  };
  assert.ok(parsePublicLotRecord(base()), 'control: unmutated record validates');
  for (const [name, mutate] of Object.entries(mutations)) {
    const record = base();
    mutate(record);
    assert.equal(parsePublicLotRecord(record), null, `should reject: ${name}`);
  }
  for (const junk of [null, undefined, 5, 'str', [], [{}], true]) assert.equal(parsePublicLotRecord(junk), null);
});

test('cleanText strips control and bidi characters, trims, rejects over-long and non-strings (no truncation)', () => {
  assert.equal(cleanText('  hello\u0000\u202Eworld  ', 50), 'helloworld');
  assert.equal(cleanText('a\nb', 50, { required: false }), 'a\nb', 'newlines kept');
  assert.equal(cleanText('x'.repeat(11), 10), null);
  assert.equal(cleanText('', 10), null);
  assert.equal(cleanText('', 10, { required: false }), '');
  assert.equal(cleanText(5, 10), null);
  assert.equal(cleanText('<script>alert(1)</script>', 100), '<script>alert(1)</script>', 'markup is kept as inert text, React escapes it on render');
});
test('date/instant/explorer predicates', () => {
  assert.ok(isCalendarDay('2026-02-28')); assert.ok(!isCalendarDay('2026-02-29')); assert.ok(!isCalendarDay('26-1-1')); assert.ok(!isCalendarDay(20260101));
  assert.ok(isIsoInstant('2026-10-01T14:03:11.000Z')); assert.ok(isIsoInstant('2026-10-01T14:03:11+02:00')); assert.ok(!isIsoInstant('2026-10-01')); assert.ok(!isIsoInstant('2026-13-01T00:00:00Z'));
  assert.ok(isSafeExplorerUrl('https://explorer.solana.com/tx/abc?cluster=devnet')); assert.ok(!isSafeExplorerUrl('data:text/html,x')); assert.ok(!isSafeExplorerUrl('https://localhost/x')); assert.ok(!isSafeExplorerUrl('https://a.com/x y'));
});

test('parseByHashResult / parseAnchorInfo / parseProductLot', () => {
  assert.deepEqual(parseByHashResult({ found: false, matches: [] }), { found: false, matches: [] });
  assert.deepEqual(parseByHashResult({ found: true, matches: [{ lotCode: 'HF-1', version: 2, status: 'revoked', extra: 'x' }] }), { found: true, matches: [{ lotCode: 'HF-1', version: 2, status: 'revoked' }] });
  for (const bad of [{ found: true, matches: [] }, { found: false, matches: [{ lotCode: 'HF-1', version: 1, status: 'published' }] }, { found: 'yes', matches: [] }, { found: true, matches: [{ lotCode: 'a:b', version: 1, status: 'published' }] }, { found: true, matches: [{ lotCode: 'HF-1', version: 1, status: 'draft' }] }, { found: false }, null]) assert.equal(parseByHashResult(bad), null, JSON.stringify(bad));
  const info = { network: 'solana-devnet', publisher: 'Jg9mtW1wogqWHBpajwMnbeg1QvSStMuhWVtEaFB73L7h', memoProgramId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', memoFormat: 'helix-coa:v1:<kind>:<lotCode>:<version>:<sha256>', anchoringEnabled: true };
  assert.deepEqual(parseAnchorInfo(info), info);
  assert.deepEqual(parseAnchorInfo({ ...info, network: null, publisher: null, anchoringEnabled: false }), { ...info, network: null, publisher: null, anchoringEnabled: false });
  for (const bad of [{ ...info, network: 'eth' }, { ...info, publisher: '<img>' }, { ...info, anchoringEnabled: 'true' }, { ...info, memoProgramId: 'x' }, null]) assert.equal(parseAnchorInfo(bad), null);
  assert.deepEqual(parseProductLot({ lots: [{ code: 'HF-1', coaPublished: true, junk: 1 }], x: 1 }), { state: 'published', code: 'HF-1' });
  assert.deepEqual(parseProductLot({ lots: [{ code: 'HF-1', coaPublished: false }] }), { state: 'none' });
  assert.deepEqual(parseProductLot({ lots: [] }), { state: 'none' });
  assert.deepEqual(parseProductLot({ lots: [{ code: 'legacy lot!', coaPublished: false }] }), { state: 'none' }, 'unlinkable legacy code with no COA is simply "none"');
  for (const bad of [{}, { lots: 'x' }, { lots: [null] }, { lots: [{ code: 'HF-1' }] }, { lots: [{ code: 'HF-1', coaPublished: 'true' }] }, { lots: [{ code: 'legacy lot!', coaPublished: true }] }, { lots: [{ code: 'HF-1', coaPublished: 1 }] }, null]) assert.equal(parseProductLot(bad), null, JSON.stringify(bad));
});
test('parseProductLot only trusts lots[0]: a published second lot never makes the panel positive', () => {
  assert.deepEqual(parseProductLot({ lots: [{ code: 'HF-1', coaPublished: false }, { code: 'HF-2', coaPublished: true }] }), { state: 'none' });
});

/* ------------------------- status / banner / badges ------------------------- */

test('banner: current is positive; revoked lot is never positive and carries the reason', () => {
  const cur = lotBanner(parsePublicLotRecord(fixture('HF-GHK-2610A'))!);
  assert.equal(cur.kind, 'current'); assert.equal(cur.positive, true); assert.equal(cur.tone, 'positive'); assert.equal(cur.title, BANNER_CURRENT_TITLE);
  const rev = lotBanner(parsePublicLotRecord(fixture('HF-REV-2608D'))!);
  assert.equal(rev.kind, 'revoked'); assert.equal(rev.positive, false); assert.equal(rev.tone, 'negative'); assert.equal(rev.title, BANNER_REVOKED_TITLE);
  assert.match(rev.reason!, /transcribed incorrectly/);
  assert.notEqual(rev.title, BANNER_CURRENT_TITLE);
  assert.doesNotMatch(`${rev.title} ${rev.detail}`, /we currently publish|is the current|has not been revoked/i, 'revoked banner never uses the positive wording');
  assert.match(rev.detail, /no current COA/);
});
test('banner: revoked lot without a reason says so rather than inventing one', () => {
  const r = fixture('HF-REV-2608D'); r.versions[0].revokeReason = null;
  assert.equal(lotBanner(parsePublicLotRecord(r)!).reason, 'No reason was recorded.');
});
test('banner can never be positive unless the lot is current AND its current coa is published (exhaustive status matrix)', () => {
  const statuses = ['published', 'superseded', 'revoked'] as const;
  for (const lotStatus of ['current', 'revoked'] as const) for (const coaStatus of statuses) {
    const record = fixture('HF-TB5-2609C') as PublicLotRecord;
    // Force combinations directly on the typed object (validators would reject inconsistent ones; the mapper must still be safe).
    record.status = lotStatus; record.current = { ...record.versions[0], status: coaStatus };
    const banner = lotBanner(record);
    assert.equal(banner.positive, lotStatus === 'current' && coaStatus === 'published', `${lotStatus}/${coaStatus}`);
    if (!banner.positive) assert.notEqual(banner.tone, 'positive');
  }
});
test('featuredVersion: current one; otherwise newest revoked; superseded is never "positive"', () => {
  assert.equal(featuredVersion(parsePublicLotRecord(fixture('HF-TB5-2609C'))!).version, 2);
  assert.equal(featuredVersion(parsePublicLotRecord(fixture('HF-REV-2608D'))!).status, 'revoked');
  assert.equal(versionStatus('published').tone, 'positive');
  assert.equal(versionStatus('superseded').tone, 'caution');
  assert.equal(versionStatus('revoked').tone, 'negative');
  for (const s of ['superseded', 'revoked'] as const) assert.notEqual(versionStatus(s).tone, 'positive');
});
test('network badge: devnet is labelled as a test network; mainnet is not; no network gets a positive tone', () => {
  const dev = networkBadge('solana-devnet');
  assert.equal(dev.label, 'Solana devnet (test network)'); assert.equal(dev.isTest, true); assert.equal(dev.tone, 'caution');
  const main = networkBadge('solana-mainnet');
  assert.equal(main.label, 'Solana mainnet'); assert.equal(main.isTest, false); assert.doesNotMatch(main.label, /test/i);
  assert.notEqual(main.tone, 'positive'); assert.notEqual(dev.tone, 'positive');
});
test('explorer URL is passed through to the page exactly as the API sent it', () => {
  for (const code of ['HF-GHK-2610A', 'HF-MAIN-2610E']) {
    const raw = fixture(code);
    const parsed = parsePublicLotRecord(raw)!;
    assert.equal(parsed.current!.anchors.publish!.explorerUrl, raw.current.anchors.publish.explorerUrl);
  }
  assert.equal(parseAnchor({ ...fixture('HF-GHK-2610A').current.anchors.publish, explorerUrl: 'https://solscan.io/tx/abc?cluster=devnet&x=%20' })!.explorerUrl, 'https://solscan.io/tx/abc?cluster=devnet&x=%20');
});
test('memo: expectedMemo format and agreement check (a tampered memo is flagged)', () => {
  assert.equal(expectedMemo('publish', 'HF-1', 3, 'A'.repeat(64)), `helix-coa:v1:publish:HF-1:3:${'a'.repeat(64)}`);
  const rec = parsePublicLotRecord(fixture('HF-GHK-2610A'))!;
  const coa = rec.current!;
  assert.equal(memoAgreesWithRecord(coa.anchors.publish!, 'publish', rec.lotCode, coa), true);
  assert.equal(memoAgreesWithRecord(coa.anchors.publish!, 'revoke', rec.lotCode, coa), false, 'kind must agree');
  assert.equal(memoAgreesWithRecord({ ...coa.anchors.publish!, memo: `helix-coa:v1:publish:HF-GHK-2610A:1:${'0'.repeat(64)}` }, 'publish', rec.lotCode, coa), false, 'hash must agree');
  assert.equal(memoAgreesWithRecord({ ...coa.anchors.publish!, memo: `helix-coa:v1:publish:HF-GHK-2610A:2:${coa.file.sha256}` }, 'publish', rec.lotCode, coa), false, 'version must agree');
});
test('byHashSummary: published positive; superseded caution; revoked negative; none neutral; the worst status wins', () => {
  const m = (status: any) => ({ lotCode: 'HF-1', version: 1, status });
  assert.equal(byHashSummary({ found: true, matches: [m('published')] }).tone, 'positive');
  assert.equal(byHashSummary({ found: true, matches: [m('superseded')] }).tone, 'caution');
  const rev = byHashSummary({ found: true, matches: [m('revoked')] });
  assert.equal(rev.tone, 'negative'); assert.match(rev.headline, /REVOKED/);
  const none = byHashSummary({ found: false, matches: [] });
  assert.equal(none.tone, 'neutral'); assert.match(none.headline, /No match/);
  assert.equal(byHashSummary({ found: true, matches: [m('published'), m('revoked')] }).tone, 'negative', 'a file that is also a revoked version is not shown as simply current');
  assert.equal(byHashSummary({ found: true, matches: [m('published'), m('superseded')] }).tone, 'caution');
});
test('formatting is deterministic and UTC', () => {
  assert.equal(formatDay('2026-09-28'), '28 Sep 2026');
  assert.equal(formatDay('2026-10-12T09:28:00.000Z'), '12 Oct 2026');
  assert.equal(formatInstantUtc('2026-10-01T14:03:11.000Z'), '1 Oct 2026, 14:03 UTC');
  assert.equal(formatInstantUtc('2026-10-01T23:30:00-02:00'), '2 Oct 2026, 01:30 UTC');
  assert.equal(formatPurity(99.43), '99.43%'); assert.equal(formatPurity(98), '98.0%'); assert.equal(formatPurity(99.5), '99.5%');
  assert.equal(formatBytes(599), '599 B'); assert.equal(formatBytes(2048), '2.0 KB'); assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
});

/* ------------------------------- client ------------------------------- */

const json = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const BASE = 'http://api.test/v1';
function recorder(handler: (url: string) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  return { calls, fetchImpl: async (url: string, init?: RequestInit) => { calls.push({ url, init }); return handler(url); } };
}

test('fetchLotRecord: found / 404 / 5xx / network error / bad JSON / bad shape / other lot; always encodes and never caches', async () => {
  const good = fixture('HF-GHK-2610A');
  let r = recorder(() => json(200, good));
  const found = await fetchLotRecord('HF-GHK-2610A', { base: BASE, fetchImpl: r.fetchImpl });
  assert.equal(found.kind, 'found');
  assert.equal(r.calls[0].url, 'http://api.test/v1/public/lots/HF-GHK-2610A');
  assert.equal((r.calls[0].init as any).cache, 'no-store');
  assert.deepEqual((await fetchLotRecord('HF-X-1', { base: BASE, fetchImpl: recorder(() => json(404, { message: 'Lot not found.' })).fetchImpl })).kind, 'not-found');
  assert.equal((await fetchLotRecord('HF-X-1', { base: BASE, fetchImpl: recorder(() => json(500, { message: 'x' })).fetchImpl })).kind, 'unavailable');
  assert.equal((await fetchLotRecord('HF-X-1', { base: BASE, fetchImpl: async () => { throw new TypeError('fetch failed'); } })).kind, 'unavailable');
  assert.equal((await fetchLotRecord('HF-X-1', { base: BASE, fetchImpl: recorder(() => json(200, '<html>not json</html>')).fetchImpl })).kind, 'unavailable');
  assert.equal((await fetchLotRecord('HF-X-1', { base: BASE, fetchImpl: recorder(() => json(200, { hello: 'world' })).fetchImpl })).kind, 'unavailable');
  assert.equal((await fetchLotRecord('HF-GHK-2610A', { base: BASE, fetchImpl: recorder(() => json(200, fixture('HF-MAIN-2610E'))).fetchImpl })).kind, 'unavailable', 'a record for a different lot is never shown');
  r = recorder(() => json(200, good));
  assert.equal((await fetchLotRecord('bad code', { base: BASE, fetchImpl: r.fetchImpl })).kind, 'not-found');
  assert.equal(r.calls.length, 0, 'an invalid code never reaches the network');
});
test('fetchLotRecord shows the record spelling when only the case differs', async () => {
  const r = await fetchLotRecord('hf-ghk-2610a', { base: BASE, fetchImpl: recorder(() => json(200, fixture('HF-GHK-2610A'))).fetchImpl });
  assert.ok(r.kind === 'found' && r.record.lotCode === 'HF-GHK-2610A');
});
test('fetchByHash: lowercases, validates the hash first, parses the result, and degrades to unavailable', async () => {
  const h = sha('abc');
  const r = recorder(() => json(200, { found: true, matches: [{ lotCode: 'HF-1', version: 1, status: 'published' }] }));
  const out = await fetchByHash(h.toUpperCase(), { base: BASE, fetchImpl: r.fetchImpl });
  assert.equal(out.kind, 'result');
  assert.equal(r.calls[0].url, `${BASE}/public/coa/by-hash/${h}`);
  const never = recorder(() => json(200, {}));
  assert.equal((await fetchByHash('nothex', { base: BASE, fetchImpl: never.fetchImpl })).kind, 'unavailable'); assert.equal(never.calls.length, 0);
  assert.equal((await fetchByHash(h, { base: BASE, fetchImpl: recorder(() => json(400, { message: 'bad' })).fetchImpl })).kind, 'unavailable');
  assert.equal((await fetchByHash(h, { base: BASE, fetchImpl: recorder(() => json(200, { found: true, matches: [] })).fetchImpl })).kind, 'unavailable', 'inconsistent shape');
});
test('fetchAnchorInfo / fetchProductLot', async () => {
  const info = { network: 'solana-devnet', publisher: 'Jg9mtW1wogqWHBpajwMnbeg1QvSStMuhWVtEaFB73L7h', memoProgramId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', memoFormat: 'x', anchoringEnabled: true };
  assert.deepEqual(await fetchAnchorInfo({ base: BASE, fetchImpl: recorder(() => json(200, info)).fetchImpl }), info);
  assert.equal(await fetchAnchorInfo({ base: BASE, fetchImpl: recorder(() => json(500, {})).fetchImpl }), null);
  assert.equal(await fetchAnchorInfo({ base: BASE, fetchImpl: recorder(() => json(200, { nope: 1 })).fetchImpl }), null);
  const r = recorder(() => json(200, { lots: [{ code: 'HF-1', coaPublished: true }] }));
  assert.deepEqual(await fetchProductLot('ghk cu/../x', { base: BASE, fetchImpl: r.fetchImpl }), { kind: 'ok', lot: { state: 'published', code: 'HF-1' } });
  assert.equal(r.calls[0].url, `${BASE}/products/ghk%20cu%2F..%2Fx`, 'slug is encoded');
  assert.deepEqual(await fetchProductLot('x', { base: BASE, fetchImpl: recorder(() => json(404, { message: 'nf' })).fetchImpl }), { kind: 'ok', lot: { state: 'none' } });
  assert.equal((await fetchProductLot('x', { base: BASE, fetchImpl: recorder(() => json(500, {})).fetchImpl })).kind, 'unavailable');
  assert.equal((await fetchProductLot('x', { base: BASE, fetchImpl: recorder(() => json(200, { lots: [{ code: 'HF-1', coaPublished: 'yes' }] })).fetchImpl })).kind, 'unavailable', 'a truthy-but-not-true flag is never read as published');
  assert.equal((await fetchProductLot('x', { base: BASE, fetchImpl: async () => { throw new TypeError('down'); } })).kind, 'unavailable');
});
test('hashRemotePdf hashes the downloaded bytes; failures are reported, not guessed', async () => {
  const bytes = makePdf('hello');
  const ok = await hashRemotePdf('http://x/a.pdf', { fetchImpl: async () => new Response(bytes, { status: 200 }) });
  assert.deepEqual(ok, { kind: 'hashed', sha256: sha(bytes) });
  assert.deepEqual(await hashRemotePdf('http://x/a.pdf', { fetchImpl: async () => new Response('', { status: 404 }) }), { kind: 'failed', reason: 'status' });
  assert.deepEqual(await hashRemotePdf('http://x/a.pdf', { fetchImpl: async () => { throw new TypeError('cors'); } }), { kind: 'failed', reason: 'network' });
});
test('base URLs follow the wallet env pattern: NEXT_PUBLIC_API_URL, API_URL for server-side, same fallback; PDF links use the PUBLIC origin', () => {
  const saved = { a: process.env.API_URL, p: process.env.NEXT_PUBLIC_API_URL };
  try {
    delete process.env.API_URL; delete process.env.NEXT_PUBLIC_API_URL;
    assert.equal(publicApiBase(), 'http://localhost:3001/v1'); assert.equal(serverApiBase(), 'http://localhost:3001/v1');
    process.env.NEXT_PUBLIC_API_URL = 'https://api.example.com/v1/';
    assert.equal(publicApiBase(), 'https://api.example.com/v1'); assert.equal(serverApiBase(), 'https://api.example.com/v1');
    process.env.API_URL = 'http://api-internal:3001/v1';
    assert.equal(serverApiBase(), 'http://api-internal:3001/v1'); assert.equal(publicApiBase(), 'https://api.example.com/v1');
    const file = { name: 'a.pdf', sizeBytes: 1, sha256: sha('a'), url: '/v1/public/lots/HF-1/coa/1.pdf' };
    assert.equal(pdfHref(file), 'https://api.example.com/v1/public/lots/HF-1/coa/1.pdf', 'browser-facing link never uses the internal API_URL');
  } finally { if (saved.a === undefined) delete process.env.API_URL; else process.env.API_URL = saved.a; if (saved.p === undefined) delete process.env.NEXT_PUBLIC_API_URL; else process.env.NEXT_PUBLIC_API_URL = saved.p; }
});
test('parseCoa requires the url to match the lot passed in (cannot be pointed at another lot)', () => {
  const rec = fixture('HF-GHK-2610A');
  assert.ok(parseCoa(rec.current, 'HF-GHK-2610A'));
  assert.equal(parseCoa(rec.current, 'HF-OTHER-1'), null);
});
