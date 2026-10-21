/**
 * Streaming extractor for "Digital Currency Address" ID entries of the OFAC SDN list, legacy XML export (`SDN.XML`).
 *
 * Shape verified against the real file (see docs/compliance/sanctions-screening.md):
 *   <sdnList xmlns="..."> <sdnEntry> <uid>..</uid> <lastName>..</lastName> [<firstName>..</firstName>] <sdnType>..</sdnType>
 *     ... <idList> <id> <uid>..</uid> <idType>Digital Currency Address - XBT</idType> <idNumber>ADDRESS</idNumber> [<idCountry>,<issueDate>,<expirationDate>] </id> ... </idList>
 *   </sdnEntry> ... </sdnList>
 *
 * This is NOT an XML parser and does not need to be one: it scans for `<sdnEntry>` blocks in a bounded sliding buffer and reads a fixed set
 * of tags inside each block with regular expressions. It never evaluates content, never resolves entities beyond the five predefined ones
 * and numeric references, never fetches anything and never builds a DOM. Memory is bounded by `maxEntryChars` (plus the output).
 *
 * Strictness: an address is kept only if it is 16 to 128 ASCII letters/digits after trimming (every address in the real list is 33 to 95
 * characters, letters and digits only). Anything else is counted as rejected and dropped; the value itself is never logged or returned.
 */

export interface ParsedSanctionAddress {
  address: string;
  /** Upper-case ticker from the idType suffix ("XBT", "ETH", "USDC", "SOL"...), or null when absent/odd. */
  currency: string | null;
  /** The SDN entry's uid. */
  entryUid: string | null;
  /** "LAST NAME[, First name]" as published (public data). Shown to admins only, never in logs or customer responses. */
  listedName: string | null;
}

export interface SdnParseResult {
  addresses: ParsedSanctionAddress[];
  entriesSeen: number;
  /** Digital-currency ID entries that failed the address charset/length rule. */
  rejectedAddresses: number;
  /** sdnEntry blocks dropped for exceeding the per-entry cap or for being cut off by the next entry. */
  malformedEntries: number;
  /** True when the document's closing root tag was seen (a truncated download must fail the run). */
  complete: boolean;
}

export interface SdnParseOptions {
  /** Per-entry cap in characters (default 262,144; the largest of the 19,471 real entries is about 26,000). */
  maxEntryChars?: number;
  /** Hard cap on retained addresses (default 200,000; the real list has about one thousand). */
  maxAddresses?: number;
}

export const DEFAULT_MAX_ENTRY_CHARS = 262_144;
export const DEFAULT_MAX_ADDRESSES = 200_000;
const TAIL_KEEP = 128;
const ADDRESS_PATTERN = /^[A-Za-z0-9]{16,128}$/;

const OPEN_ENTRY = /<(?:[\w.-]+:)?sdnEntry(?=[\s>/])[^>]{0,2000}>/g;
const CLOSE_ENTRY = /<\/(?:[\w.-]+:)?sdnEntry\s*>/g;
const ROOT_CLOSE = /<\/(?:[\w.-]+:)?sdnList\s*>\s*$/;
const ID_BLOCK = /<id>([\s\S]{0,6000}?)<\/id>/g;
const DCA_TYPE = /^Digital Currency Address(?:\s*-\s*(.*))?$/i;

export class SdnParseError extends Error {
  constructor(readonly code: 'too_many_addresses', message: string) {
    super(message);
  }
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g, (_m, name: string) => {
    switch (name) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: {
        const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
      }
    }
  });
}

function tagText(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]{0,2000}?)</${tag}>`).exec(block);
  return match ? decodeEntities(match[1]).trim() : null;
}

function currencyOf(suffix: string | undefined): string | null {
  const value = (suffix ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{1,12}$/.test(value) ? value : null;
}

/** Reads one `<sdnEntry>` body. Exported for unit tests. */
export function extractEntry(body: string, sink: ParsedSanctionAddress[], counters: { rejected: number }): void {
  if (!/Digital Currency Address/i.test(body)) return;
  const head = body.slice(0, Math.max(0, body.search(/<(?:akaList|addressList|idList|programList)>/)) || 2000);
  const entryUid = /^\s*<uid>\s*(\d{1,12})\s*<\/uid>/.exec(body)?.[1] ?? tagText(head, 'uid');
  const last = tagText(head, 'lastName');
  const first = tagText(head, 'firstName');
  const listedName = last || first ? [last, first].filter(Boolean).join(', ').slice(0, 300) : null;

  ID_BLOCK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ID_BLOCK.exec(body)) !== null) {
    const type = tagText(match[1], 'idType');
    const dca = type ? DCA_TYPE.exec(type) : null;
    if (!dca) continue;
    const number = tagText(match[1], 'idNumber');
    if (number === null || !ADDRESS_PATTERN.test(number)) {
      counters.rejected += 1;
      continue;
    }
    sink.push({ address: number, currency: currencyOf(dca[1]), entryUid: entryUid && /^\d{1,12}$/.test(entryUid) ? entryUid : null, listedName });
  }
}

function indexFrom(re: RegExp, text: string, from = 0): { index: number; end: number } | null {
  re.lastIndex = from;
  const match = re.exec(text);
  return match ? { index: match.index, end: match.index + match[0].length } : null;
}

export async function parseSdnXml(chunks: AsyncIterable<Uint8Array | string>, options: SdnParseOptions = {}): Promise<SdnParseResult> {
  const maxEntryChars = options.maxEntryChars ?? DEFAULT_MAX_ENTRY_CHARS;
  const maxAddresses = options.maxAddresses ?? DEFAULT_MAX_ADDRESSES;
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const addresses: ParsedSanctionAddress[] = [];
  const counters = { rejected: 0 };
  let entriesSeen = 0;
  let malformed = 0;
  let buffer = '';
  let tail = '';
  /** 'between' = outside an entry, 'inside' = collecting a body, 'skipping' = discarding an oversize body until its end. */
  let state: 'between' | 'inside' | 'skipping' = 'between';

  const drain = (final: boolean): void => {
    for (;;) {
      if (state === 'between') {
        const open = indexFrom(OPEN_ENTRY, buffer);
        if (!open) {
          buffer = buffer.length > TAIL_KEEP ? buffer.slice(-TAIL_KEEP) : buffer;
          return;
        }
        const selfClosing = buffer[open.end - 2] === '/';
        buffer = buffer.slice(open.end);
        if (!selfClosing) state = 'inside';
        continue;
      }
      const close = indexFrom(CLOSE_ENTRY, buffer);
      const open = indexFrom(OPEN_ENTRY, buffer);
      if (open && (!close || open.index < close.index)) {
        // A new entry starts before this one closed: the earlier block was cut off.
        malformed += 1;
        buffer = buffer.slice(open.index);
        state = 'between';
        continue;
      }
      if (close) {
        if (state === 'inside') {
          entriesSeen += 1;
          extractEntry(buffer.slice(0, close.index), addresses, counters);
          if (addresses.length > maxAddresses) throw new SdnParseError('too_many_addresses', 'The list holds more addresses than allowed.');
        }
        buffer = buffer.slice(close.end);
        state = 'between';
        continue;
      }
      if (state === 'skipping') {
        buffer = buffer.length > TAIL_KEEP ? buffer.slice(-TAIL_KEEP) : buffer;
        return;
      }
      if (buffer.length > maxEntryChars) {
        malformed += 1;
        state = 'skipping';
        buffer = buffer.slice(-TAIL_KEEP);
        continue;
      }
      if (final) malformed += 1;
      return;
    }
  };

  for await (const chunk of chunks) {
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    tail = (tail + text).slice(-TAIL_KEEP * 2);
    buffer += text;
    drain(false);
  }
  const rest = decoder.decode();
  if (rest) {
    tail = (tail + rest).slice(-TAIL_KEEP * 2);
    buffer += rest;
  }
  drain(true);

  return {
    addresses,
    entriesSeen,
    rejectedAddresses: counters.rejected,
    malformedEntries: malformed,
    complete: ROOT_CLOSE.test(tail),
  };
}
