import { SolanaChain, USDC_DEVNET_MINT } from '../contracts';

/** Standard base fee for a single-signature transaction (5000 lamports per signature). */
export const BASE_FEE_LAMPORTS_PER_SIGNATURE = 5000n;
/** Rent-exempt minimum for a 165-byte SPL token account (standard value, 2,039,280 lamports). */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280n;

/**
 * Optional capabilities both bundled adapters implement. Kept outside contracts.ts (read-only)
 * so adapters stay compatible with the shared SolanaChain interface.
 */
export interface WalletChain extends SolanaChain {
  readonly usdcMint: string;
  /** Whether the owner's USDC associated token account exists at finalized commitment. */
  usdcAccountExists(owner: string): Promise<boolean>;
  /** Rent-exempt lamports required to create a USDC token account. */
  tokenAccountRentLamports(): Promise<bigint>;
}

/**
 * THE USDC mint of a chain. A chain that declares none falls back to the built-in mint ONLY on devnet; on any other network this
 * throws, so a missing mint can never silently become a devnet address on mainnet.
 */
export function usdcMintOf(chain: SolanaChain): string {
  const declared = (chain as Partial<WalletChain>).usdcMint;
  if (declared) return declared;
  if (chain.network === 'solana-devnet') return USDC_DEVNET_MINT;
  throw new Error(`No USDC mint is configured for ${chain.network}`);
}

/** usdcMintOf, but null (never equal to any mint) when the chain declares none: for equality checks that must fail closed. */
export function usdcMintOrNull(chain: SolanaChain): string | null {
  try {
    return usdcMintOf(chain);
  } catch {
    return null;
  }
}
