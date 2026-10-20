import { fetchWalletAdmin } from '../../components/wallets/api';
import { cursorParam, formatDateTime, type SearchParams } from '../../components/wallets/format';
import { requireAdminSession } from '../../components/wallets/gate';
import type { DirectoryRow, Page } from '../../components/wallets/types';
import { ApiErrorState, DataTable, Mono, Pager, WalletsShell } from '../../components/wallets/ui';

export const dynamic = 'force-dynamic';

export default async function WalletDirectoryPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireAdminSession();
  const cursor = cursorParam(await searchParams);
  const result = await fetchWalletAdmin<Page<DirectoryRow>>('directory', { cursor });

  return (
    <WalletsShell active="directory">
      {!result.ok ? (
        <ApiErrorState result={result} />
      ) : (
        <>
          <DataTable
            caption="Customer wallets, newest first"
            rows={result.data.items}
            getKey={(row) => row.id}
            empty="No customer wallets have been created yet."
            columns={[
              { header: 'Customer email', cell: (row) => row.email },
              { header: 'Wallet address', cell: (row) => <Mono>{row.address}</Mono> },
              { header: 'Provider', cell: (row) => row.provider },
              { header: 'Network', cell: (row) => row.network },
              { header: 'Created', cell: (row) => formatDateTime(row.createdAt) },
            ]}
          />
          <Pager base="/wallets" current={cursor} next={result.data.nextCursor} label="Wallet directory" />
        </>
      )}
    </WalletsShell>
  );
}
