/**
 * Ports (injection tokens + minimal interfaces) the checkout module expects the importer
 * (WalletModule / lead) to provide. Checkout never imports wallet implementation files; it only
 * depends on `../contracts` types and the shapes declared here.
 */
import type { SolanaChain, SpendableBalance, WalletFeatureFlags } from '../contracts';

/** Provide: a `SolanaChain` implementation (devnet RPC or sandbox). */
export const CHAIN_PORT = Symbol('CHECKOUT_CHAIN_PORT');
export type ChainPort = SolanaChain;

/** Provide: spendable balance for a customer (finalized - pending outgoing - active reservations). */
export const BALANCE_PORT = Symbol('CHECKOUT_BALANCE_PORT');
export interface BalancePort {
  /**
   * `stale` MUST be true when the finalized balance could not be freshly read. Checkout fails closed
   * on stale balances. Implementations may also throw ChainUnavailableError (mapped to HTTP 503).
   */
  getSpendable(customerId: string): Promise<SpendableBalance & { stale: boolean }>;
}

/** Provide: look up the customer's own (user-owned) wallet address. */
export const WALLET_LOOKUP_PORT = Symbol('CHECKOUT_WALLET_LOOKUP_PORT');
export interface WalletLookupPort {
  /** Returns null when the customer has no wallet. Address is a base58 Solana public key. */
  getWallet(customerId: string): Promise<{ address: string; network?: string } | null>;
}

/** Provide: fulfillment trigger. Called at most once per settled order, and only when enableLiveFulfillment. */
export const FULFILLMENT_PORT = Symbol('CHECKOUT_FULFILLMENT_PORT');
export interface FulfillmentTrigger {
  trigger(input: { orderId: string; customerId: string; paymentReference: string; txSignature: string }): Promise<void>;
}

/** Provide: the WalletFeatureFlags object (see loadFeatureFlags in contracts). Read on every call. */
export const WALLET_FLAGS = Symbol('CHECKOUT_WALLET_FLAGS');
export type WalletFlagsPort = WalletFeatureFlags;

/** Provided by CheckoutModule itself (defaults to in-memory). Override to persist. */
export const PREPARED_MESSAGE_STORE = Symbol('CHECKOUT_PREPARED_MESSAGE_STORE');

/** Provided by CheckoutModule itself (reads env). */
export const CHECKOUT_CONFIG = Symbol('CHECKOUT_CONFIG');

export interface PreparedMessage {
  reference: string;
  orderId: string;
  customerId: string;
  /** Customer wallet (fee payer and sole required signer). */
  payer: string;
  merchant: string;
  mint: string;
  amountAtomic: bigint;
  referenceKey: string;
  feeLamports: bigint;
  /** Exact compiled legacy message bytes the customer must sign. */
  messageBytes: Uint8Array;
  createdAtMs: number;
}

/**
 * Stores the compiled message that checkout expects the customer to sign.
 * The default implementation is in-memory: it is lost on restart and not shared across API instances.
 * PRODUCTION NEEDS A PERSISTENT/SHARED IMPLEMENTATION (e.g. Redis/DB). When an entry is missing,
 * submit fails closed with 409 and the customer must call prepare again.
 */
export interface PreparedMessageStore {
  put(entry: PreparedMessage): Promise<void>;
  get(reference: string): Promise<PreparedMessage | null>;
  delete(reference: string): Promise<void>;
}

export interface CheckoutConfig {
  /** Merchant USDC treasury owner address (env SOLANA_USDC_TREASURY). */
  treasury: string | undefined;
  /** Mint to use on mainnet. Unset => mainnet purchases are refused even when the mainnet flag is on. */
  mainnetUsdcMint: string | undefined;
  reservationTtlMs: number;
  /** A prepared message older than this is rebuilt (fresh blockhash) on re-prepare. */
  messageReuseMs: number;
  /** Informational only. NOT a gate: nothing may compare this to 'production'; use config/runtime.ts allowlist helpers. */
  nodeEnv: string | undefined;
}

export function loadCheckoutConfig(env: NodeJS.ProcessEnv = process.env): CheckoutConfig {
  return {
    treasury: env.SOLANA_USDC_TREASURY?.trim() || undefined,
    mainnetUsdcMint: env.SOLANA_USDC_MAINNET_MINT?.trim() || undefined,
    reservationTtlMs: 15 * 60_000,
    messageReuseMs: 20_000,
    nodeEnv: env.NODE_ENV,
  };
}
