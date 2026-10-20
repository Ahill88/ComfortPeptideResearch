import { fetchWalletAdmin } from '../../../components/wallets/api';
import { cursorParam, enumParam, formatDateTime, formatUsdCents, type SearchParams } from '../../../components/wallets/format';
import { requireAdminSession } from '../../../components/wallets/gate';
import type { FundingRow, Page } from '../../../components/wallets/types';
import { ApiErrorState, DataTable, Mono, Pager, StatusBadge, StatusFilter, WalletsShell } from '../../../components/wallets/ui';

export const dynamic = 'force-dynamic';

const STATUSES = ['CREATED', 'PENDING', 'COMPLETED', 'FAILED', 'EXPIRED'] as const;

export default async function FundingActivityPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireAdminSession();
  const params = await searchParams;
  const cursor = cursorParam(params);
  const status = enumParam(params, 'status', STATUSES);
  const result = await fetchWalletAdmin<Page<FundingRow>>('funding', { cursor, status });

  return (
    <WalletsShell active="funding">
      <StatusFilter base="/wallets/funding" options={STATUSES} active={status} label="Status" />
      {!result.ok ? (
        <ApiErrorState result={result} />
      ) : (
        <>
          <DataTable
            caption="On-ramp funding intents, newest first"
            rows={result.data.items}
            getKey={(row) => row.id}
            empty="No funding intents match this view."
            columns={[
              { header: 'Customer email', cell: (row) => row.email },
              { header: 'Provider', cell: (row) => row.provider },
              { header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
              { header: 'Intended amount', numeric: true, cell: (row) => formatUsdCents(row.intendedUsdCents) },
              { header: 'Destination', cell: (row) => <Mono>{row.destinationAddress}</Mono> },
              { header: 'Provider reference', cell: (row) => <Mono>{row.externalReference ?? '-'}</Mono> },
              { header: 'Created', cell: (row) => formatDateTime(row.createdAt) },
              { header: 'Updated', cell: (row) => formatDateTime(row.updatedAt) },
            ]}
          />
          <Pager base="/wallets/funding" current={cursor} next={result.data.nextCursor} keep={{ status }} label="Funding activity" />
        </>
      )}
    </WalletsShell>
  );
}
