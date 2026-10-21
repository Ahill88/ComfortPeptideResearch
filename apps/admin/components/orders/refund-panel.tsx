'use client';

import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import Link from 'next/link';
import { runRefundAction } from '../../app/actions/orders';
import type { AdminOrderDetail } from '../../lib/types';
import { atomicToUsdc, formatMoney } from '../console/format';
import { CopyButton } from '../console/copy-button';
import { LocalTime } from '../console/local-time';

// The refund contract has NO network field. Use only a known network explicitly recorded on this order's payment.
function refundExplorer(order: AdminOrderDetail): string | null {
  const signature = order.refund?.txSignature;
  const network = order.payment?.network;
  if (!signature || !/^[1-9A-HJ-NP-Za-km-z]{32,120}$/.test(signature) || !['solana-devnet', 'solana-mainnet'].includes(network ?? '')) return null;
  return `https://explorer.solana.com/tx/${signature}${network === 'solana-devnet' ? '?cluster=devnet' : ''}`;
}

export function RefundPanel({ order, isOwner, pending, lock, setPending, onOrder }: {
  order: AdminOrderDetail; isOwner: boolean; pending: boolean; lock: RefObject<boolean>;
  setPending: Dispatch<SetStateAction<boolean>>; onOrder: Dispatch<SetStateAction<AdminOrderDetail>>;
}) {
  const [reason, setReason] = useState('');
  const [review, setReview] = useState<'request' | 'submit' | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [stopped, setStopped] = useState(false);
  const [checks, setChecks] = useState(0);
  const [tick, setTick] = useState(0);
  const start = useRef<number | null>(null);
  const mounted = useRef(true);
  const refund = order.refund;
  const canRequest = order.allowedActions.includes('refund') && (!refund || refund.status === 'FAILED');
  const canSubmit = refund?.status === 'REQUESTED' && ['PAID', 'PROCESSING'].includes(order.status);
  const submitted = refund?.status === 'SUBMITTED';
  const url = refundExplorer(order);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { start.current = null; setStopped(false); setChecks(0); }, [refund?.id]);

  async function run(action: 'request' | 'submit' | 'verify', automatic = false) {
    if (lock.current) return;
    lock.current = true; setPending(true);
    if (!automatic) setMessage(null);
    try {
      const r = await runRefundAction(order.id, action, reason);
      if (!mounted.current) return;
      if (r.order) onOrder(r.order);
      if (action === 'verify') setChecks((n) => n + 1);
      if (!automatic || !r.ok || r.order?.refund?.status !== 'SUBMITTED') setMessage({ ok: r.ok, text: r.message });
      if (!r.ok && automatic) setStopped(true);
      setReview(null);
      if (r.ok && action === 'request') setReason('');
    } catch {
      if (mounted.current) { setMessage({ ok: false, text: 'The request did not complete. Reload the order to check the current refund state before trying again.' }); setStopped(true); setReview(null); }
    } finally { lock.current = false; if (mounted.current) setPending(false); }
  }

  useEffect(() => {
    if (!submitted || !isOwner) { start.current = null; return; }
    if (stopped) return;
    if (start.current === null) start.current = Date.now();
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (Date.now() - (start.current ?? Date.now()) >= 120000 || checks >= 24) { setStopped(true); return; }
      if (document.visibilityState === 'visible') await run('verify', true);
      if (!cancelled) setTick((n) => n + 1);
    }, 5000);
    return () => { cancelled = true; clearTimeout(timer); };
    // Tick schedules the next check after the previous request finishes; the shared order lock prevents overlaps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitted, isOwner, stopped, tick, order.id, refund?.id]);

  return <section className="panel" aria-labelledby="refund-h">
    <h2 id="refund-h">Refund</h2>
    <div role="status" aria-live="polite" aria-atomic="true">{message && <p className={`msg ${message.ok ? 'msg-ok' : 'msg-error'}`}>{message.text}</p>}</div>
    {refund ? <>
      <dl className="dl"><dt>Status</dt><dd><strong data-refund-status>{refund.status}</strong></dd><dt>Refund ID</dt><dd className="mono">{refund.id}</dd><dt>Amount</dt><dd>{atomicToUsdc(refund.amountAtomic) ?? `Unreadable amount: ${refund.amountAtomic}`} USDC</dd><dt>Requested</dt><dd><LocalTime iso={refund.requestedAt} withSeconds /></dd><dt>Transaction</dt><dd>{refund.txSignature ? <span className="sig"><code>{refund.txSignature}</code><CopyButton text={refund.txSignature} label="Copy refund signature" />{url && <a className="btn" href={url} target="_blank" rel="noopener noreferrer">View refund on Solana Explorer</a>}</span> : 'Not recorded'}</dd></dl>
      {refund.txSignature && <p className="hint">{url ? `Explorer uses the recorded payment network (${order.payment?.network}). The refund response does not supply a network.` : 'No explorer link: a supported payment network and valid signature are required.'}</p>}
      {refund.status === 'FAILED' && <p className="msg msg-error">Refund FAILED: {refund.failureReason ?? 'No failure reason was returned.'} A new request is available only when the API offers it.</p>}
      {refund.status === 'FINALIZED' && <p className="msg msg-ok">Refund FINALIZED. Order status: {order.status}. The API finalizes the order and releases any recorded unshipped stock reservations together.</p>}
      {refund.status === 'REQUESTED' && <p className="hint">Requested, not submitted. Fulfilment is still possible; if the order ships first, this request cannot be submitted here.</p>}
    </> : <p className="muted">No refund recorded.</p>}
    {!isOwner && <p className="hint">Only an owner can request, submit or verify refunds.</p>}
    {submitted && <div data-testid="refund-poll" role="status" aria-live="polite"><p className="msg msg-warn">A refund is SUBMITTED. Packing and shipping are blocked until verification resolves it.</p>{isOwner && <p>{stopped ? 'Automatic checks stopped. The refund is still SUBMITTED; check again to reconcile it.' : `Checking every 5 seconds while visible, for up to 2 minutes (maximum 24 checks; checked ${checks}).`}</p>}</div>}
    {canRequest && isOwner && <form onSubmit={(e) => { e.preventDefault(); if (!reason.trim()) setMessage({ ok: false, text: 'Enter a refund reason (1 to 500 characters).' }); else setReview('request'); }}>
      <p>Full refund: <strong>{formatMoney(order.totalCents, order.currency)}</strong> ({atomicToUsdc((BigInt(order.totalCents) * 10000n).toString())} USDC). The API determines the amount and pays the customer&apos;s own linked wallet.</p>
      <div className="field"><label htmlFor="refund-reason">Refund reason</label><textarea id="refund-reason" value={reason} maxLength={500} disabled={pending || review === 'request'} onChange={(e) => setReason(e.target.value)} /></div>
      {review === 'request' ? <div className="confirm" role="group" aria-label="Review refund request"><h3>Review full refund</h3><p>{formatMoney(order.totalCents, order.currency)} · Reason: <span className="wrap">{reason.trim()}</span></p><p>This creates a request. Submission is a separate step; the order stays {order.status} until finalization.</p><div className="btn-row"><button className="btn-danger" type="button" disabled={pending} onClick={() => run('request')}>Confirm refund request</button><button className="btn" type="button" disabled={pending} onClick={() => setReview(null)}>Edit refund reason</button></div></div> : <button className="btn" type="submit" disabled={pending}>Review refund</button>}
    </form>}
    {canSubmit && isOwner && (review === 'submit' ? <div className="confirm"><h3>Confirm refund submission</h3><p>Submit {atomicToUsdc(refund!.amountAtomic)} USDC to the customer&apos;s own linked wallet. The merchant signer signs and broadcasts this transfer. Packing and shipping will be blocked while it is SUBMITTED.</p><div className="btn-row"><button className="btn-danger" disabled={pending} onClick={() => run('submit')}>Submit refund</button><button className="btn" disabled={pending} onClick={() => setReview(null)}>Cancel submission</button></div></div> : <button className="btn" disabled={pending} onClick={() => setReview('submit')}>Review submission</button>)}
    {submitted && isOwner && <div className="btn-row"><button className="btn-primary" disabled={pending} onClick={() => run('verify')}>Verify refund now</button>{stopped && <button className="btn" disabled={pending} onClick={() => { start.current = null; setChecks(0); setStopped(false); setTick((n) => n + 1); }}>Resume automatic checks</button>}</div>}
    {isOwner && <Link className="inline-target" href={`/audit?targetType=order&targetId=${encodeURIComponent(order.id)}`}>View refund audit log</Link>}
  </section>;
}
