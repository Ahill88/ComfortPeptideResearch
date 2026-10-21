import { isProductionLikeRuntime } from '../config/runtime';
import { SOLANA_NETWORK_DEVNET, SOLANA_NETWORK_MAINNET, SolanaNetwork, USDC_DEVNET_MINT } from './contracts';

/**
 * `devnet` is the legacy name of the REAL RPC adapter (DevnetSolanaChain): it serves whichever network SOLANA_NETWORK names,
 * mainnet included. `sandbox` is the in-memory mock. The name is kept so existing deployments and tests keep working.
 */
export type WalletChainMode = 'sandbox' | 'devnet';

/** Default RPC for devnet ONLY. There is deliberately no default for any other network: mainnet needs an explicit SOLANA_RPC_URL. */
export const DEFAULT_DEVNET_RPC_URL = 'https://api.devnet.solana.com';

/**
 * Genesis hash of each Solana network: a public constant of the cluster (not a credential, not a URL). The boot-time chain
 * preflight compares the connected RPC's getGenesisHash against this, so an RPC that serves the wrong cluster can never be used.
 * Verified 2026-10-21 by calling the JSON-RPC method getGenesisHash on each cluster (see docs/wallet/mainnet-readiness.md).
 */
export const SOLANA_GENESIS_HASHES: Readonly<Record<SolanaNetwork, string>> = {
  'solana-devnet': 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'solana-mainnet': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};

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
  /**
   * THE one USDC mint for the configured network (env SOLANA_USDC_MINT). Devnet falls back to the built-in devnet mint;
   * mainnet REQUIRES it explicitly (loadRuntimeConfig refuses to build otherwise). It becomes `chain.usdcMint`, which
   * checkout, verification, refunds, balances, transfers and the on-ramp all read. SOLANA_USDC_MAINNET_MINT is deprecated and ignored.
   */
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
  if (network === SOLANA_NETWORK_MAINNET) {
    // Mainnet never inherits a default: a devnet RPC with a mainnet mint would silently read zero balances.
    if (mode === 'sandbox') throw new Error('SOLANA_NETWORK=solana-mainnet needs the real RPC adapter (WALLET_CHAIN_MODE=devnet); the sandbox chain is an in-memory mock.');
    if (!blankToNull(env.SOLANA_RPC_URL)) throw new Error('SOLANA_RPC_URL is required explicitly for solana-mainnet (there is no default).');
    if (!blankToNull(env.SOLANA_USDC_MINT)) throw new Error('SOLANA_USDC_MINT is required explicitly for solana-mainnet (copy it from Circle\'s official USDC contract-address page).');
  }
  return {
    chainMode: mode,
    isProductionLike: isProductionLikeRuntime(env),
    isProduction: isProductionLikeRuntime(env),
    solanaRpcUrl: blankToNull(env.SOLANA_RPC_URL) ?? DEFAULT_DEVNET_RPC_URL,
    solanaNetwork: network,
    usdcMint: blankToNull(env.SOLANA_USDC_MINT) ?? (network === 'solana-devnet' ? USDC_DEVNET_MINT : null),
    treasuryAddress: blankToNull(env.SOLANA_USDC_TREASURY),
    moonpayPublishableKey: blankToNull(env.MOONPAY_PUBLISHABLE_KEY),
    moonpaySigningSecret: blankToNull(env.MOONPAY_SECRET_KEY),
    privyAppId: blankToNull(env.PRIVY_APP_ID),
  };
}
