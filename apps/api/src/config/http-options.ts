import { isIP } from 'node:net';
import { EnvLike, blank, isNonProductionRuntime } from './runtime';

/* ------------------------------------------------------------------ CORS */

export interface ParsedOrigins {
  /** Normalised, de-duplicated exact origins (scheme://host[:port], no trailing slash). */
  origins: string[];
  /** Raw entries that were rejected, each with a reason. Never contains a wildcard that was accepted. */
  invalid: { entry: string; reason: string }[];
}

/**
 * Parses STOREFRONT_ORIGIN (comma list) into an exact-match allowlist. Wildcards, "null", paths,
 * credentials-in-URL and non-http(s) schemes are rejected rather than silently dropped so a bad
 * value fails startup instead of widening or breaking CORS.
 */
export function parseCorsOrigins(raw: string | undefined): ParsedOrigins {
  const origins: string[] = [];
  const invalid: ParsedOrigins['invalid'] = [];
  if (blank(raw)) return { origins, invalid };
  for (const part of (raw as string).split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    if (entry.includes('*')) {
      invalid.push({ entry, reason: 'wildcards are not allowed' });
      continue;
    }
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      invalid.push({ entry, reason: 'not a valid URL' });
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      invalid.push({ entry, reason: 'scheme must be http or https' });
      continue;
    }
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
      invalid.push({ entry, reason: 'must be a bare origin (scheme://host[:port]) with no path, query or credentials' });
      continue;
    }
    if (!origins.includes(url.origin)) origins.push(url.origin);
  }
  return { origins, invalid };
}

export const CORS_METHODS = ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'];
/** x-admin-token is intentionally absent: admin tooling must not be callable from a browser on the storefront origin. */
export const CORS_ALLOWED_HEADERS = ['Content-Type', 'Authorization', 'Idempotency-Key', 'x-customer-email'];
export const CORS_EXPOSED_HEADERS = ['Retry-After', 'RateLimit-Reset', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'];

export interface CorsConfig {
  origin: string[] | false;
  methods: string[];
  allowedHeaders: string[];
  exposedHeaders: string[];
  /** Browsers send the hf_session cookie with credentials:'include'; allowed ONLY for the exact origins above (never with a wildcard). */
  credentials: true;
  maxAge: number;
}

export function buildCorsOptions(env: EnvLike): CorsConfig {
  const { origins } = parseCorsOrigins(env.STOREFRONT_ORIGIN);
  return {
    origin: origins.length ? origins : false,
    methods: CORS_METHODS,
    allowedHeaders: CORS_ALLOWED_HEADERS,
    exposedHeaders: CORS_EXPOSED_HEADERS,
    credentials: true,
    maxAge: 600,
  };
}

/* ----------------------------------------------------------- trust proxy */

export type TrustProxySetting = false | number | string[];

const PROXY_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);

function validProxyEntry(entry: string): boolean {
  if (PROXY_KEYWORDS.has(entry)) return true;
  const [address, prefix, ...rest] = entry.split('/');
  if (rest.length) return false;
  const family = isIP(address);
  if (!family) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

/**
 * TRUST_PROXY (default: unset = false = ignore X-Forwarded-For entirely).
 *  - integer N >= 1: trust exactly N proxy hops in front of the app
 *  - comma list of IPs / CIDRs / loopback|linklocal|uniquelocal: trust only those proxies
 * The literal "true" is rejected: it makes req.ip (and so rate limiting) spoofable by any client.
 */
export function parseTrustProxy(raw: string | undefined): { value: TrustProxySetting; error?: string } {
  if (blank(raw)) return { value: false };
  const text = (raw as string).trim();
  const lower = text.toLowerCase();
  if (lower === 'false' || lower === '0') return { value: false };
  if (lower === 'true') {
    return { value: false, error: 'TRUST_PROXY=true trusts X-Forwarded-For from any client; use a hop count (e.g. 1) or a list of proxy IPs/CIDRs' };
  }
  if (/^\d+$/.test(text)) {
    const hops = Number(text);
    if (hops > 10) return { value: false, error: 'TRUST_PROXY hop count must be between 1 and 10' };
    return { value: hops };
  }
  const entries = text.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (!entries.length || !entries.every(validProxyEntry)) {
    return { value: false, error: 'TRUST_PROXY must be false, a hop count, or a comma list of IPs/CIDRs/loopback|linklocal|uniquelocal' };
  }
  return { value: entries };
}

/* ------------------------------------------------------------------ docs */

/**
 * Swagger UI is served only on development/test runtimes, or when ENABLE_API_DOCS is exactly "true".
 * Uses the strict allowlist: an unset or unknown NODE_ENV does NOT expose the docs.
 */
export function shouldEnableDocs(env: EnvLike): boolean {
  return isNonProductionRuntime(env) || env.ENABLE_API_DOCS === 'true';
}
