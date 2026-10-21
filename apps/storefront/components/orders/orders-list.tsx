'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { ArrowRight, Package } from 'lucide-react';
import { fetchCustomerOrders } from '../../lib/orders/customer-orders-api';
import { formatOrderDate, formatOrderMoney, isTerminalOrder, type CustomerOrderPage } from '../../lib/orders/customer-orders';
import { useCustomerOrders } from './use-customer-orders';
import { OrderRefresh, OrderStatusBadge, OrdersError, OrdersLayout, OrdersLoading, OrdersSession, OrdersSignIn, orderButtonClass, orderPanelClass } from './order-ui';

const needsRefresh = (page: CustomerOrderPage) => page.items.some((order) => !isTerminalOrder(order.status));

export function CustomerOrdersPage() {
  return <OrdersLayout><OrdersSession><OrdersList /></OrdersSession></OrdersLayout>;
}

function OrdersList() {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [page, setPage] = useState(0);
  const nextPage = (cursor: string) => {
    document.getElementById('customer-orders-title')?.focus();
    setCursors((current) => [...current.slice(0, page + 1), cursor]);
    setPage(page + 1);
  };
  const previousPage = () => {
    document.getElementById('customer-orders-title')?.focus();
    setPage(page - 1);
  };
  return <OrdersListPage key={`${page}:${cursors[page]}`} cursor={cursors[page]} page={page} nextPage={nextPage} previousPage={previousPage} />;
}

function OrdersListPage({ cursor, page, nextPage, previousPage }: { cursor: string | null; page: number; nextPage: (cursor: string) => void; previousPage: () => void }) {
  const load = useCallback((signal: AbortSignal) => fetchCustomerOrders(cursor, signal), [cursor]);
  const resource = useCustomerOrders(load, needsRefresh);
  if (resource.phase === 'signed-out') return <OrdersSignIn />;
  if (resource.phase === 'loading') return <OrdersLoading />;
  if (!resource.data) return <><OrdersError retry={resource.refresh} />{page > 0 && <button type="button" className={`${orderButtonClass} mt-5`} onClick={previousPage}>Previous page</button>}</>;
  const orders = resource.data;
  return <>
    <OrderRefresh refreshing={resource.refreshing} failed={resource.refreshFailed} automatic={needsRefresh(orders)} refresh={resource.refresh} />
    <p className="mb-4 text-sm text-slate-600" role="status" aria-live="polite">Page {page + 1} · {orders.items.length} {orders.items.length === 1 ? 'order' : 'orders'}{orders.items.length ? ' · Newest first' : ''}</p>
    {orders.items.length === 0 ? <section className={orderPanelClass}><Package aria-hidden="true" size={24} className="text-blue" /><h2 className="mt-4 text-2xl tracking-tight">{page === 0 ? 'No orders yet' : 'No more orders'}</h2><p className="mt-3 text-sm leading-6 text-slate-600">{page === 0 ? 'Orders placed with your account will appear here.' : 'There are no orders on this page. Return to the previous page to review your history.'}</p>{page === 0 && <Link href="/catalog" className={`${orderButtonClass} mt-5`}>Explore the catalog</Link>}</section>
      : <ul className="space-y-4" aria-label="Your orders">{orders.items.map((order) => <li key={order.id} className={orderPanelClass}>
        <article aria-labelledby={`order-${order.id}`}>
          <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h2 id={`order-${order.id}`} className="break-all font-mono text-sm font-medium">Order {order.id}</h2><p className="mt-2 text-sm text-slate-600">Placed <time dateTime={order.createdAt}>{formatOrderDate(order.createdAt)}</time> <span className="text-xs">(UTC)</span></p></div><OrderStatusBadge status={order.status} /></div>
          <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-silver pt-5"><div><dt className="text-xs text-slate-600">Items</dt><dd className="mt-1 text-sm">{order.itemCount} {order.itemCount === 1 ? 'item' : 'items'}</dd></div><div><dt className="text-xs text-slate-600">Total · {order.currency}</dt><dd className="mt-1 text-lg font-medium tabular-nums">{formatOrderMoney(order.totalCents, order.currency)}</dd></div></dl>
          {order.trackingNumber && <p className="mt-4 break-words text-sm leading-6 text-slate-600 [overflow-wrap:anywhere]">{order.carrier ? `${order.carrier} tracking: ` : 'Tracking: '}<span className="font-mono text-xs text-midnight">{order.trackingNumber}</span></p>}
          <Link href={`/orders/${order.id}`} className={`${orderButtonClass} mt-5`} aria-label={`View order ${order.id}`}>View order<ArrowRight aria-hidden="true" size={16} /></Link>
        </article>
      </li>)}</ul>}
    {(page > 0 || orders.nextCursor) && <nav aria-label="Order history pages" className="mt-6 flex flex-wrap items-center justify-between gap-3">
      {page > 0 && <button type="button" className={orderButtonClass} onClick={previousPage}>Previous page</button>}
      {orders.nextCursor && <button type="button" className={`${orderButtonClass} ml-auto`} onClick={() => nextPage(orders.nextCursor!)}>Next page<ArrowRight aria-hidden="true" size={16} /></button>}
    </nav>}
  </>;
}
