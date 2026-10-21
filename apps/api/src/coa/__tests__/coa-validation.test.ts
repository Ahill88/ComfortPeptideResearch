import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { MAX_PDF_BYTES, assertPdf, isCalendarDate, normalizeSha256, parseCoaFields, sanitizeFileName, sha256Hex } from '../coa-validation';

const NOW = new Date('2026-10-21T12:00:00Z');
const valid = { labName: 'Lab', labReportId: 'R-1', testedAt: '2026-10-21', method: 'HPLC', purityPercent: '98.5', notes: 'ok' };
const messagesOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof BadRequestException, 'expected a 400');
    const message = (error.getResponse() as { message: string | string[] }).message;
    return Array.isArray(message) ? message : [message];
  }
  assert.fail('expected a rejection');
};

test('assertPdf decides from the bytes only: magic, size, emptiness', () => {
  const pdf = Buffer.from('%PDF-1.7\nbody');
  assert.equal(assertPdf({ buffer: pdf, mimetype: 'text/plain', originalname: 'x.exe' }), pdf, 'declared type and name are irrelevant');
  assert.match(messagesOf(() => assertPdf({ buffer: Buffer.from('<html></html>'), mimetype: 'application/pdf', originalname: 'a.pdf' }))[0], /not a PDF/);
  assert.match(messagesOf(() => assertPdf({ buffer: Buffer.alloc(0) }))[0], /empty/);
  assert.match(messagesOf(() => assertPdf(undefined))[0], /required/);
  assert.match(messagesOf(() => assertPdf({}))[0], /required/);
  assert.match(messagesOf(() => assertPdf({ buffer: Buffer.from('%PDF') }))[0], /not a PDF/);
  assert.match(messagesOf(() => assertPdf({ buffer: Buffer.from('\n%PDF-1.4') }))[0], /not a PDF/);
  assert.match(messagesOf(() => assertPdf({ buffer: Buffer.from('%pdf-1.4') }))[0], /not a PDF/, 'case-sensitive magic');
  const edge = Buffer.alloc(MAX_PDF_BYTES, 0x20);
  edge.write('%PDF-');
  assert.equal(assertPdf({ buffer: edge }).length, MAX_PDF_BYTES, 'exactly 10 MB is allowed');
  assert.match(messagesOf(() => assertPdf({ buffer: Buffer.concat([edge, Buffer.from(' ')]) }))[0], /10 MB/);
});

test('sha256Hex is the lower-case hex digest', () => {
  assert.equal(sha256Hex(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('sanitizeFileName: basename only, safe charset, <= 100 chars, always .pdf, never empty', () => {
  assert.equal(sanitizeFileName('report.pdf'), 'report.pdf');
  assert.equal(sanitizeFileName('REPORT.PDF'), 'REPORT.pdf');
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd.pdf');
  assert.equal(sanitizeFileName('..\\..\\windows\\system32\\cmd.exe'), 'cmd.exe.pdf');
  assert.equal(sanitizeFileName('a\u0000b\r\nc.pdf'), 'a_b_c.pdf');
  assert.equal(sanitizeFileName('résumé 日本.pdf'), 'r_sum_ _.pdf');
  assert.equal(sanitizeFileName('"; filename=evil.pdf'), 'filename_evil.pdf');
  for (const empty of ['', '   ', '.', '..', '.pdf', '___', undefined, null, 42, {}]) assert.equal(sanitizeFileName(empty), 'coa.pdf', String(empty));
  const long = sanitizeFileName(`${'x'.repeat(500)}.pdf`);
  assert.equal(long.length, 100);
  assert.ok(long.endsWith('.pdf'));
  assert.ok(/^[A-Za-z0-9._() -]+$/.test(sanitizeFileName('<>|*?:"\'`$%&{}[]^~#@!;,=+ x')));
});

test('isCalendarDate accepts only real YYYY-MM-DD dates', () => {
  for (const ok of ['2026-02-28', '2024-02-29', '2026-12-31']) assert.ok(isCalendarDate(ok), ok);
  for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-1-1', '26-01-01', '2026-01-01T00:00', '', '2026/01/01', '1800-01-01']) assert.ok(!isCalendarDate(bad), bad);
});

test('parseCoaFields normalizes valid input (trim, 2-decimal purity, CRLF notes) and returns plain strings', () => {
  assert.deepEqual(parseCoaFields(valid, NOW), { ...valid, purityPercent: '98.50' });
  assert.equal(parseCoaFields({ ...valid, purityPercent: '100' }, NOW).purityPercent, '100.00');
  assert.equal(parseCoaFields({ ...valid, purityPercent: '0' }, NOW).purityPercent, '0.00');
  assert.equal(parseCoaFields({ ...valid, purityPercent: '007.5' }, NOW).purityPercent, '7.50');
  assert.equal(parseCoaFields({ ...valid, purityPercent: ' 99.99 ' }, NOW).purityPercent, '99.99');
  assert.equal(parseCoaFields({ ...valid, labName: '  Janoshik  ' }, NOW).labName, 'Janoshik');
  assert.equal(parseCoaFields({ ...valid, notes: 'a\r\nb' }, NOW).notes, 'a\nb');
  assert.equal(parseCoaFields({ ...valid, notes: undefined }, NOW).notes, null);
  assert.equal(parseCoaFields({ ...valid, notes: '   ' }, NOW).notes, null);
  assert.equal(parseCoaFields({ ...valid, labName: 'x'.repeat(120) }, NOW).labName.length, 120);
  assert.equal(parseCoaFields({ ...valid, testedAt: '2026-10-20' }, NOW).testedAt, '2026-10-20');
});

test('parseCoaFields rejects every bad field with a message naming it', () => {
  const bad: Array<[Record<string, unknown>, RegExp]> = [
    [{ labName: undefined }, /labName is required/],
    [{ labName: '  ' }, /labName/],
    [{ labName: 'x'.repeat(121) }, /labName must be at most 120/],
    [{ labName: ['a', 'b'] }, /labName must be a single/],
    [{ labName: 'a\u0007b' }, /labName contains control/],
    [{ labReportId: undefined }, /labReportId is required/],
    [{ method: 'x'.repeat(121) }, /method must be at most 120/],
    [{ notes: 'n'.repeat(1001) }, /notes must be at most 1000/],
    [{ notes: 'a\u0000' }, /notes contains control/],
    [{ testedAt: undefined }, /testedAt/],
    [{ testedAt: '2026-10-22' }, /future/],
    [{ testedAt: '2099-01-01' }, /future/],
    [{ testedAt: '2026-02-30' }, /calendar date/],
    [{ testedAt: '21.10.2026' }, /calendar date/],
    [{ purityPercent: undefined }, /purityPercent/],
    [{ purityPercent: '100.01' }, /between 0 and 100/],
    [{ purityPercent: '100.1' }, /between 0 and 100/],
    [{ purityPercent: '101' }, /between 0 and 100/],
    [{ purityPercent: '1000' }, /purityPercent/],
    [{ purityPercent: '98.123' }, /2 decimals/],
    [{ purityPercent: '-0.5' }, /purityPercent/],
    [{ purityPercent: '1e2' }, /purityPercent/],
    [{ purityPercent: '98,5' }, /purityPercent/],
    [{ purityPercent: '.5' }, /purityPercent/],
    [{ purityPercent: '5.' }, /purityPercent/],
    [{ purityPercent: 'NaN' }, /purityPercent/],
    [{ purityPercent: 98.5 }, /purityPercent/],
  ];
  for (const [override, pattern] of bad) {
    const messages = messagesOf(() => parseCoaFields({ ...valid, ...override }, NOW));
    assert.ok(messages.some((message) => pattern.test(message)), `${JSON.stringify(override)} -> ${messages}`);
  }
  assert.ok(messagesOf(() => parseCoaFields(undefined, NOW)).length >= 5, 'an empty body reports every missing field');
  assert.ok(messagesOf(() => parseCoaFields('nope', NOW)).length >= 5);
});

test('"not in the future" compares calendar days in UTC', () => {
  assert.equal(parseCoaFields({ ...valid, testedAt: '2026-10-21' }, new Date('2026-10-21T00:00:00Z')).testedAt, '2026-10-21');
  assert.equal(parseCoaFields({ ...valid, testedAt: '2026-10-21' }, new Date('2026-10-21T23:59:59Z')).testedAt, '2026-10-21');
  assert.throws(() => parseCoaFields({ ...valid, testedAt: '2026-10-22' }, new Date('2026-10-21T23:59:59Z')));
});

test('normalizeSha256 accepts 64 hex in any case (trimmed) and nothing else', () => {
  const hex = 'ab'.repeat(32);
  assert.equal(normalizeSha256(hex.toUpperCase()), hex);
  assert.equal(normalizeSha256(` ${hex} `), hex);
  for (const bad of ['', 'ab', `${hex}0`, hex.slice(1), 'zz'.repeat(32), undefined, null, 5, [hex], { a: 1 }]) assert.equal(normalizeSha256(bad), null);
});
