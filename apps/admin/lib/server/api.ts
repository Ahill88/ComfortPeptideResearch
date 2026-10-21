// Server-only module: never import from a client component. The session token is read from the httpOnly cookie
// here, sent as a Bearer header, and never returned, logged, or placed in a URL or error message.
import { cookies } from 'next/headers';
import { SESSION_COOKIE } from './cookie';

const DEFAULT_API_URL = 'http://localhost:3001/v1';

export type FailureKind = 'unauthorized' | 'forbidden' | 'not-found' | 'conflict' | 'invalid' | 'unavailable' | 'error';
export interface ApiSuccess<T> { ok: true; status: number; data: T }
export interface ApiFailure { ok: false; status: number; kind: FailureKind; message: string }
export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export function apiBase(): string {
  return (process.env.API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
}

interface Options {
  method?: 'GET' | 'POST';
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
  /** Explicit token (used right after login, before the cookie exists). Defaults to the session cookie. */
  token?: string;
}

function kindFor(status: number): FailureKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === 400 || status === 422) return 'invalid';
  return 'error';
}

const FALLBACK: Record<FailureKind, string> = {
  unauthorized: 'Your session is no longer valid.',
  forbidden: 'You do not have permission to do that.',
  'not-found': 'Not found.',
  conflict: 'That action conflicts with the current state.',
  invalid: 'The request was not accepted.',
  unavailable: 'The admin API could not be reached. Nothing was changed.',
  error: 'The admin API reported an error. Try again.',
};

/** Extract the API's `message` for client-facing 4xx errors. 5xx bodies are never echoed. */
async function messageFrom(response: Response, kind: FailureKind): Promise<string> {
  if (response.status >= 500) return FALLBACK.error;
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string' && body.message.trim()) return body.message.slice(0, 500);
    if (Array.isArray(body.message)) {
      const text = body.message.filter((m): m is string => typeof m === 'string').join(' ');
      if (text) return text.slice(0, 500);
    }
  } catch { /* fall through to the generic text */ }
  return FALLBACK[kind];
}

export async function callApi<T>(path: string, options: Options = {}): Promise<ApiResult<T>> {
  const token = options.token ?? (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return { ok: false, status: 401, kind: 'unauthorized', message: FALLBACK.unauthorized };

  const url = new URL(`${apiBase()}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${token}` };
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return { ok: false, status: 503, kind: 'unavailable', message: FALLBACK.unavailable };
  }

  if (response.ok) {
    if (response.status === 204) return { ok: true, status: 204, data: undefined as T };
    try {
      return { ok: true, status: response.status, data: (await response.json()) as T };
    } catch {
      return { ok: false, status: 502, kind: 'error', message: FALLBACK.error };
    }
  }
  const kind = kindFor(response.status);
  return { ok: false, status: response.status, kind, message: await messageFrom(response, kind) };
}
