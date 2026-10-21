'use client';

import { useActionState } from 'react';
import { changePassword, type PasswordState } from '../../app/actions/auth';

export function PasswordForm() {
  const [state, action, pending] = useActionState<PasswordState, FormData>(changePassword, {});
  return (
    <form action={action} noValidate key={state.ok ? 'done' : 'form'}>
      <div aria-live="polite" role="status">
        {state.error && <p className="msg msg-error">{state.error}</p>}
        {state.ok && <p className="msg msg-ok">Password changed.</p>}
      </div>
      <div className="field"><label htmlFor="currentPassword">Current password</label><input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required /></div>
      <div className="field"><label htmlFor="newPassword">New password</label><input id="newPassword" name="newPassword" type="password" autoComplete="new-password" required /></div>
      <div className="field"><label htmlFor="confirmPassword">Confirm new password</label><input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" required /></div>
      <button className="btn-primary btn-lg" type="submit" disabled={pending}>{pending ? 'Changing...' : 'Change password'}</button>
    </form>
  );
}
