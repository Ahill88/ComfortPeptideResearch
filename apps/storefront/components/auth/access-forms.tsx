'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '../auth-provider';
import { AuthApiError, authApi, authErrorMessage } from '../../lib/auth/api';
import { loginPath, sanitizeNextPath } from '../../lib/auth/navigation';
import { nameError, PASSWORD_HINT, passwordError, validCode, validEmail, validToken } from '../../lib/auth/validation';
import { AccessShell, buttonClass, Field, primaryClass, Status } from './ui';

export function LoginForm({ next }: { next?: string }) {
  const router = useRouter();
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [mfaRequired, setMfaRequired] = useState(false);
  const [unverified, setUnverified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (mfaRequired) codeRef.current?.focus(); }, [mfaRequired]);
  const destination = sanitizeNextPath(next);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null); setUnverified(false);
    if (!validEmail(email) || !password || password.length > 256) { setError('Enter your email and password.'); return; }
    if (mfaRequired && !validCode(totp)) { setError('Enter the 6-digit code from your authenticator app.'); return; }
    setBusy(true);
    try {
      await signIn(email, password, mfaRequired ? totp : undefined);
      setPassword(''); setTotp('');
      router.replace(destination);
    } catch (cause) {
      if (cause instanceof AuthApiError && cause.code === 'MFA_REQUIRED') setMfaRequired(true);
      if (cause instanceof AuthApiError && cause.code === 'EMAIL_NOT_VERIFIED') setUnverified(true);
      setError(authErrorMessage(cause)); setTotp('');
    } finally { setBusy(false); }
  }
  return <AccessShell title="Welcome back.">
    <form onSubmit={submit} className="space-y-5" aria-busy={busy}>
      <Field name="email" label="Email" type="email" autoComplete="username" required maxLength={254} value={email} disabled={busy} onChange={(e) => { setEmail(e.target.value); setMfaRequired(false); setUnverified(false); setTotp(''); }} />
      <Field name="password" label="Password" type="password" autoComplete="current-password" required maxLength={256} value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} />
      {mfaRequired && <div><label htmlFor="totp" className="mb-2 block text-sm font-medium">Authentication code</label><input ref={codeRef} id="totp" name="totp" className="min-h-11 w-full rounded-xl border border-silver px-4 py-3 text-sm" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={totp} disabled={busy} onChange={(e) => setTotp(e.target.value)} aria-describedby="totp-hint" /><p id="totp-hint" className="mt-2 text-xs text-slate-600">Enter a fresh 6-digit code from your authenticator app.</p></div>}
      <Status error={error} message={busy ? 'Signing in…' : null} />
      <button className={`${primaryClass} w-full`} disabled={busy} type="submit">{mfaRequired ? 'Verify and sign in' : 'Sign in'}</button>
    </form>
    {unverified && <Link href="/verify-email" className={`${buttonClass} mt-4`}>Email verification help</Link>}
    <div className="mt-6 flex flex-wrap gap-3"><Link href="/forgot-password" className={buttonClass}>Forgot password?</Link><Link href={`/register?next=${encodeURIComponent(destination)}`} className={buttonClass}>Create account</Link></div>
  </AccessShell>;
}

export function RegisterForm({ next }: { next?: string }) {
  const { register } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const problem = nameError(name) ?? passwordError(password) ?? (!validEmail(email) ? 'Enter a valid email.' : null);
    if (problem) { setError(problem); return; }
    setBusy(true); setError(null);
    try { await register(name, email, password); setPassword(''); setComplete(true); }
    catch (cause) { setError(authErrorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <AccessShell title="Create your account.">
    {complete ? <Status message="Request received. If this address can be registered and email delivery is available, you can use the verification link in your inbox. This response does not confirm email delivery. If you already have an account, sign in or reset your password." /> : <form onSubmit={submit} className="space-y-5" aria-busy={busy}>
      <Field name="name" label="Full name (optional)" autoComplete="name" maxLength={120} value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
      <Field name="email" label="Email" type="email" autoComplete="username" required maxLength={254} value={email} disabled={busy} onChange={(e) => setEmail(e.target.value)} />
      <Field name="password" label="Password" type="password" autoComplete="new-password" minLength={12} maxLength={256} required hint={PASSWORD_HINT} value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} />
      <p className="text-sm leading-6 text-slate-600">Confirm your email before signing in. Creating an account does not establish purchaser eligibility.</p>
      <Status error={error} message={busy ? 'Submitting your request…' : null} />
      <button className={`${primaryClass} w-full`} disabled={busy} type="submit">Create account</button>
    </form>}
    <div className="mt-6 flex flex-wrap gap-3"><Link className={buttonClass} href={loginPath(sanitizeNextPath(next))}>Sign in</Link>{complete && <Link className={buttonClass} href="/forgot-password">Reset password</Link>}</div>
  </AccessShell>;
}

export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!validEmail(email)) { setError('Enter a valid email.'); return; }
    setBusy(true); setError(null);
    try { await authApi.requestPasswordReset(email); setComplete(true); } catch (cause) { setError(authErrorMessage(cause)); } finally { setBusy(false); }
  }
  return <AccessShell title="Reset your password.">
    {complete ? <Status message="Request received. If an account exists for that email and email delivery is available, check your inbox for a password-reset link." /> : <form onSubmit={submit} className="space-y-5" aria-busy={busy}>
      <Field name="email" label="Email" type="email" autoComplete="username" required maxLength={254} value={email} disabled={busy} onChange={(e) => setEmail(e.target.value)} />
      <Status error={error} message={busy ? 'Requesting a reset link…' : null} />
      <button className={primaryClass} disabled={busy}>Request reset link</button>
    </form>}
    <Link className={`${buttonClass} mt-6`} href="/login">Back to sign in</Link>
  </AccessShell>;
}

export function ResetPasswordForm({ token }: { token?: string }) {
  const { refresh } = useAuth();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usable = validToken(token);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !usable) return;
    const problem = passwordError(password) ?? (password !== confirmation ? 'Passwords do not match.' : null);
    if (problem) { setError(problem); return; }
    setBusy(true); setError(null);
    try {
      await authApi.resetPassword(token!, password);
      setComplete(true); setPassword(''); setConfirmation('');
      window.history.replaceState(null, '', '/reset-password');
      await refresh();
    } catch (cause) { setError(authErrorMessage(cause)); } finally { setBusy(false); }
  }
  return <AccessShell title="Choose a new password.">
    {complete ? <Status message="Password updated. All previous sessions have ended. Sign in with your new password." /> : !usable ? <Status error="Invalid or expired link. Request a new password-reset link." /> : <form onSubmit={submit} className="space-y-5" aria-busy={busy}>
      <Field name="newPassword" label="New password" type="password" autoComplete="new-password" minLength={12} maxLength={256} required hint={PASSWORD_HINT} value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} />
      <Field name="confirmation" label="Confirm password" type="password" autoComplete="new-password" minLength={12} maxLength={256} required value={confirmation} disabled={busy} onChange={(e) => setConfirmation(e.target.value)} />
      <Status error={error} message={busy ? 'Updating your password…' : null} />
      <button className={primaryClass} disabled={busy}>Update password</button>
    </form>}
    <div className="mt-6 flex flex-wrap gap-3"><Link className={buttonClass} href="/login">Sign in</Link>{!complete && <Link className={buttonClass} href="/forgot-password">Request a new link</Link>}</div>
  </AccessShell>;
}

export function VerifyEmailForm({ token, next }: { token?: string; next?: string }) {
  const { verifyEmail } = useAuth();
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usable = validToken(token);
  return <AccessShell title="Confirm your email.">
    <Status error={error ?? (token && !usable ? 'Invalid or expired link. Please request a new link.' : null)} message={complete ? 'Email verified. You can now sign in.' : busy ? 'Confirming your email…' : !token ? 'Open the verification link from your email. If your registration is still pending, you can submit the registration form again to request a new link. Email delivery depends on the configured service.' : 'Confirm this email address to finish the registration you requested.'} />
    {usable && !complete && <button className={primaryClass} disabled={busy} onClick={async () => {
      if (busy) return;
      setBusy(true); setError(null);
      try { await verifyEmail(token); setComplete(true); window.history.replaceState(null, '', '/verify-email'); }
      catch (cause) { setError(authErrorMessage(cause)); } finally { setBusy(false); }
    }}>Verify email</button>}
    <div className="mt-6 flex flex-wrap gap-3"><Link className={buttonClass} href={loginPath(sanitizeNextPath(next))}>Sign in</Link>{!complete && <Link className={buttonClass} href="/register">Register / request a new link</Link>}</div>
  </AccessShell>;
}
