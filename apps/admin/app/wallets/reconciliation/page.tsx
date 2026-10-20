import { fetchWalletAdmin } from '../../../components/wallets/api';
import { formatAge, formatDateTime } from '../../../components/wallets/format';
import { requireAdminSession } from '../../../components/wallets/gate';
import type { ReconciliationResponse } from '../../../components/wallets/types';
import { ApiErrorState, Mono, MetricCards, SectionTitle, WalletsShell, walletStyles } from '../../../components/wallets/ui';

export const dynamic = 'force-dynamic';

const ORDER = ['PREPARED', 'SUBMITTED', 'CONFIRMED', 'FINALIZED', 'FAILED', 'EXPIRED'];

export default async function ReconciliationPage() {
  await requireAdminSession();
  const result = await fetchWalletAdmin<ReconciliationResponse>('reconciliation');

  return (
    <WalletsShell active="reconciliation">
      {!result.ok ? (
        <ApiErrorState result={result} />
      ) : (
        <>
          <MetricCards items={ORDER.map((status) => ({ label: status, value: String(result.data.counts[status] ?? 0), note: 'transactions' }))} />
          <SectionTitle>Oldest submitted transaction</SectionTitle>
          {result.data.oldestSubmitted ? (
            <dl className={walletStyles.dl}>
              <dt>Age</dt><dd>{formatAge(result.data.oldestSubmitted.ageSeconds)}</dd>
              <dt>Submitted</dt><dd>{formatDateTime(result.data.oldestSubmitted.createdAt)}</dd>
              <dt>Type</dt><dd>{result.data.oldestSubmitted.type}</dd>
              <dt>Signature</dt><dd><Mono>{result.data.oldestSubmitted.txSignature ?? '-'}</Mono></dd>
              <dt>Transaction id</dt><dd><Mono>{result.data.oldestSubmitted.id}</Mono></dd>
            </dl>
          ) : (
            <p className="subtitle">No transactions are currently in SUBMITTED status.</p>
          )}
        </>
      )}
    </WalletsShell>
  );
}
