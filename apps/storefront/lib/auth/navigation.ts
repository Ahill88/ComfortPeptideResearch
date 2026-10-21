/** Accept only root-relative paths. Check decoded forms too, including nested encodings and backslashes. */
export function sanitizeNextPath(value: unknown): string {
  const fallback = '/account';
  if (typeof value !== 'string' || value.length > 2048) return fallback;
  let decoded = value;
  for (let i = 0; i < 8; i++) {
    if (!decoded.startsWith('/') || decoded.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(decoded)) return fallback;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        const url = new URL(decoded, 'https://storefront.invalid');
        return url.origin === 'https://storefront.invalid' ? value : fallback;
      }
      decoded = next;
    } catch { return fallback; }
  }
  return fallback;
}

export function loginPath(next: string): string { return `/login?next=${encodeURIComponent(sanitizeNextPath(next))}`; }
