import { Logger } from '@nestjs/common';
import { WalletFeatureFlags } from '../contracts';
import { WalletRuntimeConfig, isSandboxAllowed } from '../wallet.config';
import { DevnetSolanaChain } from './devnet-solana-chain';
import { SandboxSolanaChain } from './sandbox-solana-chain';
import { WalletChain } from './chain.types';

/** Throws unless the in-memory mock chain may run (exactly NODE_ENV=development|test). */
export function assertSandboxChainAllowed(config: WalletRuntimeConfig): void {
  if (!isSandboxAllowed(config)) {
    throw new Error('WALLET_CHAIN_MODE=sandbox is an in-memory mock and is only allowed when NODE_ENV is exactly "development" or "test" (this runtime is production-like, including unset or unrecognised NODE_ENV values).');
  }
}

/** Chooses the chain adapter from WALLET_CHAIN_MODE (sandbox default). */
export function createSolanaChain(flags: WalletFeatureFlags, config: WalletRuntimeConfig): WalletChain {
  if (config.chainMode === 'devnet') {
    return new DevnetSolanaChain(flags, {
      rpcUrl: config.solanaRpcUrl,
      network: config.solanaNetwork,
      usdcMint: config.usdcMint ?? undefined,
    });
  }
  assertSandboxChainAllowed(config);
  // A running sandbox API has no operator calling finalize(), so broadcasts finalize immediately; the
  // verification path still re-reads and checks the transfer like any other chain.
  const chain = new SandboxSolanaChain({ autoFinalize: true });
  registerSandboxTreasury(chain, config.treasuryAddress);
  return chain;
}

/**
 * On real Solana the merchant's USDC token account must already exist; mirror that for the sandbox so
 * broadcasts to the treasury are accepted. creditUsdc(owner, 0n) registers the account without minting.
 */
function registerSandboxTreasury(chain: SandboxSolanaChain, treasury: string | null): void {
  if (!treasury) return;
  try {
    chain.creditUsdc(treasury, 0n);
  } catch (error) {
    new Logger('SandboxChain').warn(`SOLANA_USDC_TREASURY is not a valid address; treasury token account not registered: ${(error as Error).message}`);
  }
}
