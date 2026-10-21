import { WalletProviderInfo } from './contracts';
import { WalletRuntimeConfig } from './wallet.config';

export type WalletProviderName = WalletProviderInfo['name'];
export const WALLET_PROVIDER_NAMES: WalletProviderName[] = ['privy', 'sandbox'];

/** Extends the shared descriptor with honest availability information. */
export interface WalletProviderDescriptor extends WalletProviderInfo {
  label: string;
  /** True only when this provider is configured in this deployment. */
  active: boolean;
  /** Environment/config a deployment needs before the provider can be used. */
  requirements: string[];
  realFundsSuitable: boolean;
}

type ProviderConfig = Pick<WalletRuntimeConfig, 'privyAppId' | 'isProductionLike' | 'solanaNetwork'>;

/**
 * The `sandbox` provider records a throwaway key that lives in a browser's localStorage. It is allowed only when the runtime is
 * EXPLICITLY not production-like (exactly NODE_ENV=development|test: allowlist semantics, an omitted flag is denied) AND the chain
 * is not mainnet: otherwise a MoonPay purchase could deliver real USDC to a key anyone with that browser profile controls.
 */
export function isSandboxProviderAllowed(config: Pick<WalletRuntimeConfig, 'isProductionLike' | 'solanaNetwork'>): boolean {
  return config.isProductionLike === false && config.solanaNetwork !== 'solana-mainnet';
}

export const SANDBOX_PROVIDER_REFUSED_MESSAGE =
  'The sandbox wallet provider cannot be linked on mainnet or in a production-like runtime: its key lives in a browser and is not for real funds.';

export function describeWalletProvider(name: WalletProviderName, config: ProviderConfig): WalletProviderDescriptor {
  if (name === 'privy') {
    const configured = Boolean(config.privyAppId);
    return {
      name: 'privy',
      label: 'Privy embedded wallet',
      custody: 'USER_OWNED',
      active: configured,
      requirements: ['PRIVY_APP_ID', 'Privy server credentials'],
      realFundsSuitable: false,
      recoverySupported: false,
      exportSupported: false,
      disclosure: configured
        ? 'PRIVY_APP_ID is set, but this release only records the public address the client reports; it does not verify that the address was issued by Privy. Ownership, recovery and export terms are Privy\'s and must be reviewed before use. This platform never holds your private key. Recovery/export are not claimed here until verified.'
        : 'NOT ACTIVE. Privy integration requires PRIVY_APP_ID and Privy credentials, and they are not configured in this deployment. Privy wallets cannot be created or linked until it is configured. This platform never holds your private key.',
    };
  }
  return {
    name: 'sandbox',
    label: 'Sandbox wallet (devnet only)',
    custody: 'USER_OWNED',
    // Inactive (cannot be linked) on mainnet and in every production-like runtime; see isSandboxProviderAllowed.
    active: isSandboxProviderAllowed(config),
    requirements: [],
    realFundsSuitable: false,
    recoverySupported: false,
    exportSupported: false,
    disclosure:
      'SANDBOX ONLY, NOT PRIVY. This is a throwaway devnet key held in your browser by the storefront test tooling. It is not for real funds: anyone with access to this browser profile can move the funds, clearing browser storage permanently loses the wallet, and there is no recovery. This platform never holds your private key.',
  };
}
