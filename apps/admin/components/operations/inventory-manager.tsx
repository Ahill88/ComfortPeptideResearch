'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { adjustInventory, inventoryLedger, listInventory, readInventoryItem, setInventoryThreshold } from '../../app/actions/operations';
import type { InventoryItem, InventoryMovement, Page } from '../../lib/types';
import { LocalTime } from '../console/local-time';

const signed = (n: number) => n > 0 ? `+${n}` : String(n);
const uncertain = 'The request did not complete. Refresh the current stock and ledger before trying again.';

export function InventoryManager({ initial, q, lowStockOnly, isOwner }: { initial: Page<InventoryItem>; q: string; lowStockOnly: boolean; isOwner: boolean }) {
  const [page, setPage] = useState(initial);
  const [selected, setSelected] = useState<InventoryItem | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  async function load(more: boolean) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const result = await listInventory(q, lowStockOnly, more ? page.nextCursor ?? '' : '');
      if (result.ok) setPage((p) => ({ items: more ? [...p.items, ...result.data.items.filter((i) => !p.items.some((old) => old.productId === i.productId))] : result.data.items, nextCursor: result.data.nextCursor }));
      else setError(result.message);
    } catch { setError(uncertain); } finally { lock.current = false; setBusy(false); }
  }
  function update(item: InventoryItem) {
    setSelected((old) => old?.productId === item.productId ? item : old);
    setPage((p) => ({ ...p, items: p.items.map((old) => old.productId === item.productId ? item : old).filter((i) => !lowStockOnly || i.lowStock) }));
  }
  return <>
    {selected && <InventoryDetail key={selected.productId} item={selected} isOwner={isOwner} update={update} close={() => setSelected(null)} />}
    <div className="toolbar"><p role="status" aria-live="polite">{page.items.length} products shown{page.nextCursor ? ' (more available)' : ''}</p><button className="btn" disabled={busy} onClick={() => load(false)}>Refresh list</button></div>
    {error && <p className="msg msg-error" role="alert">{error}</p>}
    {!page.items.length ? <p className="empty" role="status">No products match these filters.</p> : <div className="table-wrap" role="region" aria-label="Inventory" tabIndex={0}><table className="data">
      <thead><tr><th>Product / SKU</th><th>Catalog</th><th className="num">On hand (sellable)</th><th className="num">Reserved</th><th className="num">Threshold</th><th>Stock status</th><th>Details</th></tr></thead>
      <tbody>{page.items.map((p) => <tr key={p.productId} data-inventory={p.productId}>
        <td>{p.name}<br /><span className="mono">{p.sku}</span></td><td>{p.active ? 'Active' : 'Inactive'}</td><td className="num" data-on-hand>{p.onHand}</td><td className="num">{p.reserved}</td><td className="num">{p.lowStockThreshold ?? 'Not set'}</td>
        <td>{p.lowStock ? <span className="chip chip-anchor-pending">Low stock</span> : p.lowStockThreshold === null ? 'No threshold' : 'Above threshold'}</td>
        <td><button className="btn" onClick={() => setSelected(p)} aria-label={`Stock details for ${p.sku}`}>Stock details</button></td>
      </tr>)}</tbody>
    </table></div>}
    <div className="loadmore">{page.nextCursor ? <button className="btn" disabled={busy} onClick={() => load(true)}>{busy ? 'Loading...' : 'Load more products'}</button> : <p className="hint">End of list.</p>}</div>
  </>;
}

function InventoryDetail({ item, isOwner, update, close }: { item: InventoryItem; isOwner: boolean; update: (item: InventoryItem) => void; close: () => void }) {
  const [ledger, setLedger] = useState<Page<InventoryMovement>>({ items: [], nextCursor: null });
  const [ledgerError, setLedgerError] = useState('');
  const [ledgerLoading, setLedgerLoading] = useState(true);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [review, setReview] = useState(false);
  const [threshold, setThreshold] = useState(String(item.lowStockThreshold ?? ''));
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const ledgerLock = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const n = /^[+-]?\d+$/.test(delta) ? Number(delta) : NaN;
  const validDelta = Number.isInteger(n) && n !== 0 && Math.abs(n) <= 100000;
  const after = item.onHand + n;
  const invalid = !validDelta ? 'Enter a non-zero whole number from -100000 to 100000.' : after < 0 ? 'This would make sellable stock negative. Remove fewer units.' : after > 2147483647 ? 'This would exceed the stock limit.' : !reason.trim() ? 'Enter a reason (1 to 200 characters).' : '';

  useEffect(() => {
    heading.current?.focus();
    let cancelled = false;
    inventoryLedger(item.productId).then((r) => { if (!cancelled) { if (r.ok) setLedger(r.data); else setLedgerError(r.message); } }).catch(() => { if (!cancelled) setLedgerError('The ledger could not be loaded.'); }).finally(() => { if (!cancelled) setLedgerLoading(false); });
    return () => { cancelled = true; };
  }, [item.productId]);

  async function loadLedger(more = false) {
    if (ledgerLock.current) return;
    ledgerLock.current = true; setLedgerLoading(true); setLedgerError('');
    try {
      const r = await inventoryLedger(item.productId, more ? ledger.nextCursor ?? '' : '');
      if (r.ok) setLedger((p) => ({ items: more ? [...p.items, ...r.data.items.filter((i) => !p.items.some((old) => old.id === i.id))] : r.data.items, nextCursor: r.data.nextCursor }));
      else setLedgerError(r.message);
    } catch { setLedgerError('The ledger could not be loaded.'); } finally { ledgerLock.current = false; setLedgerLoading(false); }
  }
  async function run(kind: 'adjust' | 'threshold' | 'refresh') {
    if (lock.current) return;
    if (kind === 'adjust' && invalid) { setMessage({ ok: false, text: invalid }); return; }
    lock.current = true; setPending(true); setMessage(null);
    try {
      const r = kind === 'adjust' ? await adjustInventory(item.productId, item.sku, n, reason) : kind === 'threshold' ? await setInventoryThreshold(item.productId, threshold.trim() === '' ? null : /^\d+$/.test(threshold) ? Number(threshold) : NaN) : await readInventoryItem(item.productId, item.sku);
      if (r.data) update(r.data);
      setReview(false);
      if (r.ok) {
        setMessage({ ok: true, text: kind === 'adjust' ? `Adjustment accepted: ${signed(n)} units. API returned ${r.data.onHand} sellable units. Check the ledger below for the recorded movement.` : kind === 'threshold' ? 'Low-stock threshold updated.' : 'Stock refreshed.' });
        if (kind === 'adjust') { setDelta(''); setReason(''); }
        setThreshold(String(r.data.lowStockThreshold ?? ''));
      } else setMessage({ ok: false, text: r.message });
      await loadLedger();
    } catch { setReview(false); setMessage({ ok: false, text: uncertain }); } finally { lock.current = false; setPending(false); }
  }
  return <section className="panel inventory-detail" aria-labelledby="stock-detail-h">
    <div className="page-head"><div><h2 id="stock-detail-h" ref={heading} tabIndex={-1}>{item.name} · {item.sku}</h2><p><strong data-stock-current>{item.onHand} sellable units</strong> · {item.reserved} reserved (already deducted)</p></div><div className="btn-row"><button className="btn" disabled={pending} onClick={() => run('refresh')}>Refresh stock</button><button className="btn" disabled={pending} onClick={close}>Close stock details</button></div></div>
    <div role="status" aria-live="polite" aria-atomic="true">{message && <p className={`msg ${message.ok ? 'msg-ok' : 'msg-error'}`}>{message.text}</p>}</div>
    <div className="form-grid">
      <form aria-label="Adjust stock" onSubmit={(e) => { e.preventDefault(); if (invalid) setMessage({ ok: false, text: invalid }); else setReview(true); }}>
        <h3>Adjust stock</h3>
        <fieldset disabled={pending || review} className="plain-fieldset">
          <div className="field"><label htmlFor="stock-delta">Change in units (+ or −)</label><input id="stock-delta" type="text" inputMode="text" value={delta} onChange={(e) => setDelta(e.target.value)} aria-describedby="stock-preview" autoComplete="off" /></div>
          <div className="field"><label htmlFor="stock-reason">Adjustment reason</label><textarea id="stock-reason" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        </fieldset>
        <p id="stock-preview" role="status" aria-live="polite">{validDelta ? `Preview: ${item.onHand} ${n > 0 ? '+' : '−'} ${Math.abs(n)} = ${after} sellable units.` : 'Enter a signed whole-unit adjustment to preview the result.'} {validDelta && (after < 0 || after > 2147483647) && <strong className="field-error">{invalid}</strong>}</p>
        {!review ? <button className="btn-primary" type="submit" disabled={pending || Boolean(invalid)}>Review adjustment</button> : <div className="confirm" role="group" aria-label="Confirm stock adjustment"><h3>Confirm adjustment</h3><p>{item.sku}: {signed(n)} units → {after} sellable units.</p><p className="wrap">Reason: {reason.trim()}</p><p className="hint">Stock can change before confirmation. The API checks the result atomically and records an ADMIN_ADJUST ledger movement.</p><div className="btn-row"><button className="btn-primary" type="button" disabled={pending || Boolean(invalid)} onClick={() => run('adjust')}>Confirm adjustment</button><button className="btn" type="button" disabled={pending} onClick={() => setReview(false)}>Back to adjustment</button></div></div>}
      </form>
      <form aria-label="Low-stock threshold" onSubmit={(e) => { e.preventDefault(); void run('threshold'); }}>
        <h3>Low-stock threshold</h3><p className="hint">Low stock means sellable units are at or below this threshold. Leave blank to clear; zero is a valid threshold.</p>
        <div className="field"><label htmlFor="stock-threshold">Threshold (OWNER)</label><input id="stock-threshold" type="text" inputMode="numeric" value={threshold} onChange={(e) => setThreshold(e.target.value)} disabled={!isOwner || pending} aria-describedby={!isOwner ? 'stock-owner-note' : undefined} /></div>
        {!isOwner && <p id="stock-owner-note" className="hint">Only an owner can change the threshold. Staff can adjust stock.</p>}
        <button type="submit" className="btn" disabled={!isOwner || pending}>Save threshold</button>
        {isOwner && <p><Link className="inline-target" href={`/audit?targetType=product&targetId=${encodeURIComponent(item.productId)}`}>View product audit log</Link></p>}
      </form>
    </div>
    <h3>Stock ledger <span className="hint">Newest first</span></h3>
    <div role="status" aria-live="polite">{ledgerLoading && <p>Loading ledger...</p>}{ledgerError && <p className="msg msg-error">{ledgerError}</p>}</div>
    <button className="btn" disabled={ledgerLoading || pending} onClick={() => loadLedger()}>Refresh ledger</button>
    {ledger.items.length ? <div className="table-wrap" role="region" aria-label="Stock ledger" tabIndex={0}><table className="data"><thead><tr><th>When</th><th className="num">Change</th><th>Kind</th><th>Reason</th><th>Order</th><th>Admin</th></tr></thead><tbody>{ledger.items.map((m) => <tr key={m.id} data-movement={m.id}><td><LocalTime iso={m.createdAt} withSeconds /></td><td className="num">{signed(m.delta)}</td><td className="mono">{m.kind}</td><td className="wrap">{m.reason ?? '—'}</td><td>{m.orderId ? <Link className="inline-target mono" href={`/orders/${encodeURIComponent(m.orderId)}`}>{m.orderId}</Link> : '—'}</td><td>{m.adminName ?? 'System / unavailable'}</td></tr>)}</tbody></table></div> : !ledgerLoading && !ledgerError && <p className="empty">No stock movements recorded.</p>}
    {ledger.nextCursor && <div className="loadmore"><button className="btn" disabled={ledgerLoading || pending} onClick={() => loadLedger(true)}>Load more movements</button></div>}
  </section>;
}
