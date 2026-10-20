import { fetchWalletAdmin } from '../../../components/wallets/api';
import { cursorParam, enumParam, formatDateTime, type SearchParams } from '../../../components/wallets/format';
import { requireAdminSession } from '../../../components/wallets/gate';
import type { Page, TransactionRow } from '../../../components/wallets/types';
import { ApiErrorState, DataTable, Mono, Pager, StatusBadge, StatusFilter, WalletsShell } from '../../../components/wallets/ui';

export const dynamic = 'force-dynamic';

const STATUSES = ['PREPARED', 'SUBMITTED', 'CONFIRMED', 'FINALIZED', 'FAILED', 'EXPIRED'] as const;

export default async function VerificationPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireAdminSession();
  const params = await searchParams;
  const cursor = cursorParam(params);
  const status = enumParam(params, 'status', STATUSES);
  const result = await fetchWalletAdmin<Page<TransactionRow>>('transactions', { cursor, status });

  return (
    <WalletsShell active="verification">
      <StatusFilter base="/wallets/verification" options={STATUSES} active={status} label="Status" />
      {!result.ok ? (
        <ApiErrorState result={result} />
      ) : (
        <>
          <DataTable<TransactionRow>
            caption="Crypto transactions, newest first"
            rows={result.data.items}
            getKey={(row) => row.id}
            empty="No transactions match this view."
            columns={[
              { header: 'Type', cell: (row) => row.type },
              { header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
              { header: 'USDC (exact)', numeric: true, cell: (row) => row.usdcExact },
              { header: 'Signature', cell: (row) => <Mono>{row.txSignature ?? '-'}</Mono> },
              { header: 'Reference', cell: (row) => <Mono>{row.reference}</Mono> },
              { header: 'Network', cell: (row) => row.network },
              { header: 'Fee (lamports)', numeric: true, cell: (row) => row.feeLamports ?? '-' },
              { header: 'Created', cell: (row) => formatDateTime(row.createdAt) },
              { header: 'Finalized', cell: (row) => formatDateTime(row.finalizedAt) },
            ]}
          />
          <Pager base="/wallets/verification" current={cursor} next={result.data.nextCursor} keep={{ status }} label="On-chain verification" />
        </>
      )}
    </WalletsShell>
  );
}
