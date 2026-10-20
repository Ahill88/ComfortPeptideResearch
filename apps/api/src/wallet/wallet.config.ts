import { isProductionLikeRuntime } from '../config/runtime';
import { SOLANA_NETWORK_DEVNET, SolanaNetwork, USDC_DEVNET_MINT } from './contracts';

export type WalletChainMode = 'sandbox' | 'devnet';

/** Environment-derived runtime configuration. Pure data so tests can inject it. */
export interface WalletRuntimeConfig {
  chainMode: WalletChainMode;
  /**
   * True for every runtime except exactly NODE_ENV=development|test (production, unset, "staging",
   * "prod", "Production", "production " ...). Sandbox-only behaviour (mock chain, mock-complete) is refused when true.
   */
  isProductionLike: boolean;
  /** @deprecated Always equal to isProductionLike; kept so older fixtures still fail closed. Do not read in new code. */
  isProduction: boolean;
  solanaRpcUrl: string;
  solanaNetwork: SolanaNetwork;
  /** USDC mint for the configured network. Mainnet requires SOLANA_USDC_MINT explicitly. */
  usdcMint: string | null;
  /** Platform treasury address. Never a valid on-ramp destination. */
  treasuryAddress: string | null;
  moonpayPublishableKey: string | null;
  /** MoonPay URL-signing secret (server-side only; never returned in any response). */
  moonpaySigningSecret: string | null;
  privyAppId: string | null;
}

/**
 * Sandbox gate shared by the chain factory and mock-complete. Allowlist semantics: the sandbox is usable
 * only when isProductionLike is explicitly `false` (a fixture or caller that omits it is denied) and the
 * deprecated alias is not set.
 */
export function isSandboxAllowed(config: Pick<WalletRuntimeConfig, 'isProductionLike' | 'isProduction'>): boolean {
  return config.isProductionLike === false && config.isProduction !== true;
}

const blankToNull = (value: string | undefined) => (value && value.trim() ? value.trim() : null);

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): WalletRuntimeConfig {
  const mode = (env.WALLET_CHAIN_MODE ?? 'sandbox').trim();
  if (mode !== 'sandbox' && mode !== 'devnet') {
    throw new Error(`WALLET_CHAIN_MODE must be "sandbox" or "devnet" (got "${mode}")`);
  }
  const network = (env.SOLANA_NETWORK ?? SOLANA_NETWORK_DEVNET).trim();
  if (network !== 'solana-devnet' && network !== 'solana-mainnet') {
    throw new Error(`SOLANA_NETWORK must be "solana-devnet" or "solana-mainnet" (got "${network}")`);
  }
  return {
    chainMode: mode,
    isProductionLike: isProductionLikeRuntime(env),
    isProduction: isProductionLikeRuntime(env),
    solanaRpcUrl: blankToNull(env.SOLANA_RPC_URL) ?? 'https://api.devnet.solana.com',
    solanaNetwork: network,
    usdcMint: blankToNull(env.SOLANA_USDC_MINT) ?? (network === 'solana-devnet' ? USDC_DEVNET_MINT : null),
    treasuryAddress: blankToNull(env.SOLANA_USDC_TREASURY),
    moonpayPublishableKey: blankToNull(env.MOONPAY_PUBLISHABLE_KEY),
    moonpaySigningSecret: blankToNull(env.MOONPAY_SECRET_KEY),
    privyAppId: blankToNull(env.PRIVY_APP_ID),
  };
}
