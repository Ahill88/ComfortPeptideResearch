'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

const STORAGE_KEY = 'helix-field-local-preview-session';

export type PreviewSession = {
  name: string;
  email: string;
  verified: boolean;
  eligible: boolean;
  mfaEnabled: boolean;
};

type AuthContextValue = {
  session: PreviewSession | null;
  isReady: boolean;
  signIn: (email: string) => void;
  register: (name: string, email: string) => void;
  verifyEmail: () => void;
  setMfaEnabled: (enabled: boolean) => void;
  signOut: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<PreviewSession | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try { setSession(JSON.parse(stored) as PreviewSession); } catch { window.localStorage.removeItem(STORAGE_KEY); }
    }
    setIsReady(true);
  }, []);

  const updateSession = (next: PreviewSession | null) => {
    setSession(next);
    if (next) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else window.localStorage.removeItem(STORAGE_KEY);
  };

  const createSession = (name: string, email: string, verified: boolean) => updateSession({ name, email: email.trim().toLowerCase(), verified, eligible: true, mfaEnabled: false });

  return <AuthContext.Provider value={{
    session,
    isReady,
    signIn: (email) => createSession(email.split('@')[0].replace(/[._-]/g, ' ') || 'Research customer', email, true),
    register: (name, email) => createSession(name.trim() || 'Research customer', email, false),
    verifyEmail: () => session && updateSession({ ...session, verified: true }),
    setMfaEnabled: (mfaEnabled) => session && updateSession({ ...session, mfaEnabled }),
    signOut: () => updateSession(null),
  }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error('useAuth must be used within AuthProvider');
  return auth;
}
