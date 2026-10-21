import type { AddressInput } from './types';
import { InvalidAuthResponse, normalizeEmail, parseAccepted, parseAddress, parseAddresses, parseCustomer, parseEligibility, parseEnrollment, parseSession } from './validation';

const API_BASE_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/v1').replace(/\/+$/, '');
export const AUTH_EXPIRED_EVENT = 'hf:customer-session-expired';
export class AuthApiError extends Error {
  constructor(message: string, readonly status: number | null, readonly code: 'MFA_REQUIRED' | 'EMAIL_NOT_VERIFIED' | null = null) {
    super(message); this.name = 'AuthApiError';
  }
}

export function authErrorMessage(error: unknown): string {
  return error instanceof AuthApiError || error instanceof InvalidAuthResponse ? error.message : 'Unable to complete the request. Please try again.';
}

/** Cookies and Origin are browser-managed; JS never reads a session cookie or supplies a customer identity header. */
async function request(path: string, options: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; status: number; authenticated?: boolean; signal?: AbortSignal }): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? 'GET', credentials: 'include', cache: 'no-store', signal: options.signal,
      headers: { Accept: 'application/json', ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new AuthApiError('Account service is unavailable. Please try again.', null);
  }
  let data: unknown = null;
  try { if (response.status !== 204) data = await response.json(); } catch { /* HTML/empty failures get generic messages. */ }
  if (!response.ok) {
    if (response.status === 401 && options.authenticated && typeof window !== 'undefined') window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
    const code = data && typeof data === 'object' && 'code' in data ? data.code : null;
    if (path === '/auth/login') {
      if (response.status === 401 && code === 'MFA_REQUIRED') throw new AuthApiError('Enter your authentication code.', 401, code);
      if (response.status === 403 && code === 'EMAIL_NOT_VERIFIED') throw new AuthApiError('Verify your email before signing in. Open the verification link from your email.', 403, code);
      if (response.status === 401) throw new AuthApiError('Invalid sign-in. Check your email, password, and authentication code if enabled.', 401);
    }
    let message = 'Unable to complete the request. Please try again.';
    if (response.status >= 500) message = 'Account service is unavailable. Please try again.';
    else if (response.status === 429) message = 'Too many attempts. Please wait before trying again.';
    else if (response.status === 401) message = 'Your session has ended. Please sign in again.';
    else if (response.status === 400 && /(?:email-verification|password-reset)\/confirm$/.test(path)) message = 'Invalid or expired link. Please request a new link.';
    else if (response.status === 400 && path === '/auth/mfa/enroll/confirm') message = 'Invalid authentication code. Try a fresh 6-digit code.';
    else if (response.status === 403 && path === '/auth/mfa/disable') message = 'Invalid password or authentication code.';
    else if (response.status === 409) message = 'This information has changed or the account limit was reached. Refresh and try again.';
    else if (response.status === 404) message = 'This record is no longer available. Refresh and try again.';
    throw new AuthApiError(message, response.status);
  }
  if (response.status !== options.status) throw new InvalidAuthResponse();
  return data;
}

export const authApi = {
  async session(signal?: AbortSignal) {
    try { return parseSession(await request('/auth/session', { status: 200, signal })); }
    catch (error) { if (error instanceof AuthApiError && error.status === 401) return null; throw error; }
  },
  async login(email: string, password: string, totp?: string) {
    return parseSession(await request('/auth/login', { method: 'POST', status: 200, body: { email: normalizeEmail(email), password, ...(totp ? { totp: totp.trim() } : {}) } }));
  },
  async register(name: string, email: string, password: string) {
    parseAccepted(await request('/auth/register', { method: 'POST', status: 202, body: { email: normalizeEmail(email), password, ...(name.trim() ? { name: name.trim() } : {}) } }));
  },
  async verifyEmail(token: string) { await request('/auth/email-verification/confirm', { method: 'POST', status: 204, body: { token } }); },
  async logout() { await request('/auth/logout', { method: 'POST', status: 204, body: {} }); },
  async requestPasswordReset(email: string) { parseAccepted(await request('/auth/password-reset/request', { method: 'POST', status: 202, body: { email: normalizeEmail(email) } })); },
  async resetPassword(token: string, newPassword: string) { await request('/auth/password-reset/confirm', { method: 'POST', status: 204, body: { token, newPassword } }); },
  async profile(signal?: AbortSignal) { return parseCustomer(await request('/auth/profile', { status: 200, authenticated: true, signal })); },
  async updateProfile(name: string) { return parseCustomer(await request('/auth/profile', { method: 'PATCH', status: 200, authenticated: true, body: { name: name.trim() || null } })); },
  async eligibility() { return parseEligibility(await request('/account/eligibility', { status: 200, authenticated: true })); },
  async addresses(signal?: AbortSignal) { return parseAddresses(await request('/auth/addresses', { status: 200, authenticated: true, signal })); },
  async createAddress(body: AddressInput) { return parseAddress(await request('/auth/addresses', { method: 'POST', status: 201, authenticated: true, body })); },
  async updateAddress(id: string, body: Partial<AddressInput>) { return parseAddress(await request(`/auth/addresses/${encodeURIComponent(id)}`, { method: 'PATCH', status: 200, authenticated: true, body })); },
  async deleteAddress(id: string) { await request(`/auth/addresses/${encodeURIComponent(id)}`, { method: 'DELETE', status: 204, authenticated: true }); },
  async enrollMfa() { return parseEnrollment(await request('/auth/mfa/enroll', { method: 'POST', status: 201, authenticated: true, body: {} })); },
  async confirmMfa(code: string) { await request('/auth/mfa/enroll/confirm', { method: 'POST', status: 204, authenticated: true, body: { code: code.trim() } }); },
  async disableMfa(password: string, code: string) { await request('/auth/mfa/disable', { method: 'POST', status: 204, authenticated: true, body: { password, code: code.trim() } }); },
};
