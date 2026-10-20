import { fetchWalletAdmin } from '../../../components/wallets/api';
import { cursorParam, formatDateTime, type SearchParams } from '../../../components/wallets/format';
import { requireAdminSession } from '../../../components/wallets/gate';
import type { PaymentIntentsResponse, PaymentRow, TransactionRow } from '../../../components/wallets/types';
import { ApiErrorState, DataTable, Mono, Pager, SectionTitle, StatusBadge, WalletsShell } from '../../../components/wallets/ui';

export const dynamic = 'force-dynamic';

export default async function PaymentIntentsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireAdminSession();
  const params = await searchParams;
  const paymentsCursor = cursorParam(params, 'paymentsCursor');
  const purchasesCursor = cursorParam(params, 'purchasesCursor');
  const result = await fetchWalletAdmin<PaymentIntentsResponse>('payment-intents', { paymentsCursor, purchasesCursor });

  return (
    <WalletsShell active="payment-intents">
      {!result.ok ? (
        <ApiErrorState result={result} />
      ) : (
        <>
          <SectionTitle>Order payments</SectionTitle>
          <DataTable<PaymentRow>
            caption="Payment rows, newest first"
            rows={result.data.payments.items}
            getKey={(row) => row.id}
            empty="No payment rows yet."
            columns={[
              { header: 'Order', cell: (row) => <Mono>{row.orderId}</Mono> },
              { header: 'Provider', cell: (row) => row.provider },
              { header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
              { header: 'Amount (atomic)', numeric: true, cell: (row) => `${row.amountAtomic} ${row.currency}` },
              { header: 'Customer wallet', cell: (row) => <Mono>{row.walletAddress ?? '-'}</Mono> },
              { header: 'Signature', cell: (row) => <Mono>{row.txSignature ?? '-'}</Mono> },
              { header: 'Expires', cell: (row) => formatDateTime(row.expiresAt) },
              { header: 'Created', cell: (row) => formatDateTime(row.createdAt) },
            ]}
          />
          <Pager base="/wallets/payment-intents" cursorKey="paymentsCursor" current={paymentsCursor} next={result.data.payments.nextCursor} keep={{ purchasesCursor }} label="Order payments" />

          <div style={{ marginTop: 34 }}>
            <SectionTitle>Purchase transactions</SectionTitle>
            <DataTable<TransactionRow>
              caption="PURCHASE crypto transactions, newest first"
              rows={result.data.cryptoPurchases.items}
              getKey={(row) => row.id}
              empty="No purchase transactions yet."
              columns={[
                { header: 'Reference', cell: (row) => <Mono>{row.reference}</Mono> },
                { header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
                { header: 'USDC (exact)', numeric: true, cell: (row) => row.usdcExact },
                { header: 'Order', cell: (row) => <Mono>{row.orderId ?? '-'}</Mono> },
                { header: 'Signature', cell: (row) => <Mono>{row.txSignature ?? '-'}</Mono> },
                { header: 'Network', cell: (row) => row.network },
                { header: 'Created', cell: (row) => formatDateTime(row.createdAt) },
              ]}
            />
            <Pager base="/wallets/payment-intents" cursorKey="purchasesCursor" current={purchasesCursor} next={result.data.cryptoPurchases.nextCursor} keep={{ paymentsCursor }} label="Purchase transactions" />
          </div>
        </>
      )}
    </WalletsShell>
  );
}
