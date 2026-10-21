'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../auth-provider';
import { authApi, authErrorMessage } from '../../lib/auth/api';
import type { Customer } from '../../lib/auth/types';
import { nameError } from '../../lib/auth/validation';
import { AccountShell, ProtectedAccount } from './account-shell';
import { buttonClass, cardClass, Field, primaryClass, Status } from './ui';

export function AccountOverview() {
  return <ProtectedAccount><Overview /></ProtectedAccount>;
}

function Overview() {
  const { session, refresh, loading } = useAuth();
  return <AccountShell title="Your account."><div className="grid gap-6 md:grid-cols-2">
    <section className={cardClass}><h2 className="break-words text-2xl tracking-tight">{session?.name}</h2><p className="mt-3 break-words text-sm text-slate-600">{session?.email}</p><p className="mt-4 text-sm">{session?.verified ? 'Email verified' : 'Email verification required'}</p><Link href="/account/profile" className={`${buttonClass} mt-6`}>Edit profile</Link></section>
    <section className={cardClass}><h2 className="text-2xl tracking-tight">Account security</h2><p className="mt-4 text-sm">Two-step authentication is {session?.mfaEnabled ? 'enabled' : 'not enabled'}.</p><Link href="/account/security" className={`${buttonClass} mt-6`}>Manage security</Link></section>
    <section className={cardClass}><h2 className="text-2xl tracking-tight">Purchaser eligibility</h2><p className="mt-4 text-sm">{session?.eligible ? 'Approved' : session?.eligibilityStatus === 'UNKNOWN' ? 'Status unavailable' : session?.eligibilityStatus === 'PENDING' ? 'Review pending' : session?.eligibilityStatus === 'REJECTED' ? 'Not approved' : 'Review not requested'}</p><p className="mt-3 text-sm leading-6 text-slate-600">Account registration and email verification do not grant purchaser eligibility.</p><button className={`${buttonClass} mt-6`} disabled={loading} onClick={() => void refresh()}>Refresh account</button><Status message={loading ? 'Refreshing account…' : null} /></section>
    <section className={cardClass}><h2 className="text-2xl tracking-tight">Delivery and orders</h2><div className="mt-6 flex flex-wrap gap-3"><Link href="/account/addresses" className={buttonClass}>Saved addresses</Link><Link href="/orders" className={buttonClass}>Order history</Link><Link href="/account/wallet" className={buttonClass}>Research Wallet</Link></div></section>
  </div></AccountShell>;
}

export function ProfilePage() { return <ProtectedAccount><ProfileForm /></ProtectedAccount>; }

function ProfileForm() {
  const { refresh } = useAuth();
  const [profile, setProfile] = useState<Customer | null>(null);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    authApi.profile(controller.signal).then((customer) => { setProfile(customer); setName(customer.name ?? ''); }).catch((cause) => { if (!controller.signal.aborted) setError(authErrorMessage(cause)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const problem = nameError(name);
    if (problem) { setError(problem); return; }
    setBusy(true); setError(null); setMessage(null);
    try { const customer = await authApi.updateProfile(name); setProfile(customer); setName(customer.name ?? ''); await refresh(); setMessage('Profile updated.'); }
    catch (cause) { setError(authErrorMessage(cause)); } finally { setBusy(false); }
  }
  return <AccountShell title="Your profile."><section className={`${cardClass} max-w-2xl`}>
    <Status error={error} message={loading ? 'Loading profile…' : message} />
    {profile && !loading ? <form onSubmit={submit} className="space-y-5" aria-busy={busy}>
      <Field name="name" label="Full name" autoComplete="name" maxLength={120} value={name} disabled={busy} onChange={(e) => setName(e.target.value)} hint="Leave blank to remove your display name." />
      <Field name="email" label="Email" type="email" value={profile.email} readOnly hint="Your sign-in email cannot be changed here." />
      <p className="text-sm">{profile.emailVerified ? 'Email verified' : 'Email verification required'}</p>
      <button className={primaryClass} disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</button>
    </form> : !loading && <button className={buttonClass} onClick={() => setAttempt((a) => a + 1)}>Try again</button>}
  </section></AccountShell>;
}
