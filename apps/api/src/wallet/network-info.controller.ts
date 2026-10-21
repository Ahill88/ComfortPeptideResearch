import { Controller, Get, Inject, Optional, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { usdcMintOf } from './chain/chain.types';
import { ChainPreflight } from './chain/chain-preflight';
import { SolanaChain, SolanaNetwork, WalletFeatureFlags } from './contracts';
import { SOLANA_CHAIN, WALLET_FEATURE_FLAGS } from './wallet.tokens';

export const NETWORK_INFO_CACHE_SECONDS = 60;
const EXPLORER_TX_BASE = 'https://explorer.solana.com/tx/';

/** docs/api/commerce-contract.md section 7. The storefront refuses to build or sign a payment whose network/mint differs. */
export interface NetworkInfo {
  network: SolanaNetwork;
  usdcMint: string;
  explorerTxBase: string;
  /** '?cluster=devnet' on devnet, '' on mainnet. */
  explorerClusterQuery: string;
  /** True only when payments can currently move REAL funds: mainnet, both live flags on, and the chain preflight passed. */
  livePayments: boolean;
}

export function buildNetworkInfo(input: { network: SolanaNetwork; usdcMint: string; flags: Pick<WalletFeatureFlags, 'enableSolanaMainnet' | 'enableLiveCryptoPayments'>; chainReady: boolean }): NetworkInfo {
  const mainnet = input.network === 'solana-mainnet';
  return {
    network: input.network,
    usdcMint: input.usdcMint,
    explorerTxBase: EXPLORER_TX_BASE,
    explorerClusterQuery: mainnet ? '' : '?cluster=devnet',
    livePayments: mainnet && input.flags.enableSolanaMainnet === true && input.flags.enableLiveCryptoPayments === true && input.chainReady,
  };
}

interface HeaderSink {
  setHeader(name: string, value: string | number): unknown;
}

/**
 * UNAUTHENTICATED. Rate limiting is the existing `public` bucket (config/rate-limit.ts matches every /public/** path).
 * The body is the chain the API ACTUALLY uses (chain.network, chain.usdcMint), never a second copy of the configuration, cached
 * in-process for 60 s and by the browser/CDN through Cache-Control. It contains no URL of the RPC and no credential.
 */
@ApiTags('public-network')
@Controller('public')
export class NetworkInfoController {
  /** Time source (overridable in tests). */
  clock: () => number = () => Date.now();
  private cached: { at: number; body: NetworkInfo } | undefined;

  constructor(
    @Inject(SOLANA_CHAIN) private readonly chain: SolanaChain,
    @Inject(WALLET_FEATURE_FLAGS) private readonly flags: WalletFeatureFlags,
    @Optional() private readonly preflight?: ChainPreflight,
  ) {}

  @Get('network-info')
  @ApiOperation({ summary: 'Which Solana network and USDC mint this API settles on, and whether live (real-funds) payments are on. Public, cached 60 s.' })
  @ApiOkResponse({ description: 'NetworkInfo' })
  networkInfo(@Res({ passthrough: true }) res: HeaderSink): NetworkInfo {
    res.setHeader('Cache-Control', `public, max-age=${NETWORK_INFO_CACHE_SECONDS}`);
    const now = this.clock();
    if (this.cached && now - this.cached.at < NETWORK_INFO_CACHE_SECONDS * 1000) return this.cached.body;
    const body = buildNetworkInfo({ network: this.chain.network, usdcMint: usdcMintOf(this.chain), flags: this.flags, chainReady: this.preflight ? this.preflight.isReady() : true });
    this.cached = { at: now, body };
    return body;
  }
}
