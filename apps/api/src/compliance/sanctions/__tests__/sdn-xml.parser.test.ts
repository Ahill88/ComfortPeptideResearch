import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { parseSdnXml, extractEntry, DEFAULT_MAX_ENTRY_CHARS, SdnParseError, type ParsedSanctionAddress } from '../sdn-xml.parser';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name));
async function* chunked(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}
const parse = (name: string, size = 64 * 1024) => parseSdnXml(chunked(fixture(name), size));

const XBT_1 = '1SyntheticFixtureXbtAddress0000001';

test('parses the real-format fixture: XBT, ETH, USDC, SOL and USDT entries, with currency, uid and name', async () => {
  const result = await parse('sdn-sample.xml');
  assert.equal(result.entriesSeen, 4);
  assert.equal(result.complete, true);
  assert.equal(result.malformedEntries, 0);
  const byAddress = new Map<string, ParsedSanctionAddress>();
  for (const a of result.addresses) if (!byAddress.has(a.address)) byAddress.set(a.address, a);
  assert.equal(byAddress.get(XBT_1)?.currency, 'XBT');
  assert.equal(byAddress.get(XBT_1)?.entryUid, '900002', 'the first occurrence keeps the first entry (dedup happens in the service)');
  assert.equal(byAddress.get(XBT_1)?.listedName, 'PERSON, ONE, Fixture');
  assert.equal(byAddress.get('bc1qsyntheticfixturexbtaddress000000002')?.currency, 'XBT');
  assert.equal(byAddress.get('0xFeedFace00000000000000000000000000000001')?.currency, 'ETH');
  assert.equal(byAddress.get('0xabcdef0000000000000000000000000000000002')?.currency, 'USDC');
  assert.equal(byAddress.get('FixtureSo1anaSanctionedAddressxxxxxxxxxxxx')?.currency, 'SOL');
  assert.equal(byAddress.get('TSyntheticFixtureTronAddress0000003')?.currency, 'USDT');
  // 7 valid ids (XBT_1 appears twice), 2 rejected (bad charset, too short); non-address ids (passport, secondary sanctions) are ignored.
  assert.equal(result.addresses.length, 7);
  assert.equal(new Set(result.addresses.map((a) => a.address)).size, 6);
  assert.equal(result.rejectedAddresses, 2);
  assert.ok(!result.addresses.some((a) => /FX1234567|Executive Order/.test(a.address)));
});

test('decodes XML entities in names and never lets an entity smuggle characters into an address', async () => {
  const sink: ParsedSanctionAddress[] = [];
  const counters = { rejected: 0 };
  extractEntry(
    '<uid>1</uid><lastName>A &amp; B &#38; C</lastName><idList><id><uid>2</uid><idType>Digital Currency Address - XBT</idType><idNumber>AAAAAAAAAAAAAAAAAAAA&amp;BBB</idNumber></id>' +
      '<id><uid>3</uid><idType>Digital Currency Address - ETH</idType><idNumber>  0x0000000000000000000000000000000000000001  </idNumber></id></idList>',
    sink,
    counters,
  );
  assert.equal(counters.rejected, 1, 'an address that only becomes valid-looking after decoding "&" is still rejected');
  assert.equal(sink.length, 1);
  assert.equal(sink[0].address, '0x0000000000000000000000000000000000000001', 'surrounding whitespace is trimmed');
  assert.equal(sink[0].listedName, 'A & B & C');
});

test('the result does not depend on how the download is chunked (1 byte, 7 bytes, whole file)', async () => {
  const whole = await parse('sdn-sample.xml', 1_000_000);
  for (const size of [1, 7, 61, 4096]) {
    const other = await parse('sdn-sample.xml', size);
    assert.deepEqual(other, whole, `chunk size ${size}`);
  }
});

test('multi-byte UTF-8 split across chunks is decoded intact', async () => {
  const xml = '<sdnList><sdnEntry><uid>1</uid><lastName>ÅÉÎÖÜ 名前</lastName><idList><id><uid>2</uid><idType>Digital Currency Address - XBT</idType><idNumber>ZZZZZZZZZZZZZZZZZZZZ</idNumber></id></idList></sdnEntry></sdnList>';
  const result = await parseSdnXml(chunked(Buffer.from(xml, 'utf8'), 3));
  assert.equal(result.addresses[0].listedName, 'ÅÉÎÖÜ 名前');
  assert.equal(result.complete, true);
});

test('a truncated download is reported as incomplete (never silently accepted)', async () => {
  const result = await parse('sdn-truncated.xml');
  assert.equal(result.complete, false);
  assert.ok(result.malformedEntries >= 1);
});

test('a document with entries but no digital currency addresses parses to an empty list', async () => {
  const result = await parse('sdn-no-addresses.xml');
  assert.equal(result.entriesSeen, 1);
  assert.equal(result.addresses.length, 0);
  assert.equal(result.complete, true);
});

test('an HTML error page yields no entries', async () => {
  const result = await parse('not-sdn.html');
  assert.equal(result.entriesSeen, 0);
  assert.equal(result.complete, false);
});

test('huge-line defence: an entry that never closes is dropped, memory stays bounded and parsing resumes at the next entry', async () => {
  const good = (n: number) =>
    `<sdnEntry><uid>${n}</uid><lastName>OK ${n}</lastName><idList><id><uid>${n}1</uid><idType>Digital Currency Address - XBT</idType><idNumber>GOODADDRESS${String(n).padStart(12, '0')}</idNumber></id></idList></sdnEntry>`;
  let peak = 0;
  async function* hostile(): AsyncGenerator<string> {
    yield `<sdnList>${good(1)}<sdnEntry><uid>2</uid><lastName>`;
    const slab = 'x'.repeat(1_000_000); // one 1 MB "line" repeated: 40 MB with no closing tag
    for (let i = 0; i < 40; i += 1) {
      yield slab;
      gc();
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    }
    yield `</lastName></sdnEntry>${good(3)}</sdnList>`;
  }
  gc();
  const before = process.memoryUsage().heapUsed;
  const result = await parseSdnXml(hostile());
  assert.deepEqual(result.addresses.map((a) => a.entryUid), ['1', '3']);
  assert.equal(result.malformedEntries, 1);
  assert.equal(result.complete, true);
  assert.ok(peak - before < 8_000_000, `heap grew by ${peak - before} bytes while skipping 40 MB`);
});

test('huge-line defence: one enormous line with no tags at all is discarded without being retained', async () => {
  async function* noise(): AsyncGenerator<string> {
    for (let i = 0; i < 30; i += 1) yield 'a'.repeat(2_000_000);
  }
  gc();
  const before = process.memoryUsage().heapUsed;
  const result = await parseSdnXml(noise());
  assert.equal(result.entriesSeen, 0);
  gc();
  assert.ok(process.memoryUsage().heapUsed - before < 8_000_000);
});

test('an entry cut off by the next <sdnEntry> counts as malformed and the next entry is still read', async () => {
  const xml =
    '<sdnList><sdnEntry><uid>1</uid><idList><id><idType>Digital Currency Address - XBT</idType><idNumber>CUTOFFADDRESS00000001</idNumber>' +
    '<sdnEntry><uid>2</uid><idList><id><idType>Digital Currency Address - XBT</idType><idNumber>SECONDADDRESS0000002</idNumber></id></idList></sdnEntry></sdnList>';
  const result = await parseSdnXml(chunked(Buffer.from(xml), 50));
  assert.equal(result.malformedEntries, 1);
  assert.deepEqual(result.addresses.map((a) => a.address), ['SECONDADDRESS0000002']);
});

test('a flood of unterminated <id> tags inside one entry stays fast (bounded per-id scan)', async () => {
  const body = '<id>'.repeat(40_000);
  const xml = `<sdnList><sdnEntry><uid>1</uid>Digital Currency Address${body}</sdnEntry></sdnList>`;
  const started = Date.now();
  const result = await parseSdnXml(chunked(Buffer.from(xml), 65536));
  assert.equal(result.addresses.length, 0);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
});

test('markup is never executed or fetched: DOCTYPE/entity tricks and script tags are plain text', async () => {
  const xml =
    '<?xml version="1.0"?><!DOCTYPE sdnList [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><sdnList><sdnEntry><uid>1</uid><lastName>&xxe;</lastName>' +
    '<idList><id><idType>Digital Currency Address - XBT</idType><idNumber>&xxe;</idNumber></id></idList></sdnEntry></sdnList>';
  const result = await parseSdnXml(chunked(Buffer.from(xml), 64));
  assert.equal(result.addresses.length, 0, 'an unknown entity is not an address and is not resolved');
  assert.equal(result.rejectedAddresses, 1);
});

test('the address cap fails the parse instead of growing without bound', async () => {
  const entry = (n: number) => `<sdnEntry><uid>${n}</uid><idList><id><idType>Digital Currency Address - XBT</idType><idNumber>ADDR${String(n).padStart(20, '0')}</idNumber></id></idList></sdnEntry>`;
  const xml = `<sdnList>${Array.from({ length: 50 }, (_v, i) => entry(i)).join('')}</sdnList>`;
  await assert.rejects(parseSdnXml(chunked(Buffer.from(xml), 4096), { maxAddresses: 10 }), SdnParseError);
});

test('default per-entry cap is far above the largest real entry (about 26 KB) and far below anything dangerous', () => {
  assert.ok(DEFAULT_MAX_ENTRY_CHARS >= 100_000 && DEFAULT_MAX_ENTRY_CHARS <= 1_000_000);
});

test('tolerates namespace prefixes, attributes on <sdnEntry> and a different idType spelling', async () => {
  const xml =
    '<ns:sdnList xmlns:ns="x"><ns:sdnEntry id="a"><uid>7</uid><lastName>PREFIXED</lastName><idList><id><uid>8</uid><idType>digital currency address - eth</idType><idNumber>0x0000000000000000000000000000000000000007</idNumber></id></idList></ns:sdnEntry></ns:sdnList>';
  const result = await parseSdnXml(chunked(Buffer.from(xml), 9));
  assert.equal(result.addresses[0]?.address, '0x0000000000000000000000000000000000000007');
  assert.equal(result.addresses[0]?.currency, 'ETH');
  assert.equal(result.complete, true);
});
