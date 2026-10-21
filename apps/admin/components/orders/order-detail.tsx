'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { runOrderAction, type ActionInput } from '../../app/actions/orders';
import { CARRIERS, type AdminOrderDetail, type OrderAction } from '../../lib/types';
import { CopyButton } from '../console/copy-button';
import { atomicToUsdc, explorerUrl, formatMoney, shortId, statusLabel } from '../console/format';
import { LocalTime } from '../console/local-time';
import { StatusChip } from '../console/status-chip';

type Mode = 'idle' | 'ship' | 'ship-confirm' | 'cancel';
interface Message { kind: 'ok' | 'error'; text: string }

const TRACKING = /^[A-Za-z0-9-]{6,40}$/;

export function OrderDetail({ initial }: { initial: AdminOrderDetail }) {
  const [order, setOrder] = useState(initial);
  const [mode, setMode] = useState<Mode>('idle');
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const [message, setMessage] = useState<Message | null>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);

  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  const [shipNote, setShipNote] = useState('');
  const [shipErrors, setShipErrors] = useState<{ carrier?: string; tracking?: string; note?: string }>({});
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState('');
  const [noteText, setNoteText] = useState('');
  const [noteError, setNoteError] = useState('');

  const allowed = useMemo(() => new Set<OrderAction>(order.allowedActions), [order.allowedActions]);
  const events = useMemo(() => [...order.events].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [order.events]);
  const normalisedTracking = tracking.replace(/\s+/g, '');
  const total = formatMoney(order.totalCents, order.currency);

  useEffect(() => {
    if (message) messageRef.current?.focus();
  }, [message]);

  async function run(input: ActionInput, after?: () => void) {
    if (lock.current) return; // double-click guard: state updates are async, the ref is not
    lock.current = true;
    setPending(true);
    setMessage(null);
    try {
      const result = await runOrderAction(order.id, input);
      if (result.order) setOrder(result.order);
      if (result.ok) {
        setMessage({ kind: 'ok', text: result.message });
        after?.();
        setMode('idle');
      } else {
        setMessage({ kind: 'error', text: result.message });
        // A conflict means the screen was stale: leave any form whose action is no longer offered.
        if (result.order && mode !== 'idle') {
          const next = new Set(result.order.allowedActions);
          if ((mode.startsWith('ship') && !next.has('ship')) || (mode === 'cancel' && !next.has('cancel'))) setMode('idle');
        }
      }
    } catch {
      setMessage({ kind: 'error', text: 'The request did not complete. Reload this page to check the order\'s current state before trying again.' });
    } finally {
      lock.current = false;
      setPending(false);
    }
  }

  function reviewShipment(event: React.FormEvent) {
    event.preventDefault();
    const errors: typeof shipErrors = {};
    if (!(CARRIERS as readonly string[]).includes(carrier)) errors.carrier = 'Choose a carrier.';
    if (!normalisedTracking) errors.tracking = 'Enter the tracking number.';
    else if (!TRACKING.test(normalisedTracking)) errors.tracking = 'Tracking number must be 6 to 40 letters, digits or dashes.';
    if (shipNote.length > 500) errors.note = 'Note is limited to 500 characters.';
    setShipErrors(errors);
    if (Object.keys(errors).length === 0) setMode('ship-confirm');
  }

  function submitCancel(event: React.FormEvent) {
    event.preventDefault();
    if (reason.trim().length < 3) { setReasonError('Enter a reason (at least 3 characters).'); return; }
    setReasonError('');
    void run({ action: 'cancel', reason }, () => setReason(''));
  }

  function submitNote(event: React.FormEvent) {
    event.preventDefault();
    if (!noteText.trim()) { setNoteError('Enter a note.'); return; }
    if (noteText.length > 1000) { setNoteError('Notes are limited to 1000 characters.'); return; }
    setNoteError('');
    void run({ action: 'notes', note: noteText }, () => setNoteText(''));
  }

  const payment = order.payment;
  const usdc = payment ? atomicToUsdc(payment.amountAtomic) : null;
  const explorer = payment?.txSignature ? explorerUrl(payment.network, payment.txSignature) : null;
  const address = order.shippingAddress?.trim() ? order.shippingAddress : null;
  const fulfilmentActions = (['start-packing', 'ship', 'mark-delivered', 'cancel'] as OrderAction[]).filter((a) => allowed.has(a));

  return (
    <>
      <p><Link className="back" href="/orders">&larr; Back to queue</Link></p>
      <div className="page-head">
        <div>
          <div className="order-head">
            <h1>Order {shortId(order.id)}</h1>
            <StatusChip status={order.status} />
          </div>
          <p className="order-id">{order.id}</p>
          <p>Placed <LocalTime iso={order.createdAt} /> &middot; {order.itemCount} {order.itemCount === 1 ? 'item' : 'items'} &middot; {total}</p>
        </div>
        <a className="btn" href={`/orders/${encodeURIComponent(order.id)}/packing-slip`} target="_blank" rel="noopener noreferrer">Packing slip (opens in a new tab)</a>
      </div>

      <div className="detail-grid">
        <div>
          <section className="panel" aria-labelledby="ship-to">
            <h2 id="ship-to">Ship to</h2>
            {address ? (
              <>
                <p className="address" id="address-text" tabIndex={0} aria-label="Shipping address">{address}</p>
                <CopyButton text={address} label="Copy address" className="btn btn-lg" />
              </>
            ) : (
              <p className="address address-missing">No shipping address on this order. Do not ship until one is confirmed.</p>
            )}
          </section>

          <section className="panel" aria-labelledby="items-h">
            <h2 id="items-h">Items</h2>
            <div className="table-wrap" role="region" aria-label="Order items" tabIndex={0}>
              <table className="data">
                <thead>
                  <tr><th scope="col">Product</th><th scope="col">SKU</th><th scope="col">Lot code</th><th scope="col" className="num">Qty</th><th scope="col" className="num">Unit</th></tr>
                </thead>
                <tbody>
                  {order.items.map((item) => (
                    <tr key={item.id}>
                      <td>{item.name}</td>
                      <td className="mono">{item.sku}</td>
                      <td>{item.lotCode ? <span className="lot">{item.lotCode}</span> : <span className="muted">No lot recorded</span>}</td>
                      <td className="num"><strong style={{ fontSize: 17 }}>{item.quantity}</strong></td>
                      <td className="num muted">{formatMoney(item.unitCents, order.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel" aria-labelledby="payment-h">
            <h2 id="payment-h">Payment</h2>
            {!payment ? (
              <p className="muted">No payment record for this order.</p>
            ) : (
              <dl className="dl">
                <dt>Status</dt><dd>{payment.status}</dd>
                <dt>Amount</dt><dd>{usdc ? <strong className="mono">{usdc} USDC</strong> : <span>Unreadable amount: {payment.amountAtomic}</span>}</dd>
                <dt>Network</dt><dd className="mono">{payment.network}</dd>
                <dt>Transaction</dt>
                <dd>
                  {payment.txSignature ? (
                    <span className="sig">
                      <code>{payment.txSignature}</code>
                      <CopyButton text={payment.txSignature} label="Copy signature" />
                      {explorer && <a className="btn" href={explorer} target="_blank" rel="noopener noreferrer">View on Solana Explorer (devnet)</a>}
                    </span>
                  ) : <span className="muted">No transaction signature recorded.</span>}
                </dd>
                <dt>Finalized</dt><dd>{payment.finalizedAt ? <LocalTime iso={payment.finalizedAt} withSeconds /> : 'Not finalized'}</dd>
              </dl>
            )}
          </section>

          {order.shipments.length > 0 && (
            <section className="panel" aria-labelledby="shipments-h">
              <h2 id="shipments-h">Shipments</h2>
              {order.shipments.map((s) => (
                <dl className="dl" key={s.id} style={{ marginBottom: 10 }}>
                  <dt>Carrier</dt><dd>{s.carrier}</dd>
                  <dt>Tracking</dt><dd><span className="sig"><code>{s.trackingNumber}</code><CopyButton text={s.trackingNumber} label="Copy tracking" /></span></dd>
                  <dt>Shipped</dt><dd><LocalTime iso={s.shippedAt} /></dd>
                  <dt>Delivered</dt><dd>{s.deliveredAt ? <LocalTime iso={s.deliveredAt} /> : 'Not yet'}</dd>
                  {s.note && (<><dt>Note</dt><dd>{s.note}</dd></>)}
                </dl>
              ))}
            </section>
          )}

          <section className="panel" aria-labelledby="timeline-h">
            <h2 id="timeline-h">Timeline <span className="muted" style={{ fontWeight: 400 }}>(oldest first)</span></h2>
            {events.length === 0 ? <p className="muted">No events recorded.</p> : (
              <ol className="timeline">
                {events.map((event) => (
                  <li key={event.id} className={event.kind === 'NOTE' ? 'note' : undefined}>
                    <div>
                      <strong>
                        {event.kind === 'NOTE' ? 'Note' : event.fromStatus ? `${statusLabel(event.fromStatus)} \u2192 ${statusLabel(event.toStatus ?? '')}` : `Status: ${statusLabel(event.toStatus ?? '')}`}
                      </strong>{' '}
                      <span className="when"><LocalTime iso={event.createdAt} withSeconds /> &middot; {event.adminName ?? 'System'}</span>
                    </div>
                    {event.note && <p className="note-text">{event.note}</p>}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <aside className="detail-side" aria-label="Customer and actions">
          <section className="panel" aria-labelledby="actions-h">
            <h2 id="actions-h">Actions</h2>
            <div aria-live="polite" aria-atomic="true" role="status">
              {message && (
                <p ref={messageRef} tabIndex={-1} className={`msg ${message.kind === 'ok' ? 'msg-ok' : 'msg-error'}`}>
                  <strong>{message.kind === 'ok' ? 'Done: ' : 'Not done: '}</strong>{message.text}
                </p>
              )}
            </div>

            {fulfilmentActions.length === 0 && (
              <p className="muted">No fulfilment actions are available while this order is {statusLabel(order.status).toLowerCase()}.</p>
            )}

            {allowed.has('start-packing') && (
              <div className="action-block">
                <button type="button" className="btn-primary btn-lg" style={{ width: '100%' }} disabled={pending} onClick={() => run({ action: 'start-packing' })}>
                  {pending ? 'Working...' : 'Start packing'}
                </button>
              </div>
            )}

            {allowed.has('ship') && (
              <div className="action-block">
                {mode === 'ship' || mode === 'ship-confirm' ? (
                  mode === 'ship' ? (
                    <form onSubmit={reviewShipment} noValidate aria-label="Mark shipped">
                      <h3 style={{ marginBottom: 10 }}>Mark shipped</h3>
                      <div className="field">
                        <label htmlFor="carrier">Carrier</label>
                        <select id="carrier" value={carrier} onChange={(e) => { setCarrier(e.target.value); setShipErrors((v) => ({ ...v, carrier: undefined })); }} aria-invalid={Boolean(shipErrors.carrier)} aria-describedby={shipErrors.carrier ? 'carrier-err' : undefined} required>
                          <option value="">Select carrier</option>
                          {CARRIERS.map((c) => <option key={c} value={c}>{c === 'OTHER' ? 'Other' : c}</option>)}
                        </select>
                        {shipErrors.carrier && <span id="carrier-err" className="field-error">{shipErrors.carrier}</span>}
                      </div>
                      <div className="field">
                        <label htmlFor="tracking">Tracking number</label>
                        <input id="tracking" type="text" value={tracking} onChange={(e) => { setTracking(e.target.value); setShipErrors((v) => ({ ...v, tracking: undefined })); }} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={60} aria-invalid={Boolean(shipErrors.tracking)} aria-describedby={shipErrors.tracking ? 'tracking-err' : undefined} required />
                        {shipErrors.tracking && <span id="tracking-err" className="field-error">{shipErrors.tracking}</span>}
                      </div>
                      <div className="field">
                        <label htmlFor="ship-note">Note <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label>
                        <textarea id="ship-note" value={shipNote} onChange={(e) => { setShipNote(e.target.value); setShipErrors((v) => ({ ...v, note: undefined })); }} maxLength={500} aria-invalid={Boolean(shipErrors.note)} />
                        {shipErrors.note && <span className="field-error">{shipErrors.note}</span>}
                      </div>
                      <div className="btn-row">
                        <button type="submit" className="btn-primary btn-lg">Review shipment</button>
                        <button type="button" className="btn btn-lg" onClick={() => { setMode('idle'); setShipErrors({}); }}>Close form</button>
                      </div>
                    </form>
                  ) : (
                    <div className="confirm" role="group" aria-labelledby="confirm-ship-h">
                      <h3 id="confirm-ship-h">Confirm shipment</h3>
                      <p className="hint">Check the address on the parcel and the tracking number. This marks the order as shipped.</p>
                      <p className="address">{address ?? 'No shipping address on this order.'}</p>
                      <dl className="dl">
                        <dt>Carrier</dt><dd>{carrier}</dd>
                        <dt>Tracking</dt><dd className="mono"><strong>{normalisedTracking}</strong></dd>
                        {shipNote.trim() && (<><dt>Note</dt><dd>{shipNote.trim()}</dd></>)}
                      </dl>
                      <div className="btn-row">
                        <button type="button" className="btn-primary btn-lg" disabled={pending} onClick={() => run({ action: 'ship', carrier, trackingNumber: normalisedTracking, note: shipNote }, () => { setCarrier(''); setTracking(''); setShipNote(''); })}>
                          {pending ? 'Working...' : 'Confirm: mark shipped'}
                        </button>
                        <button type="button" className="btn btn-lg" disabled={pending} onClick={() => setMode('ship')}>Back</button>
                      </div>
                    </div>
                  )
                ) : (
                  <button type="button" className="btn-primary btn-lg" style={{ width: '100%' }} disabled={pending} onClick={() => { setMessage(null); setMode('ship'); }}>Mark shipped</button>
                )}
              </div>
            )}

            {allowed.has('mark-delivered') && (
              <div className="action-block">
                <button type="button" className="btn-primary btn-lg" style={{ width: '100%' }} disabled={pending} onClick={() => run({ action: 'mark-delivered' })}>
                  {pending ? 'Working...' : 'Mark delivered'}
                </button>
              </div>
            )}

            {allowed.has('cancel') && (
              <div className="action-block">
                {mode === 'cancel' ? (
                  <form onSubmit={submitCancel} noValidate aria-label="Cancel order">
                    <h3 style={{ marginBottom: 10 }}>Cancel order</h3>
                    <p className="hint">Only available while the order is awaiting payment.</p>
                    <div className="field">
                      <label htmlFor="reason">Reason</label>
                      <textarea id="reason" value={reason} onChange={(e) => { setReason(e.target.value); setReasonError(''); }} maxLength={500} aria-invalid={Boolean(reasonError)} aria-describedby={reasonError ? 'reason-err' : undefined} required />
                      {reasonError && <span id="reason-err" className="field-error">{reasonError}</span>}
                    </div>
                    <div className="btn-row">
                      <button type="submit" className="btn-danger btn-lg" disabled={pending}>{pending ? 'Working...' : 'Confirm: cancel order'}</button>
                      <button type="button" className="btn btn-lg" disabled={pending} onClick={() => { setMode('idle'); setReasonError(''); }}>Keep order</button>
                    </div>
                  </form>
                ) : (
                  <>
                    <button type="button" className="btn btn-danger-outline btn-lg" style={{ width: '100%' }} disabled={pending} onClick={() => { setMessage(null); setMode('cancel'); }}>Cancel order</button>
                    <p className="hint" style={{ marginTop: 6 }}>Awaiting payment only.</p>
                  </>
                )}
              </div>
            )}

            {allowed.has('add-note') && (
              <form className="action-block" onSubmit={submitNote} noValidate aria-label="Add note">
                <div className="field">
                  <label htmlFor="note">Add note</label>
                  <textarea id="note" value={noteText} onChange={(e) => { setNoteText(e.target.value); setNoteError(''); }} maxLength={1000} aria-invalid={Boolean(noteError)} aria-describedby={noteError ? 'note-err' : undefined} />
                  {noteError && <span id="note-err" className="field-error">{noteError}</span>}
                </div>
                <button type="submit" className="btn btn-lg" disabled={pending}>{pending ? 'Working...' : 'Add note'}</button>
              </form>
            )}
          </section>

          <section className="panel" aria-labelledby="customer-h">
            <h2 id="customer-h">Customer</h2>
            <dl className="dl">
              <dt>Name</dt><dd>{order.customer.name ?? <span className="muted">Not provided</span>}</dd>
              <dt>Email</dt><dd>{order.customer.email}</dd>
              <dt>Customer ID</dt><dd className="mono">{order.customer.id}</dd>
            </dl>
          </section>
        </aside>
      </div>
    </>
  );
}
