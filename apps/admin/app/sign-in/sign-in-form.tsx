'use client';

import { useActionState } from 'react';
import { signIn, type SignInState } from '../actions/auth';

export default function SignInForm() {
  const [state, action, pending] = useActionState<SignInState, FormData>(signIn, {});
  return (
    <form action={action} noValidate>
      <div className="msg-slot" aria-live="polite">
        {state.error && <p className="msg msg-error" id="signin-error">{state.error}</p>}
      </div>
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" autoCapitalize="none" spellCheck={false} required defaultValue={state.email ?? ''} autoFocus aria-describedby={state.error ? 'signin-error' : undefined} />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      <div className="field">
        <label htmlFor="totp">6-digit code</label>
        <input id="totp" name="totp" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required spellCheck={false} aria-describedby="totp-hint" />
        <span className="hint" id="totp-hint">From your authenticator app.</span>
      </div>
      <button className="btn-primary btn-lg" type="submit" disabled={pending}>{pending ? 'Signing in...' : 'Sign in'}</button>
    </form>
  );
}
