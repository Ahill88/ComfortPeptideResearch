'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { loadMoreOrders } from '../../app/actions/orders';
import type { AdminOrderSummary } from '../../lib/types';
import { formatMoney, shortId } from '../console/format';
import { LocalTime } from '../console/local-time';
import { StatusChip } from '../console/status-chip';

const REFRESH_MS = 30_000;

export function QueueTable({
  tab, q, tabLabel, emptyText, initialItems, nextCursor,
}: {
  tab: string; q: string; tabLabel: string; emptyText: string; initialItems: AdminOrderSummary[]; nextCursor: string | null;
}) {
  const router = useRouter();
  const [extra, setExtra] = useState<AdminOrderSummary[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined); // undefined: still on the server-rendered page
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [updated, setUpdated] = useState<Date | null>(null);
  const busy = useRef(false);

  const effectiveCursor = cursor === undefined ? nextCursor : cursor;
  const items = useMemo(() => {
    const seen = new Set(initialItems.map((o) => o.id));
    return [...initialItems, ...extra.filter((o) => !seen.has(o.id))];
  }, [initialItems, extra]);

  // "Live" counts and rows: re-render the server component every 30s while the tab is visible.
  useEffect(() => {
    setUpdated(new Date());
  }, [initialItems]);
  const refresh = useCallback(() => router.refresh(), [router]);
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  async function more() {
    if (!effectiveCursor || busy.current) return;
    busy.current = true;
    setLoading(true);
    setError('');
    const result = await loadMoreOrders({ tab, q, cursor: effectiveCursor });
    if (result.ok) {
      setExtra((current) => [...current, ...result.items]);
      setCursor(result.nextCursor);
    } else {
      setError(result.message);
    }
    setLoading(false);
    busy.current = false;
  }

  return (
    <>
      <div className="toolbar" style={{ marginBottom: 6 }}>
        <p className="refresh" role="status">
          {items.length} shown{effectiveCursor ? ' (more available)' : ''}
          {updated && <> &middot; updated <time dateTime={updated.toISOString()}>{updated.toLocaleTimeString()}</time></>}
        </p>
        <button type="button" className="btn" onClick={refresh}>Refresh</button>
      </div>
      {items.length === 0 ? (
        <p className="empty" role="status">{emptyText}</p>
      ) : (
        <div className="table-wrap" role="region" aria-label={`${tabLabel} orders`}>
          <table className="data rows">
            <caption className="sr-only">{tabLabel} orders, newest first. Select an order ID to open it.</caption>
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">Placed</th>
                <th scope="col">Customer</th>
                <th scope="col" className="num">Items</th>
                <th scope="col" className="num">Total</th>
                <th scope="col">Status</th>
                <th scope="col">Tracking</th>
              </tr>
            </thead>
            <tbody>
              {items.map((order) => (
                <tr key={order.id}>
                  <td><Link className="row-link" href={`/orders/${encodeURIComponent(order.id)}`} aria-label={`Open order ${shortId(order.id)}`}>{shortId(order.id)}</Link></td>
                  <td className="nowrap"><LocalTime iso={order.createdAt} /></td>
                  <td title={order.customer.name ?? undefined} style={{ overflowWrap: 'anywhere' }}>{order.customer.email}</td>
                  <td className="num">{order.itemCount}</td>
                  <td className="num nowrap">{formatMoney(order.totalCents, order.currency)}</td>
                  <td><StatusChip status={order.status} /></td>
                  <td className="mono">{order.trackingNumber ?? '-'}</td>
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
        ) : items.length > 0 ? (
          <p className="hint">End of list.</p>
        ) : null}
      </div>
    </>
  );
}
