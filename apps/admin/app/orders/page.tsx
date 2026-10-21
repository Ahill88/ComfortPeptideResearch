import Link from 'next/link';
import { Shell } from '../../components/console/shell';
import { QueueTable } from '../../components/orders/queue-table';
import { QueueSearch } from '../../components/orders/queue-search';
import { callApi } from '../../lib/server/api';
import { expireOnUnauthorized, requireSession } from '../../lib/server/session';
import { DEFAULT_TAB, QUEUE_TABS, queueQuery, tabCount } from '../../lib/queue';
import type { AdminOrderSummary, OrderCounts } from '../../lib/types';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Fulfilment queue - Helix & Field Operations' };

function pick(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

function href(tab: string, q: string): string {
  const p = new URLSearchParams();
  if (tab !== DEFAULT_TAB) p.set('tab', tab);
  if (q) p.set('q', q);
  const s = p.toString();
  return s ? `/orders?${s}` : '/orders';
}

export default async function Orders({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const auth = await requireSession();
  const params = await searchParams;
  const requested = pick(params.tab);
  const tab = QUEUE_TABS.find((t) => t.slug === requested) ?? QUEUE_TABS[0];
  const q = pick(params.q).trim().slice(0, 100);

  const [countsResult, listResult] = await Promise.all([
    callApi<{ counts: OrderCounts }>('/admin/orders/counts'),
    callApi<{ items: AdminOrderSummary[]; nextCursor: string | null }>('/admin/orders', { query: queueQuery(tab.slug, q) }),
  ]);
  expireOnUnauthorized(countsResult);
  expireOnUnauthorized(listResult);
  const counts = countsResult.ok ? countsResult.data.counts : null;

  return (
    <Shell auth={auth} active="orders">
      <div className="page-head">
        <div>
          <h1>Fulfilment queue</h1>
          <p>Newest orders first.</p>
        </div>
      </div>

      <nav className="tabs" aria-label="Order queues">
        {QUEUE_TABS.map((t) => {
          const count = tabCount(t.slug, counts);
          return (
            <Link key={t.slug} className="tab" href={href(t.slug, q)} aria-current={t.slug === tab.slug ? 'page' : undefined}>
              {t.label}
              <span className="count" aria-label={count === null ? 'count unavailable' : `${count} orders`}>{count ?? '-'}</span>
            </Link>
          );
        })}
      </nav>

      <QueueSearch tab={tab.slug} q={q} defaultTab={DEFAULT_TAB} />

      {!countsResult.ok && <p className="msg msg-warn" role="status">Tab counts are unavailable: {countsResult.message}</p>}
      {q && tab.slug !== 'all' && (
        <p className="hint" style={{ marginBottom: 10 }}>
          Searching &quot;{q}&quot; in {tab.label} only. <Link href={href('all', q)}>Search all orders</Link>
        </p>
      )}

      {!listResult.ok ? (
        <p className="msg msg-error" role="alert">The queue could not be loaded: {listResult.message}</p>
      ) : (
        <QueueTable
          key={`${tab.slug}|${q}`}
          tab={tab.slug}
          q={q}
          tabLabel={tab.label}
          emptyText={q ? `No ${tab.slug === 'all' ? '' : `${tab.label.toLowerCase()} `}orders match "${q}".` : tab.empty}
          initialItems={listResult.data.items}
          nextCursor={listResult.data.nextCursor ?? null}
        />
      )}
    </Shell>
  );
}
