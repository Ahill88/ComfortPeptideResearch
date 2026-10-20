'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowUpRight, Plus, RefreshCw } from 'lucide-react';
import { useWallet } from './wallet-provider';
import { cardClass, CopyButton, eyebrowClass, Notice, ServiceNotice, shortAddress, Spinner, StatusBadge, WalletGate } from './ui';
import { WalletSecurityPanel } from './wallet-security';
import { WalletDisclosures } from './wallet-disclosures';
import { errorMessage, fetchTransactions, WalletApiError, type WalletTransaction } from '../../lib/wallet/api';
import { formatUsdc, formatWholeNumber, researchCredits, tryFormatUsdc } from '../../lib/wallet/credits';

function BalanceCard() {
  const wallet = useWallet();
  const { balance, service, balanceLoading, lastUpdated } = wallet;
  const stale = service === 'unavailable' || balance?.stale === true;
  // The API sets stale:true with spendable 0 (fail closed). That 0 is a placeholder, not a real balance, so it is never shown as credits.
  const known = balance !== null && !balance.stale;
  return <section aria-labelledby="balance-heading" className="rounded-2xl border border-midnight bg-midnight p-6 text-porcelain sm:p-10">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-[10px] font-medium tracking-[.17em] text-silver">RESEARCH CREDITS</p><h2 id="balance-heading" className="sr-only">Research Credits balance</h2></div>
      <button type="button" onClick={() => void wallet.refresh()} disabled={balanceLoading} className="inline-flex min-h-11 items-center gap-2 rounded-2xl border border-slate-600 px-4 py-2 text-xs font-semibold text-silver transition hover:bg-graphite focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ice disabled:opacity-50">
        <RefreshCw size={14} className={balanceLoading ? 'animate-spin motion-reduce:animate-none' : ''} aria-hidden="true" />Refresh
      </button>
    </div>
    {balance && known ? <>
      <p className="mt-6 text-6xl font-light leading-none tracking-[-.05em] tabular-nums sm:text-8xl" data-testid="research-credits">{formatWholeNumber(researchCredits(balance.spendableAtomic))}</p>
      <p className="mt-6 text-sm leading-7 text-silver">Actual balance <b className="font-mono font-medium text-white">{formatUsdc(balance.spendableAtomic)} USDC</b>; credits = whole USDC available.</p>
      {balance.finalizedAtomic !== balance.spendableAtomic ? <p className="mt-2 text-xs leading-6 text-slate-400">Finalized on-chain {formatUsdc(balance.finalizedAtomic)} USDC. The difference is held for pending transfers or active checkout reservations.</p> : null}
    </> : <>
      <p className="mt-6 text-6xl font-light leading-none tracking-[-.05em] text-slate-500 sm:text-8xl" aria-label="Balance not available">--</p>
      <p className="mt-6 text-sm leading-7 text-silver">{balance?.stale ? 'The service could not read the chain, so it reports no usable balance (it fails closed to zero spendable). No balance is shown.' : service === 'unavailable' ? 'Wallet service unavailable. No balance is shown because none has been loaded.' : 'Loading your balance...'}</p>
    </>}
    {stale ? <p role="status" className="mt-6 rounded-xl border border-amber-300/40 bg-amber-300/10 p-4 text-xs leading-6 text-amber-100">{known ? 'This balance may be out of date. ' : ''}{service === 'unavailable' ? 'We could not reach the wallet service on the last attempt.' : 'The service reports its chain data as stale. Credits shown may not reflect the latest on-chain state.'} Do not rely on it for purchases until it refreshes.</p> : null}
    <p className="mt-6 text-[11px] text-slate-400">{lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()} - refreshes every 15 seconds while this tab is visible.` : 'Not yet updated.'}</p>
    <div className="mt-8 flex flex-wrap gap-3">
      <Link href="/account/wallet/add" className="inline-flex min-h-11 items-center gap-2 rounded-2xl bg-porcelain px-5 py-3 text-xs font-semibold text-midnight transition hover:bg-ice focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ice"><Plus size={14} aria-hidden="true" />Add Credits</Link>
      <Link href="/account/wallet/send" className="inline-flex min-h-11 items-center gap-2 rounded-2xl border border-slate-500 px-5 py-3 text-xs font-semibold text-porcelain transition hover:bg-graphite focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ice"><ArrowUpRight size={14} aria-hidden="true" />Send Funds</Link>
      <a href="#receive" className="inline-flex min-h-11 items-center gap-2 rounded-2xl border border-slate-500 px-5 py-3 text-xs font-semibold text-porcelain transition hover:bg-graphite focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ice"><ArrowDownToLine size={14} aria-hidden="true" />Receive</a>
    </div>
  </section>;
}

function ReceivePanel() {
  const { address, registered, service } = useWallet();
  if (!address) return null;
  return <section id="receive" aria-labelledby="receive-heading" className={`${cardClass} scroll-mt-24`}>
    <p className={eyebrowClass}>RECEIVE</p>
    <h2 id="receive-heading" className="mt-3 text-3xl tracking-tight">Your wallet address</h2>
    <p className="mt-3 text-sm leading-7 text-slate-600">Share this address to receive <b className="text-midnight">Solana devnet USDC</b>. Devnet SOL is also needed to cover network fees when you send. Do not send mainnet assets or other tokens to this address.</p>
    <p className="mt-5 break-all rounded-xl border border-silver bg-porcelain p-4 font-mono text-sm" data-testid="wallet-address">{address}</p>
    <div className="mt-4 flex flex-wrap items-center gap-3"><CopyButton value={address} label="Copy address" /><span className="text-xs text-slate-500">{registered ? 'Public address registered with the wallet service.' : service === 'unavailable' ? 'Not yet registered: wallet service unavailable.' : 'Registering public address...'}</span></div>
  </section>;
}

// API CryptoTransaction types: DEPOSIT | WITHDRAWAL | PURCHASE | REFUND.
const typeLabels: Record<string, string> = { DEPOSIT: 'Deposit', WITHDRAWAL: 'Transfer out', PURCHASE: 'Research purchase', REFUND: 'Refund' };
// API CryptoTransaction statuses. Only FINALIZED is final; PREPARED means nothing was ever sent to the network.
const statusLabels: Record<string, string> = { PREPARED: 'Not sent', SUBMITTED: 'Submitted', CONFIRMED: 'Confirmed, not final', FINALIZED: 'Finalized', FAILED: 'Failed', EXPIRED: 'Expired' };
const statusLabel = (tx: WalletTransaction) => statusLabels[tx.rawStatus.toUpperCase()] ?? tx.rawStatus;
/** Direction only for rows that actually moved (or are moving) funds; failed/expired/unsent rows carry no sign. */
function amountSign(tx: WalletTransaction): string {
  if (tx.status !== 'finalized' && tx.status !== 'pending') return '';
  return tx.type === 'DEPOSIT' || tx.type === 'REFUND' ? '+' : tx.type === 'WITHDRAWAL' || tx.type === 'PURCHASE' ? '-' : '';
}
const typeLabel = (type: string) => typeLabels[type] ?? type.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());

function formatDate(value: string | null) {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function TransactionRow({ tx }: { tx: WalletTransaction }) {
  const amount = tryFormatUsdc(tx.amountAtomic);
  return <li className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between">
    <div className="min-w-0"><p className="text-sm font-medium">{typeLabel(tx.type)}</p><p className="mt-1 text-xs text-slate-500">{formatDate(tx.createdAt)}{tx.counterparty ? ` - ${shortAddress(tx.counterparty)}` : ''}{tx.reference ? ` - Ref ${tx.reference}` : ''}</p>
      {tx.signature ? <a className="mt-1 inline-block break-all font-mono text-[11px] text-sky-800 underline underline-offset-4" target="_blank" rel="noopener noreferrer" href={`https://explorer.solana.com/tx/${encodeURIComponent(tx.signature)}?cluster=devnet`}>{shortAddress(tx.signature)} (devnet explorer)</a> : null}</div>
    <div className="flex items-center gap-4 sm:flex-col sm:items-end sm:gap-2"><span className="font-mono text-sm tabular-nums">{amount ? `${amountSign(tx)}${amount} USDC` : 'Amount unavailable'}</span><StatusBadge status={tx.status} label={statusLabel(tx)} /></div>
  </li>;
}

function HistorySection({ title, eyebrow, empty, filter, transactions, state }: { title: string; eyebrow: string; empty: string; filter: (tx: WalletTransaction) => boolean; transactions: WalletTransaction[]; state: 'loading' | 'ready' | 'unavailable' | 'error'; }) {
  const rows = transactions.filter(filter);
  return <section className={cardClass} aria-label={title}><p className={eyebrowClass}>{eyebrow}</p><h2 className="mt-3 text-3xl tracking-tight">{title}</h2>
    <div className="mt-6">{state === 'loading' ? <Spinner label="Loading history..." /> : state === 'unavailable' ? <Notice tone="warn" title="Wallet service unavailable">History cannot be loaded right now. Nothing is being shown in its place.</Notice> : state === 'error' ? <Notice tone="error">History could not be loaded.</Notice> : rows.length === 0 ? <p className="text-sm text-slate-600">{empty}</p> : <ul className="divide-y divide-silver">{rows.map((tx) => <TransactionRow key={tx.id} tx={tx} />)}</ul>}</div>
  </section>;
}

function History() {
  const { email, balance } = useWallet();
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const balanceKey = balance ? `${balance.finalizedAtomic}-${balance.spendableAtomic}` : 'none';
  // Never show one account's history under another: clear when the account changes.
  useEffect(() => { setState('loading'); setTransactions([]); setMessage(null); }, [email]);
  useEffect(() => {
    if (!email) return;
    const controller = new AbortController();
    fetchTransactions(email, controller.signal).then((list) => { setTransactions(list); setState('ready'); setMessage(null); }).catch((error) => {
      if (controller.signal.aborted) return;
      setState(error instanceof WalletApiError && !error.unavailable ? 'error' : 'unavailable');
      setMessage(errorMessage(error));
    });
    return () => controller.abort();
    // Reload when the balance changes so new deposits/transfers appear.
  }, [email, balanceKey]);
  return <>
    <HistorySection eyebrow="ACTIVITY" title="Transaction history" empty="No wallet transactions yet." filter={() => true} transactions={transactions} state={state} />
    <HistorySection eyebrow="PURCHASES" title="Research purchase history" empty="No research purchases paid with Research Credits yet." filter={(tx) => tx.type === 'PURCHASE' || tx.type === 'REFUND'} transactions={transactions} state={state} />
    {state === 'error' && message ? <p className="sr-only" role="alert">{message}</p> : null}
  </>;
}

export function WalletDashboard() {
  return <>
    <ServiceNotice />
    <WalletGate>
      <BalanceCard />
      <div className="grid gap-6 lg:grid-cols-2"><ReceivePanel /><WalletSecurityPanel /></div>
      <History />
    </WalletGate>
    <WalletDisclosures />
    <p className="text-xs leading-6 text-slate-500"><Link className="underline underline-offset-4" href="/account/wallet/add">Add credits</Link> - <Link className="underline underline-offset-4" href="/account/wallet/send">Send funds</Link></p>
  </>;
}
