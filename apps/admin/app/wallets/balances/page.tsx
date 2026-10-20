import { fetchWalletAdmin } from '../../../components/wallets/api';
import { cursorParam, formatDateTime, type SearchParams } from '../../../components/wallets/format';
import { requireAdminSession } from '../../../components/wallets/gate';
import type { BalanceRow, BalancesResponse } from '../../../components/wallets/types';
import { ApiErrorState, DataTable, Mono, Note, Pager, WalletsShell } from '../../../components/wallets/ui';

export const dynamic = 'force-dynamic';

export default async function CreditBalancesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireAdminSession();
  const cursor = cursorParam(await searchParams);
  const result = await fetchWalletAdmin<BalancesResponse>('balances', { cursor });

  return (
    <WalletsShell active="balances">
      {!result.ok ? (
        <ApiErrorState result={result} />
      ) : (
        <>
          <Note>
            <strong>Display balance observed on chain; not a platform-held balance.</strong> Research Credits are the whole-USDC floor of the latest
            observed snapshot. The platform does not hold, issue, or adjust these funds.
          </Note>
          <DataTable<BalanceRow>
            caption="Latest observed balance snapshot per wallet"
            rows={result.data.items}
            getKey={(row) => row.walletId}
            empty="No wallets to display."
            columns={[
              { header: 'Customer email', cell: (row) => row.email },
              { header: 'Wallet address', cell: (row) => <Mono>{row.address}</Mono> },
              { header: 'USDC (exact)', numeric: true, cell: (row) => row.snapshot?.usdcExact ?? 'No snapshot' },
              { header: 'Research Credits (floor)', numeric: true, cell: (row) => row.snapshot?.researchCreditsFloor ?? '-' },
              { header: 'Observed', cell: (row) => formatDateTime(row.snapshot?.observedAt) },
              { header: 'Slot', numeric: true, cell: (row) => row.snapshot?.slot ?? '-' },
            ]}
          />
          <Pager base="/wallets/balances" current={cursor} next={result.data.nextCursor} label="Credit display balances" />
        </>
      )}
    </WalletsShell>
  );
}
