'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { MapPin, PackageCheck, ShieldCheck, Wallet, ShoppingBag, UserRound } from 'lucide-react';
import { useAuth } from './auth-provider';
import { AddToCartButton } from './add-to-cart-button';

const cardClass = 'rounded-2xl border border-silver bg-white p-6 sm:p-8';
const buttonClass = 'inline-flex min-h-11 items-center justify-center rounded-2xl border border-silver px-5 py-3 text-xs font-semibold transition hover:bg-porcelain';

export function ProtectedView({ children }: { children: ReactNode }) {
  const router = useRouter(); const { isReady, session } = useAuth();
  useEffect(() => { if (isReady && !session) router.replace('/login'); }, [isReady, router, session]);
  if (!isReady) return <main className="min-h-[60vh] p-10" />;
  if (!session) return <main className="min-h-[60vh] p-10 text-center text-sm">Redirecting to sign in...</main>;
  return <>{children}</>;
}

function AccountLayout({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return <main className="mx-auto min-h-[60vh] max-w-[1280px] bg-porcelain px-5 py-16 font-sans text-midnight sm:px-8 lg:py-24"><p className="text-[10px] font-medium tracking-[.17em] text-slate-600">{eyebrow} / LOCAL PREVIEW</p><div className="mt-4 flex flex-col justify-between gap-6 border-b border-silver pb-8 lg:flex-row lg:items-end"><h1 className="text-4xl leading-tight tracking-[-.045em] sm:text-6xl">{title}</h1><nav aria-label="Account" className="flex flex-wrap gap-2 text-xs font-semibold"><Link className={buttonClass} href="/account">Profile</Link><Link className={buttonClass} href="/account/addresses">Addresses</Link><Link className={buttonClass} href="/orders">Orders</Link><Link className={buttonClass} href="/account/wallet">Wallet</Link></nav></div><div className="mt-10">{children}</div></main>;
}

export function AccountPage() {
  const router = useRouter(); const { session, setMfaEnabled, signOut } = useAuth();
  return <ProtectedView><AccountLayout eyebrow="CUSTOMER WORKSPACE" title="Your profile.">
    <div className="grid gap-6 md:grid-cols-[1.15fr_.85fr]">
      <section className={cardClass}>
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-0"><UserRound className="text-slate-600" size={21} /><h2 className="mt-5 break-words text-3xl tracking-tight">{session?.name}</h2><p className="mt-2 break-words text-sm text-slate-600">{session?.email}</p></div>
          <span className="rounded-2xl border border-silver bg-ice/10 px-3 py-2 text-[10px] font-medium text-slate-600">{session?.verified ? 'EMAIL VERIFIED' : 'VERIFY EMAIL'}</span>
        </div>
        <div className="mt-8 border-t border-silver pt-6"><p className="text-xs font-semibold">Purchaser eligibility</p><div className="mt-3 flex gap-3 text-sm leading-7 text-slate-600"><ShieldCheck className="shrink-0 text-slate-600" size={19} /><p><b className="text-midnight">{session?.eligible ? 'Eligibility acknowledgement on file.' : 'Eligibility review required.'}</b><br />This local preview shows qualification status only and is not a compliance decision.</p></div></div>
      </section>
      <aside className="rounded-2xl border border-silver bg-ice/10 p-6 sm:p-8"><p className="text-[10px] font-medium tracking-[.13em] text-slate-600">ACCOUNT SECURITY</p><h2 className="mt-4 text-3xl tracking-tight">Add another check.</h2><p className="mt-4 text-sm leading-7 text-slate-600">Optional MFA is {session?.mfaEnabled ? 'enabled for this preview browser.' : 'available for your local preview session.'}</p><button className={`${buttonClass} mt-6 bg-white`} onClick={() => setMfaEnabled(!session?.mfaEnabled)}>{session?.mfaEnabled ? 'Disable preview MFA' : 'Set up preview MFA'}</button></aside>
    </div>
    <div className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3"><Link href="/account/addresses" className={`${cardClass} transition hover:border-slate-400`}><MapPin className="text-slate-600" size={20} /><b className="mt-4 block text-2xl font-medium tracking-tight">Saved addresses</b><span className="mt-2 block text-sm text-slate-600">Review laboratory delivery details.</span></Link><Link href="/orders" className={`${cardClass} transition hover:border-slate-400`}><PackageCheck className="text-slate-600" size={20} /><b className="mt-4 block text-2xl font-medium tracking-tight">Order history</b><span className="mt-2 block text-sm text-slate-600">Check orders or start a reorder.</span></Link><Link href="/account/wallet" className={`${cardClass} transition hover:border-slate-400`}><Wallet className="text-slate-600" size={20} /><b className="mt-4 block text-2xl font-medium tracking-tight">Research Wallet</b><span className="mt-2 block text-sm text-slate-600">View credits, add funds, or send funds.</span></Link></div>
    <button className={`${buttonClass} mt-8`} onClick={() => { signOut(); router.push('/access'); }}>Sign out of local preview</button>
  </AccountLayout></ProtectedView>;
}

export function AddressesPage() { return <ProtectedView><AccountLayout eyebrow="SAVED ADDRESSES" title="Delivery details."><section className={`${cardClass} max-w-2xl`}><div className="flex flex-wrap items-start justify-between gap-5"><div><MapPin className="text-slate-600" size={21} /><h2 className="mt-4 text-3xl tracking-tight">Primary laboratory</h2><address className="mt-4 not-italic text-sm leading-7 text-slate-600">Northstar Analytical Lab<br />214 Research Way, Suite 402<br />Boston, MA 02110</address></div><span className="rounded-2xl border border-silver bg-porcelain px-3 py-2 text-[10px] font-medium text-slate-600">DEFAULT</span></div><p className="mt-8 border-t border-silver pt-5 text-xs leading-6 text-slate-500">Preview address data is illustrative and is not used for fulfillment.</p></section></AccountLayout></ProtectedView>; }

export function OrdersPage() { return <ProtectedView><AccountLayout eyebrow="ORDER HISTORY" title="Your orders."><div className={cardClass}><div className="flex flex-col justify-between gap-5 sm:flex-row"><div><p className="text-[10px] font-medium tracking-[.13em] text-slate-600">HF-1048 / LOCAL SAMPLE</p><h2 className="mt-3 text-3xl tracking-tight">GHK-Cu 5mg</h2><p className="mt-3 text-sm text-slate-600">Placed Apr 18, 2026 · Delivered</p></div><span className="h-fit w-fit rounded-2xl border border-silver bg-ice/10 px-3 py-2 text-[10px] font-semibold uppercase tracking-[.1em] text-slate-600">Complete</span></div><div className="mt-8 flex flex-wrap gap-3 border-t border-silver pt-6"><Link className={buttonClass} href="/orders/HF-1048">View order</Link><AddToCartButton slug="ghk-cu" className="inline-flex min-h-11 items-center justify-center rounded-2xl border border-midnight bg-midnight px-5 py-3 text-xs font-semibold text-white transition hover:bg-slate-700">Reorder <ShoppingBag className="ml-2 inline" size={13} /></AddToCartButton></div></div><p className="mt-6 text-xs leading-6 text-slate-500">Order history shown here is local preview data. Reorder adds the item to your existing research bag.</p></AccountLayout></ProtectedView>; }
