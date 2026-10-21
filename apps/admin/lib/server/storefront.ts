// Server-only: STOREFRONT_PUBLIC_URL is read at request time (never baked into the build, never sent as a secret).
/** Base of the public storefront without a trailing slash, or '' when unset/invalid (callers then show relative text). */
export function storefrontBase(): string {
  const raw = (process.env.STOREFRONT_PUBLIC_URL ?? '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
}
