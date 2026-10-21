import type { Metadata } from 'next';
import { CustomerOrderDetailPage } from '../../../components/orders/order-detail';

export const metadata: Metadata = { title: 'Order details | Helix & Field', robots: { index: false, follow: false } };

export default async function OrderTracking({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CustomerOrderDetailPage id={id} />;
}
