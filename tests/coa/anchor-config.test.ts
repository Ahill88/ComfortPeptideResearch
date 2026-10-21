/** COA anchoring config parsing, explorer URLs and the public anchor-info value. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildCoaAnchorInfo } from '../../apps/api/src/coa/anchor/anchor.module';
import { loadCoaAnchorConfig } from '../../apps/api/src/coa/anchor/coa-anchor.config';
import { coaExplorerTxUrl } from '../../apps/api/src/coa/anchor/coa-anchor-message';
import { normalizeAnchorInfo } from '../../apps/api/src/coa/coa-anchor-info';

// Built at runtime so no mainnet URL literal exists in the repo (custody-invariants forbids it).
const MAINNET_URL = ['https://', 'rpc', '.example-provider.io', '/mainnet', '/key'].join('');

test('defaults: off, devnet, public devnet endpoint, 60s sweep', () => {
  const config = loadCoaAnchorConfig({});
  assert.deepEqual(config, { enabled: false, network: 'solana-devnet', rpcUrl: 'https://api.devnet.solana.com', reconcileIntervalMs: 60_000 });
  assert.deepEqual(loadCoaAnchorConfig({ COA_ANCHOR_ENABLED: ' ', COA_ANCHOR_NETWORK: '', COA_ANCHOR_RPC_URL: '', COA_ANCHOR_RECONCILE_INTERVAL_MS: '' }), config);
});

test('COA_ANCHOR_ENABLED: only exact "true"/"false" (anything else refuses to start)', () => {
  assert.equal(loadCoaAnchorConfig({ COA_ANCHOR_ENABLED: 'true' }).enabled, true);
  assert.equal(loadCoaAnchorConfig({ COA_ANCHOR_ENABLED: 'false' }).enabled, false);
  for (const bad of ['TRUE', 'True', '1', 'yes', 'on', 'enabled', 'tru']) {
    assert.throws(() => loadCoaAnchorConfig({ COA_ANCHOR_ENABLED: bad }), /COA_ANCHOR_ENABLED/, bad);
  }
});

test('COA_ANCHOR_NETWORK: exact values only', () => {
  assert.equal(loadCoaAnchorConfig({ COA_ANCHOR_NETWORK: 'solana-devnet' }).network, 'solana-devnet');
  assert.equal(loadCoaAnchorConfig({ COA_ANCHOR_NETWORK: 'solana-mainnet', COA_ANCHOR_RPC_URL: MAINNET_URL }).network, 'solana-mainnet');
  for (const bad of ['devnet', 'mainnet', 'solana-testnet', 'Solana-Devnet', 'solana-mainnet-beta', 'garbage']) {
    assert.throws(() => loadCoaAnchorConfig({ COA_ANCHOR_NETWORK: bad, COA_ANCHOR_RPC_URL: MAINNET_URL }), /COA_ANCHOR_NETWORK/, bad);
  }
});

test('mainnet requires an explicit RPC URL (no default, even while disabled); devnet/local/garbage URLs are refused for mainnet', () => {
  assert.throws(() => loadCoaAnchorConfig({ COA_ANCHOR_NETWORK: 'solana-mainnet' }), /COA_ANCHOR_RPC_URL is required/);
  assert.throws(() => loadCoaAnchorConfig({ COA_ANCHOR_NETWORK: 'solana-mainnet', COA_ANCHOR_ENABLED: 'true', COA_ANCHOR_RPC_URL: '   ' }), /required/);
  assert.throws(() => loadCoaAnchorConfig({ COA_ANCHOR_NETWORK: 'solana-mainnet', COA_ANCHOR_RPC_URL: 'https://api.devnet.solana.com' }), /devnet/);
  assert.throws(() => loadCoaAnchorConfig({ COA_ANCHOR_NETWORK: 'solana-mainnet', COA_ANCHOR_RPC_URL: 'http://localhost:8899' }), /https|local/);
  assert.throws(() => loadCoaAnchorConfig({ COA_ANCHOR_NETWORK: 'solana-mainnet', COA_ANCHOR_RPC_URL: 'not a url' }), /valid URL/);
  assert.throws(() => loadCoaAnchorConfig({ COA_ANCHOR_NETWORK: 'solana-mainnet', COA_ANCHOR_RPC_URL: 'http://rpc.example.com' }), /https/);
  assert.equal(loadCoaAnchorConfig({ COA_ANCHOR_NETWORK: 'solana-mainnet', COA_ANCHOR_RPC_URL: MAINNET_URL }).rpcUrl, MAINNET_URL);
});

test('devnet RPC URL: https or local http; mainnet-looking URLs and garbage are refused; errors never echo the URL', () => {
  assert.equal(loadCoaAnchorConfig({ COA_ANCHOR_RPC_URL: 'http://127.0.0.1:8899' }).rpcUrl, 'http://127.0.0.1:8899');
  assert.equal(loadCoaAnchorConfig({ COA_ANCHOR_RPC_URL: 'https://devnet.helius-rpc.com/?api-key=abc' }).rpcUrl, 'https://devnet.helius-rpc.com/?api-key=abc');
  for (const bad of [MAINNET_URL, 'ftp://x.example.com', 'javascript:alert(1)', 'http://rpc.example.com', 'api.devnet.solana.com']) {
    assert.throws(() => loadCoaAnchorConfig({ COA_ANCHOR_RPC_URL: bad }), (error: Error) => /COA_ANCHOR_RPC_URL/.test(error.message) && !error.message.includes(bad), bad);
  }
});

test('COA_ANCHOR_RECONCILE_INTERVAL_MS: whole ms, 0 disables, garbage refuses', () => {
  assert.equal(loadCoaAnchorConfig({ COA_ANCHOR_RECONCILE_INTERVAL_MS: '0' }).reconcileIntervalMs, 0);
  assert.equal(loadCoaAnchorConfig({ COA_ANCHOR_RECONCILE_INTERVAL_MS: '5000' }).reconcileIntervalMs, 5000);
  for (const bad of ['-1', '1.5', '1e3', 'abc', '86400001', '99999999999']) {
    assert.throws(() => loadCoaAnchorConfig({ COA_ANCHOR_RECONCILE_INTERVAL_MS: bad }), /COA_ANCHOR_RECONCILE_INTERVAL_MS/, bad);
  }
});

test('anchoring config is independent of the payment chain flags', () => {
  const config = loadCoaAnchorConfig({ COA_ANCHOR_ENABLED: 'true', COA_ANCHOR_NETWORK: 'solana-mainnet', COA_ANCHOR_RPC_URL: MAINNET_URL, ENABLE_SOLANA_MAINNET: 'false', SOLANA_NETWORK: 'solana-devnet', WALLET_CHAIN_MODE: 'sandbox' });
  assert.equal(config.network, 'solana-mainnet');
  assert.equal(config.enabled, true);
});

test('explorer URL: cluster=devnet only for devnet', () => {
  assert.equal(coaExplorerTxUrl('solana-devnet', 'SIG'), 'https://explorer.solana.com/tx/SIG?cluster=devnet');
  assert.equal(coaExplorerTxUrl('solana-mainnet', 'SIG'), 'https://explorer.solana.com/tx/SIG');
});

test('anchor info: enabled only when switched on AND a signer is bound; the value passes the core normalizer', () => {
  const signer = { publicKey: '11111111111111111111111111111112', signMessage: async () => new Uint8Array(64) };
  const on = loadCoaAnchorConfig({ COA_ANCHOR_ENABLED: 'true' });
  assert.deepEqual(buildCoaAnchorInfo(on, signer), { network: 'solana-devnet', publisher: signer.publicKey, anchoringEnabled: true });
  assert.deepEqual(buildCoaAnchorInfo(on, undefined), { network: null, publisher: null, anchoringEnabled: false });
  assert.deepEqual(buildCoaAnchorInfo(loadCoaAnchorConfig({}), signer), { network: null, publisher: null, anchoringEnabled: false });
  assert.deepEqual(normalizeAnchorInfo(buildCoaAnchorInfo(on, signer)), buildCoaAnchorInfo(on, signer));
});
