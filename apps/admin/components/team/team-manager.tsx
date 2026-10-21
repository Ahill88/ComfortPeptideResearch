'use client';

import { useActionState, useRef, useState } from 'react';
import { createAdmin, deactivateAdmin, type CreateAdminState } from '../../app/actions/team';
import type { AdminUserRow, CreatedAdmin } from '../../lib/types';
import { CopyButton } from '../console/copy-button';
import { LocalTime } from '../console/local-time';

function Credentials({ created, onDone }: { created: CreatedAdmin; onDone: () => void }) {
  const admin = created.admin;
  return (
    <section className="panel panel-error" aria-labelledby="creds-h" style={{ borderLeftColor: '#b45309' }}>
      <h2 id="creds-h">Credentials for {admin.name} ({admin.email})</h2>
      <p className="msg msg-warn" role="alert">
        <strong>Shown once.</strong> This temporary password and the authenticator seed cannot be displayed again. Copy them now and share them securely. Leaving or reloading this page discards them.
      </p>
      <div className="secret">
        <span className="label">Temporary password</span>
        <code>{created.temporaryPassword}</code>
        <CopyButton text={created.temporaryPassword} label="Copy password" />
      </div>
      <div className="secret">
        <span className="label">Authenticator seed (base32)</span>
        <code>{created.mfa.seedBase32}</code>
        <CopyButton text={created.mfa.seedBase32} label="Copy seed" />
      </div>
      <div className="secret">
        <span className="label">otpauth URI (enter in an authenticator app that accepts URIs)</span>
        <code>{created.mfa.otpauthUri}</code>
        <CopyButton text={created.mfa.otpauthUri} label="Copy URI" />
      </div>
      <p className="hint">The new admin can change the password on the Password page after signing in.</p>
      <button type="button" className="btn-primary btn-lg" onClick={onDone}>I have saved these credentials</button>
    </section>
  );
}

export function TeamManager({ users, selfId }: { users: AdminUserRow[]; selfId: string }) {
  const [state, action, pending] = useActionState<CreateAdminState, FormData>(createAdmin, {});
  const [dismissed, setDismissed] = useState<CreatedAdmin | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const lock = useRef(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const created = state.created && state.created !== dismissed ? state.created : null;

  async function deactivate(id: string) {
    if (lock.current) return;
    lock.current = true;
    setWorking(true);
    setResult(null);
    try {
      const r = await deactivateAdmin(id);
      setResult({ ok: r.ok, text: r.message });
      if (r.ok) setConfirming(null);
    } catch {
      setResult({ ok: false, text: 'The request did not complete. Reload to check the current state.' });
    } finally {
      lock.current = false;
      setWorking(false);
    }
  }

  return (
    <>
      {created && <Credentials created={created} onDone={() => setDismissed(created)} />}

      <div aria-live="polite" role="status">
        {result && <p className={`msg ${result.ok ? 'msg-ok' : 'msg-error'}`}>{result.text}</p>}
      </div>

      <section className="panel" aria-labelledby="admins-h">
        <h2 id="admins-h">Admins</h2>
        <div className="table-wrap" role="region" aria-label="Admin accounts" tabIndex={0}>
          <table className="data">
            <thead>
              <tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Last sign-in</th><th scope="col">Created</th><th scope="col"><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}{u.id === selfId && <span className="muted"> (you)</span>}</td>
                  <td style={{ overflowWrap: 'anywhere' }}>{u.email}</td>
                  <td><span className="role" style={{ marginLeft: 0 }}>{u.role}</span></td>
                  <td>{u.active ? 'Active' : 'Deactivated'}</td>
                  <td className="nowrap">{u.lastLoginAt ? <LocalTime iso={u.lastLoginAt} /> : 'Never'}</td>
                  <td className="nowrap"><LocalTime iso={u.createdAt} /></td>
                  <td>
                    {u.active && u.id !== selfId && (
                      confirming === u.id ? (
                        <span className="btn-row" style={{ marginTop: 0 }} role="group" aria-label={`Confirm deactivating ${u.email}`}>
                          <button type="button" className="btn-danger" disabled={working} onClick={() => deactivate(u.id)}>{working ? 'Working...' : `Confirm: deactivate ${u.name}`}</button>
                          <button type="button" className="btn" disabled={working} onClick={() => setConfirming(null)}>Keep</button>
                        </span>
                      ) : (
                        <button type="button" className="btn btn-danger-outline" onClick={() => { setResult(null); setConfirming(u.id); }} aria-label={`Deactivate ${u.name}`}>Deactivate</button>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" aria-labelledby="create-h" style={{ maxWidth: 560 }}>
        <h2 id="create-h">Create admin</h2>
        <form action={action} noValidate>
          <div aria-live="polite">{state.error && <p className="msg msg-error">{state.error}</p>}</div>
          <div className="field"><label htmlFor="new-name">Name</label><input id="new-name" name="name" type="text" autoComplete="off" required defaultValue={state.values?.name ?? ''} /></div>
          <div className="field"><label htmlFor="new-email">Email</label><input id="new-email" name="email" type="email" autoComplete="off" required defaultValue={state.values?.email ?? ''} /></div>
          <div className="field">
            <label htmlFor="new-role">Role</label>
            <select id="new-role" name="role" defaultValue={state.values?.role ?? 'STAFF'}>
              <option value="STAFF">STAFF</option>
              <option value="OWNER">OWNER (also manages the team and reads the audit log)</option>
            </select>
          </div>
          <button type="submit" className="btn-primary btn-lg" disabled={pending}>{pending ? 'Creating...' : 'Create admin'}</button>
          <p className="hint" style={{ marginTop: 8 }}>A temporary password and authenticator seed are generated and shown once.</p>
        </form>
      </section>
    </>
  );
}
