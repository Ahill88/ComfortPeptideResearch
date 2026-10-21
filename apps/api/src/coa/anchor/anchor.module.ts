import { DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import { COA_ANCHOR_INFO, type CoaAnchorInfo } from '../coa-anchor-info';
import { COA_ANCHOR_PORT } from '../coa.types';
import { AnchorService } from './anchor.service';
import { CoaAnchorScheduler } from './anchor.scheduler';
import { COA_ANCHOR_CONFIG, loadCoaAnchorConfig, type CoaAnchorConfig } from './coa-anchor.config';
import { COA_ANCHOR_CHAIN, SolanaCoaAnchorChain } from './coa-anchor-chain';
import { COA_PUBLISHER_SIGNER, type CoaPublisherSigner } from './coa-publisher-signer.port';

/** The public anchoring facts (GET /v1/public/anchor-info): anchoring is "enabled" only when it is switched on AND a publisher signer is bound. */
export function buildCoaAnchorInfo(config: CoaAnchorConfig, signer: CoaPublisherSigner | undefined): CoaAnchorInfo {
  if (!config.enabled || !signer) return { network: null, publisher: null, anchoringEnabled: false };
  return { network: config.network, publisher: signer.publicKey, anchoringEnabled: true };
}

/**
 * On-chain anchoring of COA hashes. Global so the COA core can inject COA_ANCHOR_PORT / COA_ANCHOR_INFO and the admin retry route can
 * inject AnchorService without importing this module.
 *
 * Providers (all strictly configured at startup, see coa-anchor.config.ts):
 *   COA_ANCHOR_CONFIG    parsed COA_ANCHOR_* environment (a bad value stops the API from starting)
 *   COA_ANCHOR_CHAIN     Solana RPC adapter for the configured network (separate from the payment chain)
 *   COA_PUBLISHER_SIGNER NOT bound here (undefined): the repository ships no key. Deployments bind a KMS/HSM-backed signer with
 *                        `CoaAnchorModule.register({ providers: [{ provide: COA_PUBLISHER_SIGNER, useClass: KmsCoaPublisherSigner }] })`
 *                        (the dev launcher overrides the provider with a throwaway devnet key). Without it anchors stay PENDING with an error.
 *   COA_ANCHOR_PORT      -> AnchorService (what the COA core calls after publish/revoke)
 *   COA_ANCHOR_INFO      the public value read by the anchor-info endpoint
 */
@Global()
@Module({
  providers: [
    { provide: COA_ANCHOR_CONFIG, useFactory: (): CoaAnchorConfig => loadCoaAnchorConfig(process.env) },
    {
      provide: COA_ANCHOR_CHAIN,
      inject: [COA_ANCHOR_CONFIG],
      useFactory: (config: CoaAnchorConfig) => new SolanaCoaAnchorChain({ network: config.network, rpcUrl: config.rpcUrl }),
    },
    { provide: COA_PUBLISHER_SIGNER, useFactory: (): CoaPublisherSigner | undefined => undefined },
    AnchorService,
    CoaAnchorScheduler,
    { provide: COA_ANCHOR_PORT, useExisting: AnchorService },
    {
      provide: COA_ANCHOR_INFO,
      inject: [COA_ANCHOR_CONFIG, COA_PUBLISHER_SIGNER],
      useFactory: (config: CoaAnchorConfig, signer: CoaPublisherSigner | undefined): CoaAnchorInfo => buildCoaAnchorInfo(config, signer),
    },
  ],
  exports: [AnchorService, COA_ANCHOR_PORT, COA_ANCHOR_INFO, COA_ANCHOR_CONFIG, COA_ANCHOR_CHAIN, COA_PUBLISHER_SIGNER],
})
export class CoaAnchorModule {
  /** Bind or replace providers (Nest keeps the last provider registered for a token), e.g. the KMS/HSM COA_PUBLISHER_SIGNER. */
  static register(options: { providers: Provider[] }): DynamicModule {
    return { module: CoaAnchorModule, providers: options.providers };
  }
}
