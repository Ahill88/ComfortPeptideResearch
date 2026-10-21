'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AUTH_EXPIRED_EVENT, AuthApiError, authApi, authErrorMessage } from '../lib/auth/api';
import type { CustomerSession, EligibilityStatus } from '../lib/auth/types';
import { nameError, passwordError, validEmail, validToken } from '../lib/auth/validation';

/** @deprecated Type alias for existing consumers; this is now a server-authenticated session. */
export type PreviewSession = CustomerSession;
export type { CustomerSession } from '../lib/auth/types';

type AuthContextValue = {
  session: CustomerSession | null;
  isReady: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<CustomerSession | null>;
  signIn: (email: string, password?: string, totp?: string) => Promise<CustomerSession>;
  register: (name: string, email: string, password?: string) => Promise<void>;
  verifyEmail: (token?: string) => Promise<void>;
  /** @deprecated Navigation shim for the unused preview component. MFA cannot be toggled locally. */
  setMfaEnabled: (enabled: boolean) => void;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<CustomerSession | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const refresh = useCallback(async (): Promise<CustomerSession | null> => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const customer = await authApi.session();
      let next: CustomerSession | null = null;
      if (customer) {
        let eligibilityStatus: EligibilityStatus = 'UNKNOWN';
        try { eligibilityStatus = await authApi.eligibility(); } catch { /* Unknown is never approval. */ }
        next = {
          id: customer.id, name: customer.name ?? 'Research customer', email: customer.email,
          verified: customer.emailVerified, mfaEnabled: customer.mfaEnabled,
          eligible: eligibilityStatus === 'APPROVED', eligibilityStatus,
        };
      }
      if (current !== generation.current) return null;
      setSession(next);
      return next;
    } catch (cause) {
      if (current === generation.current) { setSession(null); setError(authErrorMessage(cause)); }
      return null;
    } finally {
      if (current === generation.current) { setLoading(false); setIsReady(true); }
    }
  }, []);

  useEffect(() => {
    // Delete, never parse, the old preview identity. Storage being disabled must not prevent sign-in.
    try { window.localStorage.removeItem('helix-field-local-preview-session'); } catch { /* Storage is optional. */ }
    void refresh();
    const expired = () => { ++generation.current; setSession(null); setError(null); setLoading(false); setIsReady(true); };
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener(AUTH_EXPIRED_EVENT, expired);
    document.addEventListener('visibilitychange', visible);
    return () => { ++generation.current; window.removeEventListener(AUTH_EXPIRED_EVENT, expired); document.removeEventListener('visibilitychange', visible); };
  }, [refresh]);

  return <AuthContext.Provider value={{
    session, isReady, loading, error, refresh,
    signIn: async (email, password, totp) => {
      if (!validEmail(email) || !password || password.length > 256) throw new AuthApiError('Enter your email and password.', 400);
      await authApi.login(email, password, totp);
      // Login's body alone is insufficient: confirm that the browser accepted the cookie via GET /auth/session.
      const next = await refresh();
      if (!next) throw new AuthApiError('Unable to confirm your session. Please try signing in again.', null);
      return next;
    },
    register: async (name, email, password) => {
      const problem = nameError(name) ?? passwordError(password);
      if (problem || !validEmail(email)) throw new AuthApiError(problem ?? 'Enter a valid email.', 400);
      await authApi.register(name, email, password!);
    },
    verifyEmail: async (token) => {
      if (!validToken(token)) throw new AuthApiError('Invalid or expired link. Please request a new link.', 400);
      await authApi.verifyEmail(token);
    },
    setMfaEnabled: () => { window.location.assign('/account/security'); },
    signOut: async () => {
      ++generation.current;
      await authApi.logout();
      ++generation.current;
      setSession(null); setError(null); setLoading(false); setIsReady(true);
    },
  }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error('useAuth must be used within AuthProvider');
  return auth;
}
