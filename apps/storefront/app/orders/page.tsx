import type { Metadata } from 'next';
import { CustomerOrdersPage } from '../../components/orders/orders-list';

export const metadata: Metadata = { title: 'Your orders | Helix & Field', robots: { index: false, follow: false } };

export default function Orders() {
  return <CustomerOrdersPage />;
}
