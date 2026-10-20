import { fetchWalletAdmin } from '../../../components/wallets/api';
import { cursorParam, formatDateTime, formatUsdCents, type SearchParams } from '../../../components/wallets/format';
import { requireAdminSession } from '../../../components/wallets/gate';
import type { Page, PendingOrderRow } from '../../../components/wallets/types';
import { ApiErrorState, DataTable, Mono, Pager, StatusBadge, WalletsShell } from '../../../components/wallets/ui';

export const dynamic = 'force-dynamic';

export default async function PendingOrdersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireAdminSession();
  const cursor = cursorParam(await searchParams);
  const result = await fetchWalletAdmin<Page<PendingOrderRow>>('pending-orders', { cursor });

  return (
    <WalletsShell active="pending-orders">
      {!result.ok ? (
        <ApiErrorState result={result} />
      ) : (
        <>
          <DataTable<PendingOrderRow>
            caption="Orders awaiting payment, newest first"
            rows={result.data.items}
            getKey={(row) => row.id}
            empty="No orders are awaiting payment."
            columns={[
              { header: 'Order', cell: (row) => <Mono>{row.id}</Mono> },
              { header: 'Customer email', cell: (row) => row.email },
              { header: 'Total', numeric: true, cell: (row) => formatUsdCents(row.totalCents, row.currency) },
              { header: 'Payment', cell: (row) => (row.payment ? <StatusBadge status={row.payment.status} /> : 'None') },
              { header: 'Payment expires', cell: (row) => formatDateTime(row.payment?.expiresAt) },
              { header: 'Credit reservation', cell: (row) => (row.creditReservation ? <StatusBadge status={row.creditReservation.status} /> : 'None') },
              { header: 'Created', cell: (row) => formatDateTime(row.createdAt) },
            ]}
          />
          <Pager base="/wallets/pending-orders" current={cursor} next={result.data.nextCursor} label="Pending orders" />
        </>
      )}
    </WalletsShell>
  );
}
