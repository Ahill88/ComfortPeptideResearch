import type { AdminOrderSummary } from '../../lib/types';
import { formatMoney } from '../console/format';

export function OrderTotals({ order, compact = false }: { order: AdminOrderSummary; compact?: boolean }) {
  const money = (n: number) => formatMoney(n, order.currency);
  // Older orders have no stored breakdown. Do not reconstruct one from current prices or assume shipping/tax were zero.
  const legacy = order.subtotalCents == null;
  if (compact) return <div className="queue-totals"><strong>{money(order.totalCents)}</strong>{legacy ? <small>Legacy: total only</small> : <small>Subtotal {money(order.subtotalCents!)}<br />Shipping {money(order.shippingCents)}<br />Tax {money(order.taxCents)}</small>}</div>;
  return <section className="panel" aria-labelledby="totals-h"><h2 id="totals-h">Order totals</h2><dl className="dl">
    {!legacy && <><dt>Subtotal</dt><dd>{money(order.subtotalCents!)}</dd><dt>Shipping</dt><dd>{money(order.shippingCents)}</dd><dt>Tax</dt><dd>{money(order.taxCents)}</dd></>}
    <dt>Total</dt><dd><strong>{money(order.totalCents)}</strong></dd>
  </dl>{legacy && <p className="hint">Legacy order: only the recorded total is available. No subtotal, shipping or tax breakdown was stored.</p>}</section>;
}
