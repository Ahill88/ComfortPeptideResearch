'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { fetchCustomerOrder } from '../../lib/orders/customer-orders-api';
import { formatOrderDate, formatOrderMoney, isTerminalOrder, orderProductHref, orderStatusLabel, orderTotalRows, type CustomerOrderDetail } from '../../lib/orders/customer-orders';
import { useCustomerOrders } from './use-customer-orders';
import { CopyTracking, OrderNotFound, OrderRefresh, OrderStatusBadge, OrdersError, OrdersLayout, OrdersLoading, OrdersSession, OrdersSignIn, orderButtonClass, orderPanelClass } from './order-ui';

const needsRefresh = (order: CustomerOrderDetail) => !isTerminalOrder(order.status);

export function CustomerOrderDetailPage({ id }: { id: string }) {
  return <OrdersLayout detail><OrdersSession id={id}><OrderDetail key={id} id={id} /></OrdersSession></OrdersLayout>;
}

function OrderDetail({ id }: { id: string }) {
  const load = useCallback((signal: AbortSignal) => fetchCustomerOrder(id, signal), [id]);
  const resource = useCustomerOrders(load, needsRefresh);
  if (resource.phase === 'signed-out') return <OrdersSignIn id={id} />;
  if (resource.phase === 'not-found') return <OrderNotFound />;
  if (resource.phase === 'loading') return <OrdersLoading detail />;
  if (!resource.data) return <OrdersError retry={resource.refresh} />;
  const order = resource.data;
  return <>
    <OrderRefresh refreshing={resource.refreshing} failed={resource.refreshFailed} automatic={needsRefresh(order)} refresh={resource.refresh} />
    <section className={`${orderPanelClass} mb-6`} aria-labelledby="order-number-heading">
      <div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><h2 id="order-number-heading" className="break-all font-mono text-sm font-medium">Order {order.id}</h2><p className="mt-2 text-sm leading-6 text-slate-600">Placed <time dateTime={order.createdAt}>{formatOrderDate(order.createdAt, true)}</time></p></div><OrderStatusBadge status={order.status} /></div>
      {order.status === 'PENDING_PAYMENT' && <p className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">Payment has not been confirmed for this order. Payment cannot be resumed from order history. If you have already submitted a payment, refresh to check its status. For help with this order, <Link href="/contact" className="inline-flex min-h-11 items-center underline underline-offset-4">contact support</Link>.</p>}
    </section>
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-6">
        <section className={orderPanelClass} aria-labelledby="order-items-heading"><h2 id="order-items-heading" className="text-xl tracking-tight">Items</h2>
          {order.items.length === 0 ? <p className="mt-4 text-sm text-slate-600">Item details aren’t available for this order.</p> : <ul className="mt-4 divide-y divide-silver">{order.items.map((item, index) => {
            const href = orderProductHref(item.slug);
            return <li key={`${item.productId}:${item.lotCode}:${index}`} className="py-5 first:pt-0 last:pb-0">
              <h3 className="break-words text-base font-medium [overflow-wrap:anywhere]">{href ? <Link href={href} className="inline-flex min-h-11 items-center gap-2 underline decoration-silver underline-offset-4 hover:decoration-midnight">{item.name}<ArrowUpRight aria-hidden="true" className="shrink-0" size={15} /></Link> : item.name}</h3>
              <p className="mt-2 break-words text-xs leading-5 text-slate-600 [overflow-wrap:anywhere]">Lot <span className="font-mono text-midnight">{item.lotCode}</span></p>
              <dl className="mt-4 flex flex-wrap justify-between gap-x-6 gap-y-3 text-sm"><div><dt className="text-xs text-slate-600">Quantity</dt><dd className="mt-1">{item.quantity}</dd></div><div><dt className="text-xs text-slate-600">Unit price</dt><dd className="mt-1 tabular-nums">{formatOrderMoney(item.unitCents, order.currency)}</dd></div><div><dt className="text-xs text-slate-600">Line total</dt><dd className="mt-1 font-medium tabular-nums">{formatOrderMoney(item.unitCents * item.quantity, order.currency)}</dd></div></dl>
            </li>;
          })}</ul>}
        </section>
        <section className={orderPanelClass} aria-labelledby="order-shipments-heading"><h2 id="order-shipments-heading" className="text-xl tracking-tight">Shipment tracking</h2>
          {order.shipments.length === 0 ? <p className="mt-4 text-sm leading-6 text-slate-600">No shipment details have been recorded for this order.</p> : <ul className="mt-5 space-y-6">{order.shipments.map((shipment, index) => <li key={`${shipment.trackingNumber}:${index}`} className="border-t border-silver pt-5 first:border-0 first:pt-0">
            <h3 className="break-words text-sm font-medium [overflow-wrap:anywhere]">{shipment.carrier}</h3><p className="mt-2 select-text break-all font-mono text-sm">{shipment.trackingNumber}</p>
            <dl className="mt-3 space-y-2 text-xs leading-5 text-slate-600"><div><dt className="inline">Shipped: </dt><dd className="inline"><time dateTime={shipment.shippedAt}>{formatOrderDate(shipment.shippedAt, true)}</time></dd></div>{shipment.deliveredAt && <div><dt className="inline">Delivered: </dt><dd className="inline"><time dateTime={shipment.deliveredAt}>{formatOrderDate(shipment.deliveredAt, true)}</time></dd></div>}</dl>
            <div className="mt-4 flex flex-wrap items-start gap-3"><CopyTracking key={shipment.trackingNumber} number={shipment.trackingNumber} />{shipment.trackingUrl && <a className={orderButtonClass} href={shipment.trackingUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Track shipment<span className="sr-only"> on {shipment.carrier} (opens in a new tab)</span><ArrowUpRight aria-hidden="true" size={15} /></a>}</div>
            {!shipment.trackingUrl && <p className="mt-2 text-xs leading-5 text-slate-600">A carrier link isn’t available. Use the tracking number on your carrier’s website.</p>}
          </li>)}</ul>}
        </section>
        <section className={orderPanelClass} aria-labelledby="order-timeline-heading"><h2 id="order-timeline-heading" className="text-xl tracking-tight">Order updates</h2><p className="mt-2 text-xs leading-5 text-slate-600">Recorded status changes only. Earlier orders may have an incomplete history.</p>
          {order.timeline.length === 0 ? <p className="mt-5 text-sm text-slate-600">No status updates have been recorded.</p> : <ol className="ml-2 mt-6 border-l border-silver">{order.timeline.map((entry, index) => <li key={`${entry.status}:${entry.at}:${index}`} className="relative pb-6 pl-6 last:pb-0"><span aria-hidden="true" className="absolute -left-[5px] top-1.5 h-[9px] w-[9px] rounded-full bg-slate-500" /><p className="text-sm font-medium">{orderStatusLabel(entry.status)}</p><time className="mt-1 block text-xs leading-5 text-slate-600" dateTime={entry.at}>{formatOrderDate(entry.at, true)}</time></li>)}</ol>}
        </section>
      </div>
      <div className="min-w-0 space-y-6">
        <section className={orderPanelClass} aria-labelledby="order-totals-heading"><h2 id="order-totals-heading" className="text-xl tracking-tight">Order total <span className="text-xs text-slate-600">{order.currency}</span></h2><dl className="mt-5 space-y-4">{orderTotalRows(order).map((row) => <div key={row.label} className={`flex flex-wrap justify-between gap-3 text-sm ${row.label === 'Total' ? 'border-t border-silver pt-4 font-semibold' : 'text-slate-600'}`}><dt>{row.label}</dt><dd className="tabular-nums">{formatOrderMoney(row.cents, order.currency)}</dd></div>)}</dl>{order.subtotalCents === null && <p className="mt-4 text-xs leading-5 text-slate-600">A subtotal, shipping and tax breakdown isn’t available for this earlier order. Only the recorded total is shown.</p>}</section>
        <section className={orderPanelClass} aria-labelledby="order-address-heading"><h2 id="order-address-heading" className="text-xl tracking-tight">Shipping address</h2>{order.shippingAddress ? <address className="mt-4 whitespace-pre-line break-words text-sm not-italic leading-7 text-slate-600 [overflow-wrap:anywhere]">{order.shippingAddress}</address> : <p className="mt-4 text-sm leading-6 text-slate-600">A shipping address isn’t available for this order.</p>}</section>
      </div>
    </div>
  </>;
}
