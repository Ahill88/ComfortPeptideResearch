'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createLot, loadMoreLots } from '../../app/actions/coa';
import { LOT_CODE, LOT_CODE_HINT } from '../../lib/coa';
import type { AdminLotSummary, AdminProduct } from '../../lib/types';
import { dateLabel } from '../console/format';
import { AnchorChip, CoaChip } from './chips';

function NewLot({ products }: { products: AdminProduct[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [productId, setProductId] = useState('');
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<{ productId?: string; code?: string; form?: string }>({});
  const [pending, setPending] = useState(false);
  const lock = useRef(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (lock.current) return;
    const trimmed = code.trim();
    const next: typeof errors = {};
    if (!productId) next.productId = 'Choose a product.';
    if (!trimmed) next.code = 'Enter the lot code.';
    else if (!LOT_CODE.test(trimmed)) next.code = `Lot code is not valid. ${LOT_CODE_HINT}`;
    setErrors(next);
    if (Object.keys(next).length) return;
    lock.current = true;
    setPending(true);
    try {
      const result = await createLot({ productId, code: trimmed });
      if (result.ok) { router.push(`/lots/${encodeURIComponent(result.lot.id)}`); return; }
      setErrors(result.field ? { [result.field]: result.message } : { form: result.message });
    } catch {
      setErrors({ form: 'The request did not complete. Check the register before trying again.' });
    } finally {
      lock.current = false;
      setPending(false);
    }
  }

  if (!open) {
    return <button type="button" className="btn-primary" onClick={() => setOpen(true)} disabled={products.length === 0}>New lot</button>;
  }
  return (
    <form className="panel" onSubmit={submit} noValidate aria-label="New lot" style={{ marginBottom: 14 }}>
      <h2>New lot</h2>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="new-lot-product">Product</label>
          <select id="new-lot-product" value={productId} onChange={(e) => { setProductId(e.target.value); setErrors((v) => ({ ...v, productId: undefined })); }} aria-invalid={Boolean(errors.productId)} aria-describedby={errors.productId ? 'new-lot-product-err' : undefined} required>
            <option value="">Select product</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}
          </select>
          {errors.productId && <span id="new-lot-product-err" className="field-error">{errors.productId}</span>}
        </div>
        <div className="field">
          <label htmlFor="new-lot-code">Lot code</label>
          <input id="new-lot-code" type="text" value={code} onChange={(e) => { setCode(e.target.value); setErrors((v) => ({ ...v, code: undefined })); }} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={63} aria-invalid={Boolean(errors.code)} aria-describedby={errors.code ? 'new-lot-code-err' : 'new-lot-code-hint'} required />
          {errors.code ? <span id="new-lot-code-err" className="field-error" role="alert">{errors.code}</span> : <span id="new-lot-code-hint" className="hint">{LOT_CODE_HINT}</span>}
        </div>
      </div>
      {errors.form && <p className="msg msg-error" role="alert">{errors.form}</p>}
      <div className="btn-row" style={{ marginTop: 0 }}>
        <button type="submit" className="btn-primary" disabled={pending}>{pending ? 'Creating...' : 'Create lot'}</button>
        <button type="button" className="btn" disabled={pending} onClick={() => { setOpen(false); setErrors({}); }}>Cancel</button>
      </div>
    </form>
  );
}

export function LotRegister({
  products, productId, q, initialItems, nextCursor,
}: {
  products: AdminProduct[]; productId: string; q: string; initialItems: AdminLotSummary[]; nextCursor: string | null;
}) {
  const router = useRouter();
  const [extra, setExtra] = useState<AdminLotSummary[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const effectiveCursor = cursor === undefined ? nextCursor : cursor;
  const items = useMemo(() => {
    const seen = new Set(initialItems.map((l) => l.id));
    return [...initialItems, ...extra.filter((l) => !seen.has(l.id))];
  }, [initialItems, extra]);
  const filtered = Boolean(productId || q);

  async function more() {
    if (!effectiveCursor || busy.current) return;
    busy.current = true;
    setLoading(true);
    setError('');
    const result = await loadMoreLots({ productId, q, cursor: effectiveCursor });
    if (result.ok) { setExtra((c) => [...c, ...result.items]); setCursor(result.nextCursor); } else setError(result.message);
    setLoading(false);
    busy.current = false;
  }

  return (
    <>
      <NewLot products={products} />
      <form className="filters" action="/lots" method="get" role="search" aria-label="Filter lots">
        <div className="field">
          <label htmlFor="lot-product">Product</label>
          <select id="lot-product" name="productId" defaultValue={productId}>
            <option value="">All products</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="field" style={{ minWidth: 240 }}>
          <label htmlFor="lot-q">Lot code</label>
          <input id="lot-q" name="q" type="search" defaultValue={q} maxLength={100} autoComplete="off" spellCheck={false} />
        </div>
        <button type="submit" className="btn-primary">Apply</button>
        {filtered && <Link className="btn" href="/lots">Clear</Link>}
        <button type="button" className="btn" onClick={() => router.refresh()}>Refresh</button>
      </form>

      <p className="refresh" role="status" style={{ marginBottom: 6 }}>{items.length} shown{effectiveCursor ? ' (more available)' : ''}</p>
      {items.length === 0 ? (
        <p className="empty" role="status">{filtered ? 'No lots match these filters.' : 'No lots yet. Use New lot to register the first one.'}</p>
      ) : (
        <div className="table-wrap" role="region" aria-label="Lots" tabIndex={0}>
          <table className="data rows">
            <caption className="sr-only">Lots. Select a lot code to open it.</caption>
            <thead>
              <tr>
                <th scope="col">Lot code</th><th scope="col">Product</th><th scope="col" className="num">Current COA</th>
                <th scope="col">COA status</th><th scope="col">Anchor</th><th scope="col">Released</th>
              </tr>
            </thead>
            <tbody>
              {items.map((lot) => (
                <tr key={lot.id}>
                  <td><Link className="row-link" href={`/lots/${encodeURIComponent(lot.id)}`} aria-label={`Open lot ${lot.code}`}>{lot.code}</Link></td>
                  <td>{lot.productName} <span className="muted mono">{lot.productSku}</span></td>
                  <td className="num">{lot.currentCoaVersion === null ? <span className="muted">-</span> : `v${lot.currentCoaVersion}`}</td>
                  <td><CoaChip status={lot.coaStatus} /></td>
                  <td><AnchorChip status={lot.anchorStatus} /></td>
                  <td className="nowrap">{dateLabel(lot.releasedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="loadmore">
        {error && <p className="msg msg-error" role="alert">{error}</p>}
        {effectiveCursor ? (
          <button type="button" className="btn btn-lg" onClick={more} disabled={loading}>{loading ? 'Loading...' : 'Load more'}</button>
        ) : items.length > 0 ? <p className="hint">End of list.</p> : null}
      </div>
    </>
  );
}
