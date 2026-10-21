import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { AdminIdentity, SessionInfo } from '../types';
import { callApi, type ApiResult } from './api';
import { SESSION_COOKIE, baseCookieOptions } from './cookie';

export type SessionState =
  | { state: 'ok'; admin: AdminIdentity; session: SessionInfo }
  | { state: 'none' }
  | { state: 'expired' }
  | { state: 'unavailable' };

/** Verifies the cookie's token with GET /admin/auth/me. Memoised per request, so every component shares one call. */
export const loadSession = cache(async (): Promise<SessionState> => {
  if (!(await cookies()).get(SESSION_COOKIE)?.value) return { state: 'none' };
  const result = await callApi<{ admin: AdminIdentity; session: SessionInfo }>('/admin/auth/me');
  if (result.ok) {
    const { admin, session } = result.data;
    if (admin && typeof admin.email === 'string' && session) return { state: 'ok', admin, session };
    return { state: 'unavailable' };
  }
  if (result.kind === 'unauthorized') return { state: 'expired' };
  return { state: 'unavailable' };
});

export interface Authed { admin: AdminIdentity; session: SessionInfo }

/**
 * Every admin page calls this first. Server components cannot clear cookies, so an expired token redirects to
 * /session/expired (a route handler that clears the cookie and continues to /sign-in?reason=expired).
 */
export async function requireSession(): Promise<Authed> {
  const s = await loadSession();
  if (s.state === 'ok') return { admin: s.admin, session: s.session };
  if (s.state === 'none') redirect('/sign-in');
  if (s.state === 'expired') redirect('/session/expired');
  redirect('/unavailable');
}

/** For server components: any 401 from the API means the session is gone. */
export function expireOnUnauthorized(result: ApiResult<unknown>): void {
  if (!result.ok && result.kind === 'unauthorized') redirect('/session/expired');
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, { ...baseCookieOptions, expires: expiresAt });
}

/** Expire the cookie with the same attributes it was set with (required for `__Host-` cookies). */
export async function clearSessionCookie(): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, '', { ...baseCookieOptions, maxAge: 0, expires: new Date(0) });
}
