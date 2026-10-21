'use server';

import { redirect } from 'next/navigation';
import { apiBase, callApi } from '../../lib/server/api';
import { actionApi, guardAction } from '../../lib/server/action-guard';
import { sameOriginError } from '../../lib/server/origin';
import { clearSessionCookie, setSessionCookie } from '../../lib/server/session';

export interface SignInState { error?: string; email?: string }
export interface PasswordState { ok?: boolean; error?: string }

const GENERIC = 'Invalid sign-in.';

export async function signIn(_previous: SignInState, formData: FormData): Promise<SignInState> {
  const blocked = await sameOriginError();
  if (blocked) return { error: blocked };

  const email = String(formData.get('email') ?? '').trim().slice(0, 254);
  const password = String(formData.get('password') ?? '').slice(0, 1024);
  const totp = String(formData.get('totp') ?? '').replace(/\s+/g, '');
  if (!email || !password || !/^\d{6}$/.test(totp)) {
    return { error: 'Enter your email, password and the 6-digit code from your authenticator app.', email };
  }

  // Not callApi(): there is no token yet, so this is a plain unauthenticated POST.
  let response: Response;
  try {
    response = await fetch(`${apiBase()}/admin/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ email, password, totp }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return { error: 'The admin API could not be reached. Try again shortly.', email };
  }

  if (response.status === 503) return { error: 'Admin sign-in is not configured.', email };
  if (response.status === 429) return { error: 'Too many attempts. Wait a few minutes and try again.', email };
  if (!response.ok) return { error: response.status === 401 || response.status === 400 ? GENERIC : 'Sign-in is unavailable right now. Try again shortly.', email };

  let token: unknown;
  let expiresAt: unknown;
  try {
    ({ token, expiresAt } = (await response.json()) as { token?: unknown; expiresAt?: unknown });
  } catch {
    return { error: 'Sign-in is unavailable right now. Try again shortly.', email };
  }
  const expires = typeof expiresAt === 'string' ? new Date(expiresAt) : null;
  if (typeof token !== 'string' || !token || !expires || Number.isNaN(expires.getTime()) || expires.getTime() <= Date.now()) {
    return { error: 'Sign-in is unavailable right now. Try again shortly.', email };
  }
  await setSessionCookie(token, expires);
  redirect('/');
}

export async function signOut(): Promise<void> {
  const blocked = await sameOriginError();
  if (blocked) redirect('/');
  // Tell the API to end the session first, then clear the cookie whatever the outcome.
  await callApi('/admin/auth/logout', { method: 'POST' });
  await clearSessionCookie();
  redirect('/sign-in?reason=signed-out');
}

export async function changePassword(_previous: PasswordState, formData: FormData): Promise<PasswordState> {
  const guard = await guardAction();
  if (!guard.ok) return { error: guard.message };
  const currentPassword = String(formData.get('currentPassword') ?? '');
  const newPassword = String(formData.get('newPassword') ?? '');
  const confirm = String(formData.get('confirmPassword') ?? '');
  if (!currentPassword || !newPassword) return { error: 'Enter your current password and a new password.' };
  if (newPassword !== confirm) return { error: 'The new password and its confirmation do not match.' };
  if (newPassword === currentPassword) return { error: 'The new password must be different from the current password.' };
  if (newPassword.length > 1024) return { error: 'The new password is too long.' };
  const result = await actionApi<void>('/admin/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } });
  if (!result.ok) return { error: result.message };
  return { ok: true };
}
