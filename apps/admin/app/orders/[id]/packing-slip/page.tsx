import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PrintButton } from '../../../../components/orders/print-button';
import { shortId, statusLabel } from '../../../../components/console/format';
import { callApi } from '../../../../lib/server/api';
import { ORDER_ID } from '../../../../lib/queue';
import { expireOnUnauthorized, requireSession } from '../../../../lib/server/session';
import type { AdminOrderDetail } from '../../../../lib/types';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Packing slip - Helix & Field Operations' };

// Fixed locale + UTC so the slip's date is identical on every machine and in print.
function slipDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '-' : `${d.toISOString().slice(0, 10)} (UTC)`;
}

export default async function PackingSlip({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  if (!ORDER_ID.test(id)) notFound();
  const result = await callApi<AdminOrderDetail>(`/admin/orders/${encodeURIComponent(id)}`);
  expireOnUnauthorized(result);
  if (!result.ok && result.kind === 'not-found') notFound();

  if (!result.ok) {
    return (
      <main className="slip-page">
        <div className="panel panel-error" role="alert"><h1>Packing slip unavailable</h1><p>{result.message}</p><p><Link className="btn" href={`/orders/${encodeURIComponent(id)}`}>Back to order</Link></p></div>
      </main>
    );
  }
  const order = result.data;
  const address = order.shippingAddress?.trim() || null;
  const units = order.items.reduce((sum, item) => sum + item.quantity, 0);
  const packable = order.status === 'PAID' || order.status === 'PROCESSING';

  return (
    <main className="slip-page">
      <div className="slip-toolbar no-print">
        <Link className="btn" href={`/orders/${encodeURIComponent(order.id)}`}>&larr; Back to order</Link>
        <PrintButton />
      </div>
      {!packable && (
        <p className="msg msg-warn no-print" role="status">This order is {statusLabel(order.status).toLowerCase()}. Check before packing it.</p>
      )}
      <article className="slip" aria-label="Packing slip">
        <header className="slip-head">
          <div>
            <p className="slip-kicker">Helix &amp; Field</p>
            <h1>Packing slip</h1>
          </div>
          <dl className="slip-meta">
            <dt>Order</dt><dd className="mono slip-big">{shortId(order.id)}</dd>
            <dt>Order ID</dt><dd className="mono">{order.id}</dd>
            <dt>Date</dt><dd>{slipDate(order.createdAt)}</dd>
          </dl>
        </header>

        <section aria-labelledby="slip-ship-to">
          <h2 id="slip-ship-to">Ship to</h2>
          {address ? <p className="slip-address">{address}</p> : <p className="slip-address">No shipping address on file.</p>}
        </section>

        <section aria-labelledby="slip-items">
          <h2 id="slip-items">Items to pick</h2>
          <table className="slip-table">
            <thead>
              <tr><th scope="col" className="slip-check">Picked</th><th scope="col">SKU</th><th scope="col">Product</th><th scope="col">Lot</th><th scope="col" className="slip-qty">Qty</th></tr>
            </thead>
            <tbody>
              {order.items.map((item) => (
                <tr key={item.id}>
                  <td className="slip-check"><span className="box" aria-hidden="true" /><span className="sr-only">Unchecked</span></td>
                  <td className="mono">{item.sku}</td>
                  <td>{item.name}</td>
                  <td className="mono slip-lot">{item.lotCode ?? '\u2014'}</td>
                  <td className="slip-qty">{item.quantity}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><td colSpan={4}>Total units</td><td className="slip-qty">{units}</td></tr>
            </tfoot>
          </table>
        </section>
      </article>
    </main>
  );
}
