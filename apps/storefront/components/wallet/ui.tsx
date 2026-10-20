'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, Copy, Loader2 } from 'lucide-react';
import { ProtectedView } from '../account-views';
import { WalletProvider, useWallet } from './wallet-provider';
import { SANDBOX_DISCLOSURE } from '../../lib/wallet/sandbox-signer';
import type { WalletTransactionStatus } from '../../lib/wallet/api';

export const cardClass = 'rounded-2xl border border-silver bg-white p-6 sm:p-8';
export const buttonClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl border border-silver bg-white px-5 py-3 text-xs font-semibold text-midnight transition hover:bg-porcelain focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-midnight disabled:cursor-not-allowed disabled:opacity-50';
export const primaryButtonClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl border border-midnight bg-midnight px-5 py-3 text-xs font-semibold text-white transition hover:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-midnight disabled:cursor-not-allowed disabled:opacity-50';
export const inputClass = 'min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3.5 py-3 text-sm text-midnight outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-sky-100';
export const eyebrowClass = 'text-[10px] font-medium tracking-[.17em] text-slate-600';

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}...${address.slice(-6)}` : address;
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setFailed(false); } catch { setFailed(true); setCopied(false); }
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { setCopied(false); setFailed(false); }, 2000);
  };
  return <button type="button" className={buttonClass} onClick={copy}>
    {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    <span aria-live="polite">{copied ? 'Copied' : failed ? 'Copy failed - select manually' : label}</span>
  </button>;
}

const statusStyles: Record<WalletTransactionStatus, string> = {
  pending: 'border-amber-200 bg-amber-50 text-amber-800',
  finalized: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  failed: 'border-red-200 bg-red-50 text-red-800',
  unknown: 'border-silver bg-porcelain text-slate-600',
};
export function StatusBadge({ status, label }: { status: WalletTransactionStatus; label?: string }) {
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[.1em] ${statusStyles[status]}`}>{label ?? status}</span>;
}

export function Notice({ tone = 'info', title, children }: { tone?: 'info' | 'warn' | 'error' | 'success'; title?: string; children: ReactNode }) {
  const styles = { info: 'border-sky-100 bg-sky-50/60 text-slate-700', warn: 'border-amber-200 bg-amber-50 text-amber-900', error: 'border-red-200 bg-red-50 text-red-900', success: 'border-emerald-200 bg-emerald-50 text-emerald-900' }[tone];
  return <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-xl border p-4 text-sm leading-6 ${styles}`}>
    <div className="flex gap-3">{tone === 'warn' || tone === 'error' ? <AlertTriangle className="mt-1 shrink-0" size={16} aria-hidden="true" /> : null}<div>{title ? <p className="font-semibold">{title}</p> : null}<div>{children}</div></div></div>
  </div>;
}

export function Spinner({ label }: { label: string }) {
  return <p role="status" className="flex items-center gap-2 text-sm text-slate-600"><Loader2 className="animate-spin motion-reduce:animate-none" size={15} aria-hidden="true" />{label}</p>;
}

export const SANDBOX_NOTE = SANDBOX_DISCLOSURE;

export function SandboxBanner() {
  return <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-6 text-amber-900"><b>SANDBOX.</b> {SANDBOX_NOTE}</p>;
}

/** Page frame shared by every wallet route. Links go ONLY to wallet pages (plus the existing account page). */
export function WalletPageFrame({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return <ProtectedView><WalletProvider>
    <main className="mx-auto min-h-[60vh] max-w-[1280px] bg-porcelain px-5 py-16 font-sans text-midnight sm:px-8 lg:py-24">
      <p className={eyebrowClass}>{eyebrow} / DEVNET SANDBOX</p>
      <div className="mt-4 flex flex-col justify-between gap-6 border-b border-silver pb-8 lg:flex-row lg:items-end">
        <h1 className="text-4xl leading-tight tracking-[-.045em] sm:text-6xl">{title}</h1>
        <nav aria-label="Wallet" className="flex flex-wrap gap-2"><Link className={buttonClass} href="/account/wallet">Wallet</Link><Link className={buttonClass} href="/account/wallet/add">Add credits</Link><Link className={buttonClass} href="/account/wallet/send">Send funds</Link><Link className={buttonClass} href="/account">Profile</Link></nav>
      </div>
      <div className="mt-10 space-y-6"><SandboxBanner />{children}</div>
    </main>
  </WalletProvider></ProtectedView>;
}

/** Renders children only when a wallet exists; otherwise a meaningful state. */
export function WalletGate({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  if (wallet.phase === 'loading') return <div className={cardClass}><Spinner label="Opening your sandbox wallet..." /></div>;
  if (wallet.phase === 'error') return <div className={cardClass}><Notice tone="error" title="Sandbox wallet unavailable in this browser">{wallet.phaseError ?? 'Browser storage could not be read.'} The sandbox wallet needs localStorage; private browsing modes may block it.</Notice></div>;
  if (wallet.phase === 'none') return <div className={cardClass}>
    <h2 className="text-2xl tracking-tight">No sandbox wallet</h2>
    <p className="mt-3 text-sm leading-7 text-slate-600">This browser no longer holds a sandbox key. Creating a new one produces a different devnet address; funds at the previous address cannot be reached unless you exported its key. The wallet service links one address per account, so if this account is already linked, the service will refuse the new address and balances, history and payments stay disabled.</p>
    <button className={`${primaryButtonClass} mt-6`} onClick={wallet.createSandboxWallet}>Create new sandbox wallet</button>
  </div>;
  if (wallet.linkProblem) return <div className={cardClass}>
    <Notice tone="error" title="This browser's wallet is not the wallet linked to your account">
      <p>{wallet.linkProblem.message}</p>
      <p className="mt-2">This browser holds <span className="break-all font-mono text-xs">{wallet.address}</span>{wallet.linkProblem.linkedAddress ? <>, but your account is linked to <span className="break-all font-mono text-xs">{wallet.linkProblem.linkedAddress}</span></> : null}. In this sandbox one address is linked per account and keys cannot be imported, so the linked wallet is usable only in the browser that holds its key. Balances, history and payments are disabled so another wallet&apos;s data is never shown as this one&apos;s.</p>
    </Notice>
  </div>;
  return <>{children}</>;
}

export function ServiceNotice() {
  const wallet = useWallet();
  if (wallet.service !== 'unavailable') return null;
  return <Notice tone="warn" title="Wallet service unavailable">The wallet API could not be reached, so balances, history and funding are not available right now. Nothing shown here is estimated or invented. {wallet.balance ? 'The last balance we retrieved is marked stale.' : 'No balance has been loaded.'} We keep retrying while this page is open.</Notice>;
}
