'use client';

import { useRef, useState } from 'react';
import { readSanctions, refreshSanctions } from '../../app/actions/operations';
import type { SanctionsStatus } from '../../lib/types';
import { LocalTime } from '../console/local-time';

export function CompliancePanel({ initial, initialError, isOwner }: { initial: SanctionsStatus | null; initialError: string; isOwner: boolean }) {
  const [data, setData] = useState(initial);
  const [message, setMessage] = useState(initialError);
  const [ok, setOk] = useState(false);
  const [force, setForce] = useState(false);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  async function run(refresh: boolean) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setMessage('');
    try {
      const r = refresh ? await refreshSanctions(force) : await readSanctions();
      if (r.data) setData(r.data);
      setOk(r.ok); setMessage(r.ok ? refresh ? 'Sanctions list refreshed.' : 'Status updated.' : r.message);
      setReview(false); if (r.ok) setForce(false);
    } catch { setOk(false); setMessage('The request did not complete. Check status before trying again.'); setReview(false); } finally { lock.current = false; setBusy(false); }
  }
  return <section className="panel" aria-labelledby="sanctions-h">
    <h2 id="sanctions-h">OFAC SDN address list</h2>
    <div role="status" aria-live="polite" aria-atomic="true">{message && <p className={`msg ${ok ? 'msg-ok' : 'msg-error'}`}>{message}</p>}{busy && <p>Working... a list download can take over a minute.</p>}</div>
    {data && <dl className="dl"><dt>Source</dt><dd className="mono">{data.source}</dd><dt>Stored addresses</dt><dd data-address-count>{data.addressCount}</dd><dt>Last completed run</dt><dd>{data.lastRun ? <LocalTime iso={data.lastRun.fetchedAt} withSeconds /> : 'Never loaded: no completed run recorded.'}</dd>{data.lastRun && <><dt>Run status</dt><dd><strong>{data.lastRun.status}</strong></dd><dt>Run entry count</dt><dd>{data.lastRun.entryCount}</dd><dt>Last run error</dt><dd>{data.lastRun.error ?? 'None'}</dd></>}</dl>}
    <p className="hint">A failed refresh keeps the last good list. Until the first successful load, production screening refuses requests. Address matching is exact, with case-insensitive matching for EVM-style addresses.</p>
    <div className="btn-row"><button className="btn" disabled={busy} onClick={() => run(false)}>Check status</button></div>
    {isOwner ? <div className="action-block">
      <label className="check"><input type="checkbox" checked={force} disabled={busy || review} onChange={(e) => setForce(e.target.checked)} />Force refresh: accept a large drop in address count</label>
      <p className="hint">Force bypasses the protection against a drop of more than 50% from the last successful run. An empty list is always refused.</p>
      {!review ? <button className="btn-primary" disabled={busy} onClick={() => setReview(true)}>Review list refresh</button> : <div className="confirm" role="group" aria-label="Confirm sanctions refresh"><h3>{force ? 'Confirm forced refresh' : 'Confirm list refresh'}</h3><p>{force ? 'This permits replacing the current list even if the address count falls by more than 50%. Confirm only after investigating the source and the count change. An empty list will still be refused.' : 'Download the configured source and replace the stored addresses only if validation succeeds. The previous list remains in force on failure.'}</p><p>The API audits this refresh and whether force was used.</p><div className="btn-row"><button className={force ? 'btn-danger' : 'btn-primary'} disabled={busy} onClick={() => run(true)}>{force ? 'Confirm forced refresh' : 'Confirm list refresh'}</button><button className="btn" disabled={busy} onClick={() => setReview(false)}>Cancel refresh</button></div></div>}
    </div> : <p className="hint">Only an owner can refresh the sanctions list. Staff can check status.</p>}
  </section>;
}
