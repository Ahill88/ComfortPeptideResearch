import { redirect } from 'next/navigation';
import { callApi, type ApiResult } from './api';
import { sameOriginError } from './origin';
import { clearSessionCookie, loadSession, type Authed } from './session';

export interface ActionFailure { ok: false; message: string }

/** First line of every state-changing server action: same-origin + a live, verified session (+ role). */
export async function guardAction(role?: 'OWNER'): Promise<{ ok: true; auth: Authed } | ActionFailure> {
  const origin = await sameOriginError();
  if (origin) return { ok: false, message: origin };
  const s = await loadSession();
  if (s.state === 'none') redirect('/sign-in');
  if (s.state === 'expired') {
    await clearSessionCookie();
    redirect('/sign-in?reason=expired');
  }
  if (s.state === 'unavailable') return { ok: false, message: 'The admin API could not be reached. Nothing was changed.' };
  if (role && s.admin.role !== role) return { ok: false, message: 'Only an owner can do that.' };
  return { ok: true, auth: { admin: s.admin, session: s.session } };
}

/** Calls the API from an action; a 401 clears the cookie and sends the user to sign in again. */
export async function actionApi<T>(path: string, options: Parameters<typeof callApi>[1] = {}): Promise<ApiResult<T>> {
  const result = await callApi<T>(path, options);
  if (!result.ok && result.kind === 'unauthorized') {
    await clearSessionCookie();
    redirect('/sign-in?reason=expired');
  }
  return result;
}
