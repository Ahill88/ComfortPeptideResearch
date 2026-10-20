import { fetchWalletAdmin } from '../../../components/wallets/api';
import { cursorParam, formatDateTime, type SearchParams } from '../../../components/wallets/format';
import { requireAdminSession } from '../../../components/wallets/gate';
import type { Page, TransactionRow } from '../../../components/wallets/types';
import { ApiErrorState, DataTable, Mono, Pager, StatusBadge, WalletsShell } from '../../../components/wallets/ui';

export const dynamic = 'force-dynamic';

export default async function FailedTransactionsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireAdminSession();
  const cursor = cursorParam(await searchParams);
  const result = await fetchWalletAdmin<Page<TransactionRow>>('failed', { cursor });

  return (
    <WalletsShell active="failed">
      {!result.ok ? (
        <ApiErrorState result={result} />
      ) : (
        <>
          <DataTable<TransactionRow>
            caption="Failed and expired transactions, newest first"
            rows={result.data.items}
            getKey={(row) => row.id}
            empty="No failed or expired transactions."
            columns={[
              { header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
              { header: 'Failure reason', cell: (row) => row.failureReason ?? 'Not recorded' },
              { header: 'Type', cell: (row) => row.type },
              { header: 'USDC (exact)', numeric: true, cell: (row) => row.usdcExact },
              { header: 'Order', cell: (row) => <Mono>{row.orderId ?? '-'}</Mono> },
              { header: 'Signature', cell: (row) => <Mono>{row.txSignature ?? '-'}</Mono> },
              { header: 'Reference', cell: (row) => <Mono>{row.reference}</Mono> },
              { header: 'Created', cell: (row) => formatDateTime(row.createdAt) },
            ]}
          />
          <Pager base="/wallets/failed" current={cursor} next={result.data.nextCursor} label="Failed transactions" />
        </>
      )}
    </WalletsShell>
  );
}
