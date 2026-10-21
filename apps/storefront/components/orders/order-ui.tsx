'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowUpRight, Check, Copy, Package, RefreshCw } from 'lucide-react';
import { useAuth } from '../auth-provider';
import { orderStatusLabel, ordersSignInHref, type DisplayOrderStatus } from '../../lib/orders/customer-orders';

export const orderButtonClass = 'inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-xl border border-silver bg-white px-4 py-3 text-sm font-medium transition hover:border-slate-400 hover:bg-porcelain disabled:cursor-wait disabled:opacity-60';
export const orderPanelClass = 'min-w-0 rounded-2xl border border-silver bg-white p-5 sm:p-7';

export function OrdersLayout({ detail = false, children }: { detail?: boolean; children: ReactNode }) {
  return <main className="mx-auto min-h-[65vh] max-w-[1200px] px-5 py-10 text-midnight sm:px-8 sm:py-16">
    <Link href={detail ? '/orders' : '/account'} className="inline-flex min-h-11 items-center gap-2 text-sm text-slate-600 hover:text-midnight"><ArrowLeft aria-hidden="true" size={16} />{detail ? 'All orders' : 'Your account'}</Link>
    <header className="mb-8 mt-5 flex flex-wrap items-end justify-between gap-5 border-b border-silver pb-7">
      <div><p className="font-mono text-[11px] tracking-[.16em] text-blue">CUSTOMER ORDERS</p><h1 id="customer-orders-title" tabIndex={-1} className="mt-3 text-4xl tracking-[-.045em] sm:text-5xl">{detail ? 'Order details.' : 'Your orders.'}</h1>
        <p className="mt-3 max-w-xl text-sm leading-6 text-slate-600">{detail ? 'Items, shipment details and recorded order updates.' : 'Review your orders and their latest recorded status.'}</p></div>
      {!detail && <Link className={orderButtonClass} href="/catalog">Browse catalog<ArrowUpRight aria-hidden="true" size={16} /></Link>}
    </header>
    {children}
  </main>;
}

export function OrdersSession({ id, children }: { id?: string; children: ReactNode }) {
  const { isReady, session, error, refresh } = useAuth();
  if (!isReady) return <OrdersLoading />;
  if (!session && error) return <OrdersError retry={() => { void refresh(); }} />;
  if (!session) return <OrdersSignIn id={id} />;
  // Remount resources on account changes so cached customer data never carries into the next session.
  return <div key={session.id}>{children}</div>;
}

export function OrdersLoading({ detail = false }: { detail?: boolean }) {
  return <div className={orderPanelClass} role="status" aria-live="polite"><p className="text-sm text-slate-600">{detail ? 'Loading order details…' : 'Loading your orders…'}</p><div aria-hidden="true" className="mt-5 space-y-3"><div className="h-4 w-2/3 rounded bg-slate-100" /><div className="h-4 w-1/2 rounded bg-slate-100" /><div className="h-4 w-1/3 rounded bg-slate-100" /></div></div>;
}

export function OrdersSignIn({ id }: { id?: string }) {
  return <section className={orderPanelClass} aria-labelledby="orders-signin-heading"><Package aria-hidden="true" className="text-blue" size={24} /><h2 id="orders-signin-heading" className="mt-4 text-2xl tracking-tight">Sign in to view your orders</h2><p className="mt-3 text-sm leading-6 text-slate-600">Your order history is available when you’re signed in to your account.</p><Link className={`${orderButtonClass} mt-5`} href={ordersSignInHref(id)}>Sign in</Link></section>;
}

export function OrdersError({ retry }: { retry: () => void }) {
  return <section className={orderPanelClass}><div role="alert"><h2 className="text-2xl tracking-tight">Order information is unavailable</h2><p className="mt-3 text-sm leading-6 text-slate-600">We couldn’t load your orders. Please try again.</p></div><button type="button" className={`${orderButtonClass} mt-5`} onClick={retry}>Try again</button></section>;
}

export function OrderNotFound() {
  return <section className={orderPanelClass} role="status"><h2 className="text-2xl tracking-tight">Order not found</h2><p className="mt-3 text-sm leading-6 text-slate-600">This order isn’t available. Check the link or return to your order history.</p><Link className={`${orderButtonClass} mt-5`} href="/orders">Return to orders</Link></section>;
}

export function OrderStatusBadge({ status }: { status: DisplayOrderStatus }) {
  const color = status === 'DELIVERED' ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
    : status === 'PENDING_PAYMENT' ? 'border-amber-200 bg-amber-50 text-amber-900'
      : status === 'PAID' || status === 'PROCESSING' || status === 'SHIPPED' ? 'border-sky-200 bg-sky-50 text-sky-900'
        : 'border-silver bg-porcelain text-slate-700';
  return <span className={`inline-flex w-fit items-center rounded-full border px-3 py-1.5 text-xs font-medium ${color}`}>{orderStatusLabel(status)}</span>;
}

export function OrderRefresh({ refreshing, failed, automatic, refresh }: { refreshing: boolean; failed: boolean; automatic: boolean; refresh: () => void }) {
  return <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
    <div className="min-w-0 flex-1 text-xs leading-5 text-slate-600" role="status" aria-live="polite" aria-atomic="true">
      {refreshing ? 'Checking for updates…' : failed ? 'Couldn’t refresh. Showing the last loaded information. Try refreshing again.' : automatic ? 'Checks for updates every 60 seconds while this page is visible.' : 'Showing the latest loaded order information.'}
    </div>
    <button type="button" className={orderButtonClass} onClick={refresh} disabled={refreshing}><RefreshCw aria-hidden="true" size={15} />Refresh</button>
  </div>;
}

export function CopyTracking({ number }: { number: string }) {
  const [result, setResult] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try { await navigator.clipboard.writeText(number); setResult('copied'); }
    catch { setResult('failed'); }
  };
  return <div className="min-w-0"><button type="button" className={orderButtonClass} onClick={copy}>{result === 'copied' ? <Check aria-hidden="true" size={15} /> : <Copy aria-hidden="true" size={15} />}Copy tracking number</button><p className="mt-2 text-xs leading-5 text-slate-600" role="status" aria-live="polite">{result === 'copied' ? 'Tracking number copied.' : result === 'failed' ? 'Couldn’t copy. Select the tracking number above to copy it manually.' : ''}</p></div>;
}
