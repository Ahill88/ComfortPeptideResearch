import type { EnvLike } from '../config/runtime';

/**
 * Helper for CALLERS (auth) that build the links they pass as `data.link`:
 * `<STOREFRONT_PUBLIC_URL>/verify-email?token=...` and `<STOREFRONT_PUBLIC_URL>/reset-password?token=...`.
 * Returns null when STOREFRONT_PUBLIC_URL is unset or not an http(s) URL (the caller decides what to do; never fall back to a
 * request header). The token is URL-encoded.
 */
export function buildStorefrontLink(kind: 'verify-email' | 'reset-password', token: string, env: EnvLike = process.env): string | null {
  const base = env.STOREFRONT_PUBLIC_URL?.trim();
  if (!base) return null;
  try {
    const origin = new URL(base);
    if (origin.protocol !== 'https:' && origin.protocol !== 'http:') return null;
    return `${origin.origin}/${kind}?token=${encodeURIComponent(token)}`;
  } catch {
    return null;
  }
}
