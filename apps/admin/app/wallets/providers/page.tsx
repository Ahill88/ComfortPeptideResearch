import { fetchWalletAdmin } from '../../../components/wallets/api';
import { requireAdminSession } from '../../../components/wallets/gate';
import type { ProvidersResponse } from '../../../components/wallets/types';
import { ApiErrorState, Note, SectionTitle, StatusBadge, WalletsShell, walletStyles } from '../../../components/wallets/ui';

export const dynamic = 'force-dynamic';

const FLAG_LABELS: Record<string, string> = {
  ENABLE_REAL_MOONPAY: 'Real MoonPay',
  ENABLE_SOLANA_MAINNET: 'Solana mainnet',
  ENABLE_LIVE_CRYPTO_PAYMENTS: 'Live crypto payments',
  ENABLE_DELEGATED_PAYMENTS: 'Delegated payments',
  ENABLE_LIVE_FULFILLMENT: 'Live fulfillment',
};

export default async function ProvidersPage() {
  await requireAdminSession();
  const result = await fetchWalletAdmin<ProvidersResponse>('providers');

  return (
    <WalletsShell active="providers">
      {!result.ok ? (
        <ApiErrorState result={result} />
      ) : (
        <>
          <Note>This view reports configuration state only (set / not set, on / off). Secret values are never returned by the API or shown here.</Note>

          <SectionTitle>Providers</SectionTitle>
          <dl className={walletStyles.dl}>
            <dt>Privy (wallet provider)</dt><dd>{result.data.privy.status}</dd>
            <dt>MoonPay mode</dt><dd><StatusBadge status={result.data.moonpay.mode === 'real' ? 'ACTIVE' : 'PENDING'} /> {result.data.moonpay.mode}</dd>
            <dt>MoonPay real mode requested</dt><dd>{result.data.moonpay.realRequested ? 'Yes' : 'No'}</dd>
            <dt>MoonPay publishable key</dt><dd>{result.data.moonpay.publishableKeyConfigured ? 'Configured' : 'Not configured'}</dd>
            <dt>Solana network</dt><dd>{result.data.solana.network}</dd>
            <dt>Wallet chain mode</dt><dd>{result.data.solana.walletChainMode}</dd>
          </dl>

          <div style={{ marginTop: 34 }}>
            <SectionTitle>Feature flags</SectionTitle>
            <dl className={walletStyles.dl}>
              {Object.entries(result.data.featureFlags).map(([flag, enabled]) => (
                <div key={flag} style={{ display: 'contents' }}>
                  <dt>{FLAG_LABELS[flag] ?? flag}<br /><span className={walletStyles.mono}>{flag}</span></dt>
                  <dd>{enabled ? 'Enabled' : 'Disabled'}</dd>
                </div>
              ))}
            </dl>
          </div>
        </>
      )}
    </WalletsShell>
  );
}
