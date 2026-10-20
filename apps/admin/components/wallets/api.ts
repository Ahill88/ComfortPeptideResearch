// Server-only module: import from server components only (the token must never reach the browser).
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: 'not-configured' | 'unauthorized' | 'unavailable'; message: string };

const DEFAULT_API_URL = 'http://localhost:3001/v1';

type Params = Record<string, string | undefined>;

/**
 * Server-side fetch of the read-only wallet admin API. The admin token stays on the server
 * (never sent to the browser) and is never included in error messages. Failures are returned
 * as explicit states so the UI never displays fabricated numbers.
 */
export async function fetchWalletAdmin<T>(path: string, params: Params = {}): Promise<ApiResult<T>> {
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) {
    return {
      ok: false,
      reason: 'not-configured',
      message: 'ADMIN_API_TOKEN is not set on the admin server, so wallet reporting data cannot be requested.',
    };
  }

  const base = (process.env.API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
  const url = new URL(`${base}/admin/wallets/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }

  try {
    const response = await fetch(url, {
      headers: { 'x-admin-token': token, accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'unauthorized', message: 'The API rejected the admin token. Check that ADMIN_API_TOKEN matches on both servers.' };
    }
    if (!response.ok) {
      return { ok: false, reason: 'unavailable', message: `The wallet admin API responded with status ${response.status}.` };
    }
    return { ok: true, data: (await response.json()) as T };
  } catch {
    return { ok: false, reason: 'unavailable', message: 'The wallet admin API could not be reached. No data is shown.' };
  }
}
