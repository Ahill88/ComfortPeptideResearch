import Link from 'next/link';
import { Shell } from '../components/console/shell';
import { LocalTime } from '../components/console/local-time';
import { callApi } from '../lib/server/api';
import { expireOnUnauthorized, requireSession } from '../lib/server/session';
import type { OrderCounts } from '../lib/types';

export const dynamic = 'force-dynamic';

export default async function Overview() {
  const auth = await requireSession();
  const counts = await callApi<{ counts: OrderCounts }>('/admin/orders/counts');
  expireOnUnauthorized(counts);
  const c = counts.ok ? counts.data.counts : null;
  const cards: Array<{ label: string; value: number | undefined; href: string }> = [
    { label: 'To pack', value: c?.PAID, href: '/orders?tab=to-pack' },
    { label: 'Packing', value: c?.PROCESSING, href: '/orders?tab=packing' },
    { label: 'Shipped', value: c?.SHIPPED, href: '/orders?tab=shipped' },
    { label: 'Awaiting payment', value: c?.PENDING_PAYMENT, href: '/orders?tab=awaiting-payment' },
  ];

  return (
    <Shell auth={auth} active="overview">
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p>Signed in as {auth.admin.name} ({auth.admin.role}). Session expires <LocalTime iso={auth.session.expiresAt} />; idle timeout {Math.round(auth.session.idleTimeoutSeconds / 60)} min.</p>
        </div>
      </div>

      {!counts.ok && <p className="msg msg-error" role="alert">Order counts are unavailable: {counts.message}</p>}
      <section className="cards" aria-label="Order counts">
        {cards.map((card) => (
          <Link className="card" href={card.href} key={card.label}>
            <span className="label">{card.label}</span>
            <span className="value">{card.value ?? '-'}</span>
            <span className="go">Open queue</span>
          </Link>
        ))}
      </section>

      <h2>Go to</h2>
      <ul className="link-list">
        <li><Link href="/orders">Fulfilment queue</Link></li>
        <li><Link href="/lots">Lots &amp; COAs</Link></li>
        <li><Link href="/products">Products</Link></li>
        <li><Link href="/inventory">Inventory</Link></li>
        <li><Link href="/compliance">Compliance</Link></li>
        {auth.admin.role === 'OWNER' && <li><Link href="/email">Email outbox</Link></li>}
        <li><Link href="/wallets">Wallet reporting</Link></li>
        {auth.admin.role === 'OWNER' && <li><Link href="/team">Team</Link></li>}
        {auth.admin.role === 'OWNER' && <li><Link href="/audit">Audit log</Link></li>}
        <li><Link href="/account/password">Change password</Link></li>
      </ul>
    </Shell>
  );
}
