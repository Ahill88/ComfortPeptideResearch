import type { CoaAnchorNetwork } from '../coa-anchor-info';

/** Anchoring configuration. Deliberately independent of the payment chain (SOLANA_*, ENABLE_SOLANA_MAINNET): anchoring on mainnet does not enable payments. */
export interface CoaAnchorConfig {
  /** COA_ANCHOR_ENABLED=true (exact). Off by default: COAs publish without anchors. */
  enabled: boolean;
  network: CoaAnchorNetwork;
  /** Always explicit for mainnet (env only); the public devnet endpoint for devnet unless overridden. */
  rpcUrl: string;
  /** COA_ANCHOR_RECONCILE_INTERVAL_MS, 0 disables the scheduled sweep. */
  reconcileIntervalMs: number;
}

export const COA_ANCHOR_CONFIG = Symbol('COA_ANCHOR_CONFIG');

export const DEFAULT_COA_ANCHOR_DEVNET_RPC_URL = 'https://api.devnet.solana.com';
export const DEFAULT_COA_ANCHOR_RECONCILE_INTERVAL_MS = 60_000;
export const MAX_COA_ANCHOR_RECONCILE_INTERVAL_MS = 86_400_000;

export const COA_ANCHOR_OFF: Readonly<CoaAnchorConfig> = Object.freeze({
  enabled: false,
  network: 'solana-devnet',
  rpcUrl: DEFAULT_COA_ANCHOR_DEVNET_RPC_URL,
  reconcileIntervalMs: DEFAULT_COA_ANCHOR_RECONCILE_INTERVAL_MS,
});

const blank = (value: string | undefined) => value === undefined || value.trim() === '';

/**
 * Strict parser, run at startup (COA_ANCHOR_CONFIG provider). A bad value throws so the API refuses to boot instead of anchoring
 * somewhere the operator did not intend (same approach as ONRAMP_* and FEE_SPONSORSHIP). Messages never echo an RPC URL (it may
 * carry an API key), only which variable is wrong.
 *
 *  COA_ANCHOR_ENABLED   unset/blank/"false" = off; exactly "true" = on; anything else ("TRUE", "1", "yes") is an error.
 *  COA_ANCHOR_NETWORK   unset/blank = "solana-devnet"; exactly "solana-devnet" or "solana-mainnet"; anything else is an error.
 *  COA_ANCHOR_RPC_URL   devnet: optional (default: the public devnet endpoint), must not look like mainnet.
 *                       mainnet: REQUIRED and explicit (there is no default and no mainnet URL literal exists in this repo),
 *                       must not look like devnet or localhost.  http(s) only; https required except for localhost devnet.
 *  COA_ANCHOR_RECONCILE_INTERVAL_MS  whole milliseconds, default 60000, 0 disables the scheduled sweep, at most one day.
 */
export function loadCoaAnchorConfig(env: Record<string, string | undefined> = process.env): CoaAnchorConfig {
  const flag = env.COA_ANCHOR_ENABLED;
  let enabled: boolean;
  if (blank(flag) || flag === 'false') enabled = false;
  else if (flag === 'true') enabled = true;
  else throw new Error('COA_ANCHOR_ENABLED must be exactly "true" or "false"');

  const networkRaw = env.COA_ANCHOR_NETWORK;
  let network: CoaAnchorNetwork;
  if (blank(networkRaw)) network = 'solana-devnet';
  else if (networkRaw === 'solana-devnet' || networkRaw === 'solana-mainnet') network = networkRaw;
  else throw new Error('COA_ANCHOR_NETWORK must be exactly "solana-devnet" or "solana-mainnet"');

  const urlRaw = env.COA_ANCHOR_RPC_URL;
  let rpcUrl: string;
  if (blank(urlRaw)) {
    if (network === 'solana-mainnet') throw new Error('COA_ANCHOR_RPC_URL is required (explicit) when COA_ANCHOR_NETWORK=solana-mainnet');
    rpcUrl = DEFAULT_COA_ANCHOR_DEVNET_RPC_URL;
  } else {
    rpcUrl = urlRaw!.trim();
    let parsed: URL;
    try {
      parsed = new URL(rpcUrl);
    } catch {
      throw new Error('COA_ANCHOR_RPC_URL is not a valid URL');
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local && network === 'solana-devnet')) {
      throw new Error('COA_ANCHOR_RPC_URL must be an https URL (http is allowed only for a local devnet validator)');
    }
    if (network === 'solana-devnet' && /mainnet/i.test(rpcUrl)) {
      throw new Error('COA_ANCHOR_RPC_URL looks like mainnet but COA_ANCHOR_NETWORK is solana-devnet; refusing to start');
    }
    if (network === 'solana-mainnet' && (/devnet|testnet/i.test(rpcUrl) || local)) {
      throw new Error('COA_ANCHOR_RPC_URL looks like a devnet/testnet/local endpoint but COA_ANCHOR_NETWORK is solana-mainnet; refusing to start');
    }
  }

  const intervalRaw = env.COA_ANCHOR_RECONCILE_INTERVAL_MS?.trim();
  let reconcileIntervalMs = DEFAULT_COA_ANCHOR_RECONCILE_INTERVAL_MS;
  if (intervalRaw) {
    if (!/^\d{1,9}$/.test(intervalRaw) || Number(intervalRaw) > MAX_COA_ANCHOR_RECONCILE_INTERVAL_MS) {
      throw new Error(`COA_ANCHOR_RECONCILE_INTERVAL_MS must be a whole number of milliseconds between 0 and ${MAX_COA_ANCHOR_RECONCILE_INTERVAL_MS} (0 disables)`);
    }
    reconcileIntervalMs = Number(intervalRaw);
  }
  return { enabled, network, rpcUrl, reconcileIntervalMs };
}
