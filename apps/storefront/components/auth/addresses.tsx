'use client';

import { useState, type FormEvent } from 'react';
import { authApi, authErrorMessage } from '../../lib/auth/api';
import { formatAddress } from '../../lib/auth/addresses';
import { useAddresses } from '../../lib/auth/use-default-address';
import type { Address, AddressInput } from '../../lib/auth/types';
import { ADDRESS_FIELDS, addressError } from '../../lib/auth/validation';
import { AccountShell, ProtectedAccount } from './account-shell';
import { buttonClass, cardClass, Field, primaryClass, Status } from './ui';

const emptyAddress = (): AddressInput => ({ label: '', recipient: '', line1: '', line2: '', city: '', region: '', postalCode: '', country: '', isDefault: false });

export function AddressesPage() { return <ProtectedAccount><AddressBook /></ProtectedAccount>; }

function AddressBook() {
  const { addresses, loading, error: loadError, refresh } = useAddresses();
  const [draft, setDraft] = useState<AddressInput | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function mutate(action: () => Promise<unknown>, success: string) {
    if (busy) return;
    setBusy(true); setError(null); setMessage(null);
    try { await action(); setDraft(null); setDeleting(null); await refresh(); setMessage(success); }
    catch (cause) { setError(authErrorMessage(cause)); } finally { setBusy(false); }
  }
  function edit(address: Address | null) {
    setEditing(address?.id ?? null); setDraft(address ? { ...address } : emptyAddress()); setDeleting(null); setMessage(null); setError(null);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft || busy) return;
    const problem = addressError(draft);
    if (problem) { setError(problem); return; }
    const body: AddressInput = {
      label: draft.label?.trim() || null, recipient: draft.recipient.trim(), line1: draft.line1.trim(), line2: draft.line2?.trim() || null,
      city: draft.city.trim(), region: draft.region.trim(), postalCode: draft.postalCode.trim(), country: draft.country.trim().toUpperCase(), isDefault: draft.isDefault,
    };
    void mutate(() => editing ? authApi.updateAddress(editing, body) : authApi.createAddress(body), 'Address saved.');
  }
  return <AccountShell title="Saved addresses.">
    <p className="mb-5 text-sm leading-6 text-slate-600">Save up to 20 delivery addresses. The first address is your default; you can choose another at any time.</p>
    <Status error={error ?? loadError} message={busy ? 'Saving changes…' : loading ? 'Loading addresses…' : message} />
    {loadError && <button className={`${buttonClass} mb-5`} disabled={loading} onClick={() => void refresh()}>Reload addresses</button>}
    {draft && <section className={`${cardClass} mb-6 max-w-2xl`} aria-labelledby="address-form-heading">
      <h2 id="address-form-heading" className="mb-6 text-2xl">{editing ? 'Edit address' : 'New address'}</h2>
      <form onSubmit={submit} className="space-y-5" aria-busy={busy}>
        {ADDRESS_FIELDS.map(({ key, label, max, autoComplete, required }) => <Field key={key} name={key} label={label} maxLength={max} autoComplete={autoComplete} required={required} value={draft[key] ?? ''} disabled={busy} onChange={(e) => setDraft({ ...draft, [key]: key === 'country' ? e.target.value.toUpperCase() : e.target.value })} />)}
        <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm"><input type="checkbox" className="h-5 w-5 accent-midnight" checked={draft.isDefault} disabled={busy} onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })} />Use as default address</label>
        <div className="flex flex-wrap gap-3"><button className={primaryClass} disabled={busy}>Save address</button><button type="button" className={buttonClass} disabled={busy} onClick={() => setDraft(null)}>Cancel</button></div>
      </form>
    </section>}
    {!draft && <button className={`${primaryClass} mb-6`} disabled={busy || loading || addresses.length >= 20} onClick={() => edit(null)}>Add address</button>}
    {!loading && !loadError && addresses.length === 0 && <p className="text-sm">You have no saved addresses.</p>}
    <div className="grid gap-6 md:grid-cols-2">{addresses.map((address) => <section className={cardClass} key={address.id} aria-label={address.label ?? address.recipient}>
      <h2 className="break-words text-2xl">{address.label ?? address.recipient}</h2>
      {address.isDefault && <p className="mt-3 text-xs font-semibold uppercase tracking-wider">Default address</p>}
      <address className="mt-4 whitespace-pre-line break-words text-sm not-italic leading-7">{formatAddress(address)}</address>
      <div className="mt-6 flex flex-wrap gap-3"><button className={buttonClass} disabled={busy} onClick={() => edit(address)}>Edit</button>{!address.isDefault && <button className={buttonClass} disabled={busy || loading} onClick={() => void mutate(() => authApi.updateAddress(address.id, { isDefault: true }), 'Default address updated.')}>Make default</button>}<button className={buttonClass} disabled={busy} onClick={() => { setDeleting(address.id); setDraft(null); }}>Delete</button></div>
      {deleting === address.id && <div className="mt-5 border-t border-silver pt-5"><p className="text-sm">Delete this saved address?{address.isDefault && addresses.length > 1 ? ' Another saved address will become your default.' : ''}</p><div className="mt-3 flex flex-wrap gap-3"><button className={primaryClass} disabled={busy} onClick={() => void mutate(() => authApi.deleteAddress(address.id), 'Address deleted.')}>Confirm delete</button><button className={buttonClass} disabled={busy} onClick={() => setDeleting(null)}>Keep address</button></div></div>}
    </section>)}</div>
  </AccountShell>;
}
