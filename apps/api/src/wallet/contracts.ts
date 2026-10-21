/**
 * Shared contracts for the user-owned wallet and Research Credits domain.
 *
 * Invariants (enforced by tests/wallet/*):
 *  - The platform never holds, receives, or persists private keys or seed material.
 *  - Funds move only when a transaction is signed by the customer's own key.
 *  - All token math uses bigint USDC base units (6 decimals). Never floats.
 *  - Research Credits are a derived display unit, never an issued balance.
 */

export const USDC_DECIMALS = 6;
export const USDC_BASE_UNITS_PER_USDC = 1_000_000n;
/**
 * Built-in USDC mint for DEVNET only: the fallback when SOLANA_USDC_MINT is unset on solana-devnet (see wallet.config.ts).
 * Nothing may use it for any other network; the one mint source at runtime is `chain.usdcMint` (usdcMintOf in chain/chain.types.ts).
 */
export const USDC_DEVNET_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const SOLANA_NETWORK_DEVNET = 'solana-devnet';
export const SOLANA_NETWORK_MAINNET = 'solana-mainnet';

export type SolanaNetwork = 'solana-devnet' | 'solana-mainnet';

/** Feature flags. Every flag defaults to false; mainnet/live paths must fail closed. */
export interface WalletFeatureFlags {
  enableRealMoonpay: boolean;
  enableSolanaMainnet: boolean;
  enableLiveCryptoPayments: boolean;
  enableDelegatedPayments: boolean;
  enableLiveFulfillment: boolean;
}

export function loadFeatureFlags(env: NodeJS.ProcessEnv = process.env): WalletFeatureFlags {
  const on = (value: string | undefined) => value === 'true';
  return {
    enableRealMoonpay: on(env.ENABLE_REAL_MOONPAY),
    enableSolanaMainnet: on(env.ENABLE_SOLANA_MAINNET),
    enableLiveCryptoPayments: on(env.ENABLE_LIVE_CRYPTO_PAYMENTS),
    enableDelegatedPayments: on(env.ENABLE_DELEGATED_PAYMENTS),
    enableLiveFulfillment: on(env.ENABLE_LIVE_FULFILLMENT),
  };
}

/** A transfer as observed on chain (already parsed). */
export interface ChainTransfer {
  signature: string;
  network: SolanaNetwork;
  /** True only when the cluster reports `finalized` commitment. */
  finalized: boolean;
  /** True if the transaction executed without error. */
  succeeded: boolean;
  mint: string;
  sourceOwner: string;
  destinationOwner: string;
  amountAtomic: bigint;
  /** Reference account keys present in the transaction (Solana Pay style). */
  referenceKeys: string[];
}

export class ChainUnavailableError extends Error {
  constructor(message = 'Solana RPC is unavailable') {
    super(message);
    this.name = 'ChainUnavailableError';
  }
}

/** Read/broadcast access to Solana. Implementations: devnet RPC, sandbox in-memory. */
export interface SolanaChain {
  readonly network: SolanaNetwork;
  /** Finalized USDC balance (base units) for an owner address. Throws ChainUnavailableError on outage. */
  getFinalizedUsdcBalance(owner: string): Promise<bigint>;
  getSolBalanceLamports(owner: string): Promise<bigint>;
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  /** Estimated network fee in lamports for a standard single-signature transfer. */
  estimateFeeLamports(): Promise<bigint>;
  /** Broadcast an already fully signed, serialized transaction. Returns the signature. */
  broadcast(serializedSignedTransaction: Uint8Array): Promise<string>;
  getTransfer(signature: string): Promise<ChainTransfer | null>;
}

/** Wallet provider port. Implementations hold NO keys on the platform side. */
export interface WalletProviderInfo {
  readonly name: 'privy' | 'sandbox';
  readonly custody: 'USER_OWNED';
  /** Plain-language ownership/recovery disclosure shown to the customer. */
  readonly disclosure: string;
  readonly recoverySupported: boolean;
  readonly exportSupported: boolean;
}

export interface OnRampQuote {
  provider: 'moonpay' | 'moonpay-sandbox';
  intendedUsdCents: number;
  destinationAddress: string;
  /** Provider-supplied estimates only; null when the provider has not quoted. */
  estimatedFeeUsdCents: number | null;
  estimatedUsdcAtomic: bigint | null;
  widgetUrl: string;
  sandbox: boolean;
  disclosures: string[];
}

export interface OnRampProvider {
  createQuote(input: { customerId: string; destinationAddress: string; intendedUsdCents: number }): Promise<OnRampQuote>;
}

/** Credit math. Pure and shared so API, UI, and tests agree. */
export interface SpendableInput {
  finalizedAtomic: bigint;
  pendingOutgoingAtomic: bigint;
  activeReservationsAtomic: bigint;
}

export interface SpendableBalance {
  finalizedAtomic: bigint;
  spendableAtomic: bigint;
  /** floor(spendable USDC). 1 RC = 1 USDC of available purchasing value. */
  researchCredits: bigint;
}

export function computeSpendable(input: SpendableInput): SpendableBalance {
  for (const value of Object.values(input)) {
    if (typeof value !== 'bigint' || value < 0n) throw new RangeError('Balance inputs must be non-negative bigint base units');
  }
  const raw = input.finalizedAtomic - input.pendingOutgoingAtomic - input.activeReservationsAtomic;
  const spendableAtomic = raw > 0n ? raw : 0n;
  return {
    finalizedAtomic: input.finalizedAtomic,
    spendableAtomic,
    researchCredits: spendableAtomic / USDC_BASE_UNITS_PER_USDC,
  };
}

/** Integer cents to USDC base units (1 cent = 10,000 base units). */
export function centsToAtomic(cents: number): bigint {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError('Cents must be a non-negative safe integer');
  return BigInt(cents) * 10_000n;
}
