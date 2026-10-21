/**
 * Public anchoring facts for GET /v1/public/anchor-info.
 *
 * COA_ANCHOR_INFO is a tiny injectable value the COA core reads and never writes. The anchoring module (coa/anchor/**) provides the
 * real value from its own configuration, e.g. in the module that registers CoaModule:
 *
 *   CoaModule.register({ providers: [{ provide: COA_ANCHOR_INFO, useFactory: (cfg) => ({ network: cfg.network, publisher: cfg.publisherPublicKey, anchoringEnabled: cfg.enabled }), inject: [...] }] })
 *
 * When nothing is bound the endpoint reports DEFAULT_COA_ANCHOR_INFO (anchoring off, no network, no publisher). `publisher` is the PUBLIC
 * key that signs anchors, never any key material. Values are re-validated before they are served (unknown network => null).
 */
export type CoaAnchorNetwork = 'solana-devnet' | 'solana-mainnet';

export interface CoaAnchorInfo {
  network: CoaAnchorNetwork | null;
  publisher: string | null;
  anchoringEnabled: boolean;
}

export const COA_ANCHOR_INFO = Symbol('COA_ANCHOR_INFO');

export const DEFAULT_COA_ANCHOR_INFO: Readonly<CoaAnchorInfo> = Object.freeze({ network: null, publisher: null, anchoringEnabled: false });

export function isCoaAnchorNetwork(value: unknown): value is CoaAnchorNetwork {
  return value === 'solana-devnet' || value === 'solana-mainnet';
}

/** Defensive copy: only the three public fields, each re-validated. */
export function normalizeAnchorInfo(value: Partial<CoaAnchorInfo> | null | undefined): CoaAnchorInfo {
  const raw = value ?? DEFAULT_COA_ANCHOR_INFO;
  return {
    network: isCoaAnchorNetwork(raw.network) ? raw.network : null,
    publisher: typeof raw.publisher === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw.publisher) ? raw.publisher : null,
    anchoringEnabled: raw.anchoringEnabled === true,
  };
}
