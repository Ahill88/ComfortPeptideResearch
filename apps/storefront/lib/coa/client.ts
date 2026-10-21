/**
 * Typed client for the PUBLIC COA API. Usable from server components (SSR) and the browser.
 * Every response is parsed by the strict validators in ./model; the callers only ever see validated, field-whitelisted data.
 * `fetchImpl` is injectable so the node tests exercise the real code paths without a network.
 */
import { isLotCode, isSha256Hex, normalizeSha256 } from './codes';
import { parseAnchorInfo, parseByHashResult, parseProductLot, parsePublicLotRecord } from './model';
import type { AnchorInfo, ByHashResult, ProductLotState, PublicCoa, PublicLotRecord } from './model';
import { sha256Hex } from './hash';

const DEFAULT_BASE = 'http://localhost:3001/v1';
const clean = (v: string) => v.replace(/\/+$/, '');

/** Base URL the BROWSER uses (and that every link rendered into HTML must use). Same env pattern as lib/wallet/api.ts. */
export function publicApiBase(): string {
  return clean(process.env.NEXT_PUBLIC_API_URL ?? DEFAULT_BASE);
}
/** Base URL for server-side fetches: API_URL (e.g. an internal hostname) if set, else the public one. Falls back identically. */
export function serverApiBase(): string {
  return clean((typeof window === 'undefined' ? process.env.API_URL : undefined) ?? process.env.NEXT_PUBLIC_API_URL ?? DEFAULT_BASE);
}
/** Absolute, browser-reachable URL for a PDF path such as '/v1/public/lots/X/coa/1.pdf'. Uses the PUBLIC origin, never API_URL. */
export function pdfHref(file: PublicCoa['file'], base: string = publicApiBase()): string {
  return `${new URL(base).origin}${file.url}`;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Options = { base?: string; signal?: AbortSignal; fetchImpl?: FetchLike };

const MAX_JSON_CHARS = 1_000_000;
const TIMEOUT_MS = 8000;

async function getJson(path: string, options: Options): Promise<{ status: number; body: unknown } | null> {
  const doFetch: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const signal = options.signal ?? (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(TIMEOUT_MS) : undefined);
  try {
    const response = await doFetch(`${options.base ?? serverApiBase()}${path}`, { headers: { Accept: 'application/json' }, cache: 'no-store', signal });
    const text = await response.text();
    if (text.length > MAX_JSON_CHARS) return { status: response.status, body: undefined };
    let body: unknown;
    try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
    return { status: response.status, body };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError' && options.signal?.aborted) throw error;
    return null;
  }
}

export type LotLookup = { kind: 'found'; record: PublicLotRecord } | { kind: 'not-found' } | { kind: 'unavailable' };

export async function fetchLotRecord(lotCode: string, options: Options = {}): Promise<LotLookup> {
  if (!isLotCode(lotCode)) return { kind: 'not-found' };
  const res = await getJson(`/public/lots/${encodeURIComponent(lotCode)}`, options);
  if (!res) return { kind: 'unavailable' };
  if (res.status === 404) return { kind: 'not-found' };
  if (res.status !== 200) return { kind: 'unavailable' };
  const record = parsePublicLotRecord(res.body);
  // A record for a different lot than the one asked for is never shown (case is compared loosely; the record's own spelling is displayed).
  if (!record || record.lotCode.toLowerCase() !== lotCode.toLowerCase()) return { kind: 'unavailable' };
  return { kind: 'found', record };
}

export type HashLookup = { kind: 'result'; result: ByHashResult } | { kind: 'unavailable' };
export async function fetchByHash(sha256: string, options: Options = {}): Promise<HashLookup> {
  if (!isSha256Hex(sha256)) return { kind: 'unavailable' };
  const res = await getJson(`/public/coa/by-hash/${normalizeSha256(sha256)}`, { base: publicApiBase(), ...options });
  if (!res || res.status !== 200) return { kind: 'unavailable' };
  const result = parseByHashResult(res.body);
  return result ? { kind: 'result', result } : { kind: 'unavailable' };
}

export async function fetchAnchorInfo(options: Options = {}): Promise<AnchorInfo | null> {
  const res = await getJson('/public/anchor-info', options);
  return res && res.status === 200 ? parseAnchorInfo(res.body) : null;
}

export type ProductLookup = { kind: 'ok'; lot: ProductLotState } | { kind: 'unavailable' };
export async function fetchProductLot(slug: string, options: Options = {}): Promise<ProductLookup> {
  const res = await getJson(`/products/${encodeURIComponent(slug)}`, { base: publicApiBase(), ...options });
  if (!res) return { kind: 'unavailable' };
  // An unknown product has no lot and so no published COA: say that, not "unavailable".
  if (res.status === 404) return { kind: 'ok', lot: { state: 'none' } };
  if (res.status !== 200) return { kind: 'unavailable' };
  const lot = parseProductLot(res.body);
  return lot ? { kind: 'ok', lot } : { kind: 'unavailable' };
}

export type PdfHashResult = { kind: 'hashed'; sha256: string } | { kind: 'failed'; reason: 'network' | 'status' | 'hash' };
/** Download the PDF in the browser and hash it locally. Needs the API to allow cross-origin reads; failure is reported, never guessed. */
export async function hashRemotePdf(url: string, options: { signal?: AbortSignal; fetchImpl?: FetchLike } = {}): Promise<PdfHashResult> {
  const doFetch: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  let response: Response;
  try { response = await doFetch(url, { cache: 'no-store', signal: options.signal }); } catch (error) {
    if (options.signal?.aborted) throw error;
    return { kind: 'failed', reason: 'network' };
  }
  if (!response.ok) return { kind: 'failed', reason: 'status' };
  try { return { kind: 'hashed', sha256: await sha256Hex(await response.arrayBuffer()) }; } catch { return { kind: 'failed', reason: 'hash' }; }
}
