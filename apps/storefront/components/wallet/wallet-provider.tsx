'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAuth } from '../auth-provider';
import { errorMessage, fetchBalance, fetchWallet, registerWallet, WalletApiError, type WalletBalance } from '../../lib/wallet/api';
import { getWalletProvider, type WalletProviderDescriptor } from '../../lib/wallet/provider-selector';
import type { WalletSigner } from '../../lib/wallet/sandbox-signer';

const POLL_INTERVAL_MS = 15_000;

/** loading: opening local wallet. ready: signer available. none: no wallet (e.g. just deleted). error: local storage problem. */
export type WalletPhase = 'loading' | 'ready' | 'none' | 'error';
/** checking: not yet contacted. online: last call worked. unavailable: API unreachable / 5xx. */
export type ServiceStatus = 'checking' | 'online' | 'unavailable';

/** The service refused to link this browser's wallet (e.g. 409: the account is already linked to a different address). */
export type LinkProblem = { message: string; status: number | null; linkedAddress: string | null };

export type WalletContextValue = {
  email: string | null;
  phase: WalletPhase;
  phaseError: string | null;
  provider: WalletProviderDescriptor;
  signer: WalletSigner | null;
  address: string | null;
  registered: boolean;
  service: ServiceStatus;
  serviceError: string | null;
  balance: WalletBalance | null;
  /** True only when the balance came from the last successful balance call, the service reported it fresh, and the service is reachable now. */
  balanceFresh: boolean;
  /** Set when linking this browser's wallet to the account failed for a reason other than the service being down. No balance is read in this state. */
  linkProblem: LinkProblem | null;
  balanceLoading: boolean;
  lastUpdated: Date | null;
  /** Fetches the balance now. Resolves with the fresh balance, or null when unavailable. Never fabricates a value. */
  refresh: () => Promise<WalletBalance | null>;
  createSandboxWallet: () => void;
  /** IRREVERSIBLE: removes the sandbox key from this browser. */
  deleteSandboxWallet: () => void;
};

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const email = session?.email ?? null;
  const provider = getWalletProvider('sandbox');
  const [phase, setPhase] = useState<WalletPhase>('loading');
  const [phaseError, setPhaseError] = useState<string | null>(null);
  const [signer, setSigner] = useState<WalletSigner | null>(null);
  const [registered, setRegistered] = useState(false);
  const [service, setService] = useState<ServiceStatus>('checking');
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [balance, setBalance] = useState<WalletBalance | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [linkProblem, setLinkProblem] = useState<LinkProblem | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const registeredRef = useRef(false);
  const inFlight = useRef<{ generation: number; promise: Promise<WalletBalance | null> } | null>(null);
  /** Bumped whenever the account or wallet changes so a response for the previous identity can never be shown for the new one. */
  const generation = useRef(0);

  // Load or create the sandbox wallet once the customer is signed in.
  useEffect(() => {
    generation.current += 1;
    registeredRef.current = false;
    setRegistered(false);
    setBalance(null);
    setBalanceLoading(false);
    setLinkProblem(null);
    setLastUpdated(null);
    setService('checking');
    if (!email) { setSigner(null); setPhase('loading'); return; }
    try {
      setSigner(provider.load(email) ?? provider.create(email));
      setPhase('ready');
      setPhaseError(null);
    } catch (error) {
      setSigner(null);
      setPhase('error');
      setPhaseError(errorMessage(error, 'The sandbox wallet could not be opened in this browser.'));
    }
  }, [email, provider]);

  const address = signer?.address ?? null;

  const refresh = useCallback(async (): Promise<WalletBalance | null> => {
    if (!email || !address || !signer) return null;
    const mine = generation.current;
    if (inFlight.current && inFlight.current.generation === mine) return inFlight.current.promise;
    const run = (async () => {
      setBalanceLoading(true);
      try {
        // Only the PUBLIC address and a signature (made locally by this browser's key) are sent to the API.
        if (!registeredRef.current) {
          // Already linked to this very address (the usual case after the first visit): no need to sign again.
          const linked = await fetchWallet(email);
          if (linked?.address !== address) {
            // Link with proof of control: challenge -> sign in this browser -> register.
            await registerWallet(email, address, provider.id, (message) => signer.signMessage(message));
          }
          if (generation.current !== mine) return null;
          registeredRef.current = true;
          setRegistered(true);
          setLinkProblem(null);
        }
        const next = await fetchBalance(email);
        if (generation.current !== mine) return null;
        setBalance(next);
        setLastUpdated(new Date());
        setService('online');
        setServiceError(null);
        return next;
      } catch (error) {
        if (generation.current !== mine) return null;
        const unavailable = error instanceof WalletApiError ? error.unavailable : true;
        setService(unavailable ? 'unavailable' : 'online');
        setServiceError(unavailable ? 'Wallet service unavailable' : errorMessage(error));
        if (!unavailable && !registeredRef.current) {
          // The service answered but refused to link this wallet (typically 409: one wallet per customer and a different one is already linked).
          let linkedAddress: string | null = null;
          try { linkedAddress = (await fetchWallet(email))?.address ?? null; } catch { linkedAddress = null; }
          if (generation.current !== mine) return null;
          setLinkProblem({ message: errorMessage(error), status: error instanceof WalletApiError ? error.status : null, linkedAddress });
          setBalance(null);
        }
        // Keep the last real balance (if any) but it is flagged stale in the UI via service status.
        return null;
      } finally {
        if (generation.current === mine) setBalanceLoading(false);
        if (inFlight.current?.generation === mine) inFlight.current = null;
      }
    })();
    inFlight.current = { generation: mine, promise: run };
    return run;
  }, [address, email, provider.id, signer]);

  // Poll every 15s, paused while the tab is hidden; refresh immediately when it becomes visible again.
  useEffect(() => {
    if (!address || !email) return;
    void refresh();
    const tick = () => { if (document.visibilityState === 'visible') void refresh(); };
    const timer = window.setInterval(tick, POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [address, email, refresh]);

  const createSandboxWallet = useCallback(() => {
    if (!email) return;
    generation.current += 1;
    registeredRef.current = false;
    setRegistered(false);
    setBalance(null);
    setLinkProblem(null);
    try {
      setSigner(provider.create(email));
      setPhase('ready');
      setPhaseError(null);
    } catch (error) {
      setPhase('error');
      setPhaseError(errorMessage(error, 'The sandbox wallet could not be created in this browser.'));
    }
  }, [email, provider]);

  const deleteSandboxWallet = useCallback(() => {
    if (!email) return;
    provider.destroy(email);
    generation.current += 1;
    registeredRef.current = false;
    setBalanceLoading(false);
    setLinkProblem(null);
    setRegistered(false);
    setSigner(null);
    setBalance(null);
    setLastUpdated(null);
    setPhase('none');
  }, [email, provider]);

  const balanceFresh = balance !== null && !balance.stale && service === 'online' && linkProblem === null;
  const value = useMemo<WalletContextValue>(() => ({
    email, phase, phaseError, provider, signer, address, registered, service, serviceError, balance, balanceFresh, linkProblem, balanceLoading, lastUpdated, refresh, createSandboxWallet, deleteSandboxWallet,
  }), [email, phase, phaseError, provider, signer, address, registered, service, serviceError, balance, balanceFresh, linkProblem, balanceLoading, lastUpdated, refresh, createSandboxWallet, deleteSandboxWallet]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const wallet = useContext(WalletContext);
  if (!wallet) throw new Error('useWallet must be used within WalletProvider');
  return wallet;
}
