'use client';

import { useRef, useState } from 'react';
import { listEmailOutbox, retryEmail } from '../../app/actions/operations';
import type { EmailOutboxItem, Page } from '../../lib/types';
import { LocalTime } from '../console/local-time';

export function EmailOutbox({ initial, status }: { initial: Page<EmailOutboxItem>; status: string }) {
  const [page, setPage] = useState(initial);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  async function run(kind: 'refresh' | 'more' | 'retry', id?: string) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setMessage(null);
    try {
      if (kind === 'retry' && id) {
        const result = await retryEmail(id);
        if (result.ok) {
          setPage((p) => ({ ...p, items: p.items.map((old) => old.id === id ? result.data : old).filter((i) => !status || i.status === status) }));
          setMessage({ ok: true, text: `Email ${id} re-queued. Status: ${result.data.status}; attempts: ${result.data.attempts}. Delivery is handled by the worker.` });
        } else {
          setMessage({ ok: false, text: result.message });
          const fresh = await listEmailOutbox(status);
          if (fresh.ok) setPage(fresh.data);
        }
      } else {
        const result = await listEmailOutbox(status, kind === 'more' ? page.nextCursor ?? '' : '');
        if (result.ok) setPage((p) => ({ items: kind === 'more' ? [...p.items, ...result.data.items.filter((i) => !p.items.some((old) => old.id === i.id))] : result.data.items, nextCursor: result.data.nextCursor }));
        else setMessage({ ok: false, text: result.message });
      }
    } catch { setMessage({ ok: false, text: 'The request did not complete. Refresh the outbox before trying again.' }); } finally { lock.current = false; setBusy(false); }
  }
  return <>
    <div role="status" aria-live="polite" aria-atomic="true">{message && <p className={`msg ${message.ok ? 'msg-ok' : 'msg-error'}`}>{message.text}</p>}</div>
    <div className="toolbar"><p role="status" aria-live="polite">{page.items.length} messages shown · newest first</p><button className="btn" disabled={busy} onClick={() => run('refresh')}>Refresh outbox</button></div>
    {!page.items.length ? <p className="empty" role="status">No emails match this status.</p> : <div className="table-wrap" role="region" aria-label="Email outbox" tabIndex={0}><table className="data"><thead><tr><th>Message / template</th><th>Recipient domain</th><th>Status</th><th className="num">Attempts</th><th>Created / sent</th><th>Last error</th><th>Action</th></tr></thead><tbody>{page.items.map((item) => <tr key={item.id} data-email={item.id}>
      <td><span className="mono">{item.id}</span><br />{item.template}</td><td>{item.toDomain}</td><td><span className={`chip ${item.status === 'FAILED' ? 'chip-anchor-failed' : item.status === 'SENT' ? 'chip-anchor-confirmed' : 'chip-anchor-pending'}`}>{item.status}</span></td><td className="num">{item.attempts}</td><td><LocalTime iso={item.createdAt} /><br />{item.sentAt ? <>Sent <LocalTime iso={item.sentAt} /></> : 'Not sent'}</td><td className="wrap">{item.lastError ?? '—'}</td><td>{item.status === 'FAILED' ? <button className="btn" disabled={busy} onClick={() => run('retry', item.id)} aria-label={`Retry failed email ${item.id}`}>Retry failed</button> : '—'}</td>
    </tr>)}</tbody></table></div>}
    <div className="loadmore">{page.nextCursor ? <button className="btn" disabled={busy} onClick={() => run('more')}>{busy ? 'Loading...' : 'Load more emails'}</button> : <p className="hint">End of list.</p>}</div>
  </>;
}
