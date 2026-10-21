import { notFound } from 'next/navigation';
import { Shell } from '../../../components/console/shell';
import { OrderDetail } from '../../../components/orders/order-detail';
import { callApi } from '../../../lib/server/api';
import { expireOnUnauthorized, requireSession } from '../../../lib/server/session';
import { ORDER_ID } from '../../../lib/queue';
import type { AdminOrderDetail } from '../../../lib/types';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Order - Helix & Field Operations' };

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSession();
  const { id } = await params;
  if (!ORDER_ID.test(id)) notFound();
  const result = await callApi<AdminOrderDetail>(`/admin/orders/${encodeURIComponent(id)}`);
  expireOnUnauthorized(result);
  if (!result.ok && result.kind === 'not-found') notFound();

  return (
    <Shell auth={auth} active="orders">
      {result.ok ? (
        <OrderDetail initial={result.data} />
      ) : (
        <div className="panel panel-error" role="alert">
          <h1>Order unavailable</h1>
          <p>{result.message}</p>
          <p><a className="btn" href={`/orders/${encodeURIComponent(id)}`}>Retry</a> <a className="btn" href="/orders">Back to queue</a></p>
        </div>
      )}
    </Shell>
  );
}
