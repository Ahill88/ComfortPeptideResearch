import { fetchWalletAdmin } from '../../../components/wallets/api';
import { dayCursorParam, type SearchParams } from '../../../components/wallets/format';
import { requireAdminSession } from '../../../components/wallets/gate';
import type { SettlementDay, SettlementsResponse } from '../../../components/wallets/types';
import { ApiErrorState, DataTable, MetricCards, Pager, WalletsShell } from '../../../components/wallets/ui';

export const dynamic = 'force-dynamic';

export default async function SettlementsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireAdminSession();
  const cursor = dayCursorParam(await searchParams);
  const result = await fetchWalletAdmin<SettlementsResponse>('settlements', { cursor });

  return (
    <WalletsShell active="settlements">
      {!result.ok ? (
        <ApiErrorState result={result} />
      ) : (
        <>
          <MetricCards
            items={[
              { label: 'Finalized purchases (all time)', value: result.data.allTime.count },
              { label: 'Total settled USDC (exact)', value: result.data.allTime.totalUsdcExact, note: `${result.data.allTime.totalAtomic} atomic units` },
            ]}
          />
          <DataTable<SettlementDay>
            caption="Finalized purchase transactions per UTC day"
            rows={result.data.items}
            getKey={(row) => row.day}
            empty="No finalized purchases to report."
            columns={[
              { header: 'Day (UTC)', cell: (row) => row.day },
              { header: 'Transactions', numeric: true, cell: (row) => row.count },
              { header: 'Total USDC (exact)', numeric: true, cell: (row) => row.totalUsdcExact },
              { header: 'Total (atomic)', numeric: true, cell: (row) => row.totalAtomic },
            ]}
          />
          <Pager base="/wallets/settlements" current={cursor} next={result.data.nextCursor} label="Settlement reporting" />
        </>
      )}
    </WalletsShell>
  );
}
