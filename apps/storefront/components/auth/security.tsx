'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth-provider';
import { authApi, authErrorMessage } from '../../lib/auth/api';
import type { MfaEnrollment } from '../../lib/auth/types';
import { validCode } from '../../lib/auth/validation';
import { AccountShell, ProtectedAccount } from './account-shell';
import { buttonClass, cardClass, Field, primaryClass, Status } from './ui';

export function SecurityPage() { return <ProtectedAccount><Security /></ProtectedAccount>; }

function Security() {
  const { session, refresh } = useAuth();
  const [enrollment, setEnrollment] = useState<MfaEnrollment | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function start() {
    if (busy) return;
    setBusy(true); setError(null); setMessage(null);
    try { setEnrollment(await authApi.enrollMfa()); setCode(''); }
    catch (cause) { setError(authErrorMessage(cause)); } finally { setBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!validCode(code)) { setError('Enter the 6-digit code from your authenticator app.'); return; }
    if (session?.mfaEnabled && (!password || password.length > 256)) { setError('Enter your current password.'); return; }
    setBusy(true); setError(null); setMessage(null);
    try {
      if (session?.mfaEnabled) await authApi.disableMfa(password, code); else await authApi.confirmMfa(code);
      const wasEnabled = session?.mfaEnabled;
      setEnrollment(null); setCode(''); setPassword('');
      const next = await refresh();
      if (next) setMessage(wasEnabled ? 'Two-step authentication disabled.' : 'Two-step authentication enabled. Use a fresh code the next time you sign in.');
    } catch (cause) { setError(authErrorMessage(cause)); setCode(''); } finally { setBusy(false); }
  }
  return <AccountShell title="Account security."><div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
    <section className={cardClass}><h2 className="text-2xl tracking-tight">Two-step authentication</h2><p className="mt-4 text-sm leading-6">{session?.mfaEnabled ? 'Enabled. Your password and a fresh authenticator code are required to sign in.' : 'Add a time-based code from your authenticator app to your sign-in.'}</p>
      <Status error={error} message={busy ? 'Updating security settings…' : message} />
      {!session?.mfaEnabled && !enrollment && <button className={`${primaryClass} mt-6`} disabled={busy} onClick={() => void start()}>Set up authenticator</button>}
      {enrollment && !session?.mfaEnabled && <div className="mt-6 space-y-4"><p className="text-sm leading-6">In your authenticator app, add a time-based account using this setup key. Keep the key private. It is shown for this enrollment only.</p><p className="rounded-xl bg-porcelain p-4 font-mono text-sm [overflow-wrap:anywhere]" aria-label="Authenticator setup key">{enrollment.seedBase32}</p><details><summary className={`${buttonClass} cursor-pointer`}>Show authenticator URI</summary><p className="mt-3 select-all rounded-xl bg-porcelain p-4 font-mono text-xs [overflow-wrap:anywhere]">{enrollment.otpauthUri}</p></details><p className="text-sm leading-6">Enter a code to finish setup. Two-step authentication stays off until the code is accepted.</p></div>}
      {(session?.mfaEnabled || enrollment) && <form onSubmit={submit} className="mt-6 space-y-5" aria-busy={busy}>
        {session?.mfaEnabled && <Field name="password" label="Current password" type="password" autoComplete="current-password" required maxLength={256} disabled={busy} value={password} onChange={(e) => setPassword(e.target.value)} />}
        <Field name="code" label="Authentication code" inputMode="numeric" autoComplete="one-time-code" required pattern="[0-9]{6}" maxLength={6} value={code} disabled={busy} onChange={(e) => setCode(e.target.value)} hint="Use a fresh 6-digit code. A code that was just used cannot be reused." />
        <div className="flex flex-wrap gap-3"><button className={primaryClass} disabled={busy}>{session?.mfaEnabled ? 'Disable two-step authentication' : 'Confirm authenticator'}</button>{enrollment && <button className={buttonClass} type="button" disabled={busy} onClick={() => { setEnrollment(null); setCode(''); setError(null); }}>Cancel setup</button>}</div>
      </form>}
    </section>
    <section className={`${cardClass} h-fit`}><h2 className="text-2xl tracking-tight">Password</h2><p className="mt-4 text-sm leading-6 text-slate-600">Use an emailed reset link to choose a new password. Resetting your password ends all current account sessions.</p><Link className={`${buttonClass} mt-6`} href="/forgot-password">Reset password</Link></section>
  </div></AccountShell>;
}
