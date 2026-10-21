'use client';

import { useRef, useState } from 'react';
import { refreshProducts, setProductPublished } from '../../app/actions/coa';
import type { AdminProduct } from '../../lib/types';
import { formatMoney } from '../console/format';

export function ProductsManager({ initial, isOwner }: { initial: AdminProduct[]; isOwner: boolean }) {
  const [items, setItems] = useState(initial);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const lock = useRef(false);
  const [result, setResult] = useState<{ id: string; ok: boolean; text: string } | null>(null);

  async function apply(product: AdminProduct, publish: boolean) {
    if (lock.current) return;
    lock.current = true;
    setWorking(true);
    setResult(null);
    try {
      const r = await setProductPublished(product.id, publish);
      if (r.ok) {
        setConfirming(null);
        setResult({ id: product.id, ok: true, text: `${product.name}: ${r.message}` });
        const fresh = await refreshProducts();
        if (fresh.ok) setItems(fresh.items);
        else setItems((list) => list.map((p) => (p.id === product.id ? { ...p, active: typeof r.product?.active === 'boolean' ? r.product.active : publish } : p)));
      } else {
        // Keep the confirm step closed; the API's reason is shown inline next to the product.
        setConfirming(null);
        setResult({ id: product.id, ok: false, text: r.message });
      }
    } catch {
      setResult({ id: product.id, ok: false, text: 'The request did not complete. Reload to check the current state.' });
    } finally {
      lock.current = false;
      setWorking(false);
    }
  }

  const note = 'Only an owner can publish or unpublish. You are signed in as STAFF.';
  return (
    <>
      {!isOwner && <p className="msg msg-info" id="products-role-note" role="status">{note}</p>}
      <div aria-live="polite" role="status" className="sr-only">{result?.ok ? result.text : ''}</div>
      {items.length === 0 ? <p className="empty" role="status">No products.</p> : (
        <div className="table-wrap" role="region" aria-label="Products" tabIndex={0}>
          <table className="data">
            <caption className="sr-only">Products with publish state and COA coverage</caption>
            <thead>
              <tr>
                <th scope="col">Product</th><th scope="col">SKU</th><th scope="col" className="num">Price</th><th scope="col" className="num">Stock</th>
                <th scope="col">State</th><th scope="col" className="num">Lots</th><th scope="col" className="num">Lots with a published COA</th><th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => {
                const isConfirming = confirming === p.id;
                const message = result && result.id === p.id ? result : null;
                return (
                  <ProductRows key={p.id} p={p} isOwner={isOwner} confirming={isConfirming} working={working} message={message}
                    onAsk={() => { setResult(null); setConfirming(p.id); }} onCancel={() => setConfirming(null)} onConfirm={() => apply(p, !p.active)} />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function ProductRows({ p, isOwner, confirming, working, message, onAsk, onCancel, onConfirm }: {
  p: AdminProduct; isOwner: boolean; confirming: boolean; working: boolean; message: { ok: boolean; text: string } | null;
  onAsk: () => void; onCancel: () => void; onConfirm: () => void;
}) {
  const verb = p.active ? 'Unpublish' : 'Publish';
  return (
    <>
      <tr data-product={p.sku}>
        <td><strong>{p.name}</strong></td>
        <td className="mono">{p.sku}</td>
        <td className="num">{formatMoney(p.priceCents, 'USD')}</td>
        <td className="num">{p.inventory}</td>
        <td><span className={`chip ${p.active ? 'chip-coa-published' : 'chip-coa-none'}`}>{p.active ? 'Active' : 'Inactive'}</span></td>
        <td className="num">{p.lotCount}</td>
        <td className="num">{p.publishedCoaLotCount}</td>
        <td>
          {confirming ? (
            <span className="btn-inline">
              <button type="button" className={p.active ? 'btn-danger' : 'btn-primary'} disabled={working} onClick={onConfirm}>{working ? 'Working...' : `Confirm: ${verb.toLowerCase()} ${p.name}`}</button>
              <button type="button" className="btn" disabled={working} onClick={onCancel}>Cancel</button>
            </span>
          ) : (
            <button type="button" className="btn" disabled={!isOwner || working} aria-describedby={isOwner ? undefined : 'products-role-note'} aria-label={`${verb} ${p.name}`} onClick={onAsk}>{verb}</button>
          )}
        </td>
      </tr>
      {confirming && (
        <tr className="row-note"><td colSpan={8}>
          <p className="hint" style={{ margin: 0 }}>
            {p.active ? 'Unpublishing makes the product inactive: it leaves the storefront catalogue.' : 'Publishing makes the product active in the storefront catalogue.'}
            {!p.active && p.publishedCoaLotCount === 0 && ' This product has no lot with a published COA; the API may refuse.'}
          </p>
        </td></tr>
      )}
      {message && (
        <tr className="row-note"><td colSpan={8}>
          <p className={`msg ${message.ok ? 'msg-ok' : 'msg-error'}`} role={message.ok ? 'status' : 'alert'} style={{ margin: 0 }}><strong>{message.ok ? 'Done: ' : 'Not done: '}</strong>{message.text}</p>
        </td></tr>
      )}
    </>
  );
}
