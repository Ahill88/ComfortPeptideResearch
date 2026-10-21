import { createHash } from 'node:crypto';
import { parseSdnXml, SdnParseError, type SdnParseResult } from './sdn-xml.parser';

export const MAX_LIST_BYTES = 200 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;

/** Failure whose `publicMessage` is safe to store and show to an admin: no URL, query, address or provider text. */
export class SanctionsFetchError extends Error {
  constructor(readonly code: string, readonly publicMessage: string) {
    super(publicMessage);
  }
}

export interface SanctionsDownload extends SdnParseResult {
  sha256: string;
  bytes: number;
}

export interface FetchSanctionsOptions {
  url: string;
  /** Plain http only for local fixtures in development/test. */
  allowInsecure?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  /** Test seam; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export type SanctionsFetcher = (options: FetchSanctionsOptions) => Promise<SanctionsDownload>;

async function* meteredBody(body: ReadableStream<Uint8Array>, hash: ReturnType<typeof createHash>, maxBytes: number, counter: { bytes: number }, abort: () => void) {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      counter.bytes += value.byteLength;
      if (counter.bytes > maxBytes) {
        abort();
        throw new SanctionsFetchError('too_large', 'The list download exceeded the size limit.');
      }
      hash.update(value);
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Downloads and parses the SDN list. Bounded by size (default 200 MB, counted on decoded bytes) and by ONE overall deadline (default 60 s,
 * covering redirects and the body). Redirects are followed by hand (max 5, https only unless `allowInsecure`): the official URL answers 302
 * to a short-lived signed storage URL. The body is streamed through the parser and a SHA-256, never buffered whole and never evaluated.
 */
export const fetchSdnList: SanctionsFetcher = async (options) => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? MAX_LIST_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? FETCH_TIMEOUT_MS);
  const hash = createHash('sha256');
  const counter = { bytes: 0 };
  try {
    let url = options.url;
    let response: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && !(options.allowInsecure && parsed.protocol === 'http:')) {
        throw new SanctionsFetchError('insecure_url', 'The list source must use https.');
      }
      const res = await fetchImpl(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'application/xml, text/xml;q=0.9, */*;q=0.1', 'user-agent': 'helix-field-api sanctions-refresh' },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => undefined);
        if (!location || hop === MAX_REDIRECTS) throw new SanctionsFetchError('redirects', 'The list source redirected too many times.');
        url = new URL(location, url).toString();
        continue;
      }
      response = res;
      break;
    }
    if (!response) throw new SanctionsFetchError('redirects', 'The list source redirected too many times.');
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new SanctionsFetchError('http_status', `The list source answered HTTP ${response.status}.`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new SanctionsFetchError('too_large', 'The list download exceeded the size limit.');
    }
    if (!response.body) throw new SanctionsFetchError('empty', 'The list source returned no body.');

    const parsedList = await parseSdnXml(meteredBody(response.body, hash, maxBytes, counter, () => controller.abort()));
    if (!parsedList.complete) throw new SanctionsFetchError('truncated', 'The list download was cut off or is not an SDN XML document.');
    if (parsedList.entriesSeen === 0) throw new SanctionsFetchError('format', 'The list did not contain any SDN entries (unrecognised format).');
    return { ...parsedList, sha256: hash.digest('hex'), bytes: counter.bytes };
  } catch (error) {
    if (error instanceof SanctionsFetchError) throw error;
    if (error instanceof SdnParseError) throw new SanctionsFetchError('too_many_addresses', 'The list held more addresses than allowed.');
    if (controller.signal.aborted) throw new SanctionsFetchError('timeout', 'The list download timed out.');
    throw new SanctionsFetchError('network', 'The list source could not be reached.');
  } finally {
    clearTimeout(timer);
  }
};
