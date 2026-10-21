import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { LIVE_FUNDS_ACK_VALUE, validateEnv } from '../env.validation';
import { loadRuntimeConfig } from '../../wallet/wallet.config';
import { USDC_DEVNET_MINT } from '../../wallet/contracts';

const treasury = Keypair.generate().publicKey.toBase58();
const mint = Keypair.generate().publicKey.toBase58(); // stand-in: the repo does not hard-code the mainnet mint
// A syntactically valid, non-devnet https endpoint that is never contacted (pure validation).
const RPC = 'https://rpc.example.org/v1/abc123';

/** A fully valid MAINNET production environment; every test removes or changes one thing. */
const mainnet = (overrides: Record<string, string | undefined> = {}) => {
  const env: Record<string, string | undefined> = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://u:p@db:5432/app',
    SOLANA_USDC_TREASURY: treasury,
    WALLET_CHAIN_MODE: 'devnet',
    STOREFRONT_ORIGIN: 'https://shop.example.com',
    SOLANA_NETWORK: 'solana-mainnet',
    SOLANA_RPC_URL: RPC,
    SOLANA_USDC_MINT: mint,
    ENABLE_SOLANA_MAINNET: 'true',
    ENABLE_LIVE_CRYPTO_PAYMENTS: 'true',
    WALLET_LIVE_ACKNOWLEDGED: LIVE_FUNDS_ACK_VALUE,
    ...overrides,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env;
};
const devnet = (overrides: Record<string, string | undefined> = {}) => {
  const env: Record<string, string | undefined> = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://u:p@db:5432/app', SOLANA_USDC_TREASURY: treasury, WALLET_CHAIN_MODE: 'devnet', STOREFRONT_ORIGIN: 'https://shop.example.com', ...overrides };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env;
};
const errorsOf = (env: Record<string, string | undefined>) => validateEnv(env).errors.join('\n');

test('a complete mainnet environment validates with no errors (and a loud live-funds warning)', () => {
  const result = validateEnv(mainnet());
  assert.deepEqual(result.errors, []);
  assert.match(result.warnings.join('\n'), /LIVE FUNDS ENABLED/);
  // ... and builds a runtime config whose single mint is SOLANA_USDC_MINT
  const config = loadRuntimeConfig(mainnet() as NodeJS.ProcessEnv);
  assert.equal(config.solanaNetwork, 'solana-mainnet');
  assert.equal(config.usdcMint, mint);
  assert.equal(config.solanaRpcUrl, RPC);
});

test('MAINNET GATING: mainnet needs BOTH live flags exactly "true", each reported by name', () => {
  assert.match(errorsOf(mainnet({ ENABLE_SOLANA_MAINNET: undefined })), /requires ENABLE_SOLANA_MAINNET to be exactly "true"/);
  assert.match(errorsOf(mainnet({ ENABLE_LIVE_CRYPTO_PAYMENTS: undefined })), /requires ENABLE_LIVE_CRYPTO_PAYMENTS to be exactly "true"/);
  assert.match(errorsOf(mainnet({ ENABLE_LIVE_CRYPTO_PAYMENTS: 'TRUE' })), /requires ENABLE_LIVE_CRYPTO_PAYMENTS to be exactly "true"/);
  assert.match(errorsOf(mainnet({ ENABLE_SOLANA_MAINNET: '1' })), /requires ENABLE_SOLANA_MAINNET to be exactly "true"/);
});

test('mainnet needs the exact live-funds acknowledgement, even when the flags are off', () => {
  assert.match(errorsOf(mainnet({ WALLET_LIVE_ACKNOWLEDGED: undefined })), /WALLET_LIVE_ACKNOWLEDGED/);
  assert.match(errorsOf(mainnet({ WALLET_LIVE_ACKNOWLEDGED: 'yes' })), /WALLET_LIVE_ACKNOWLEDGED/);
  const flagsOff = errorsOf(mainnet({ ENABLE_SOLANA_MAINNET: undefined, ENABLE_LIVE_CRYPTO_PAYMENTS: undefined, WALLET_LIVE_ACKNOWLEDGED: undefined }));
  assert.match(flagsOff, /requires WALLET_LIVE_ACKNOWLEDGED=I_ACCEPT_LIVE_FUNDS_RISK/);
});

test('mainnet requires a production-like runtime: development, test and the live flags there are refused', () => {
  for (const NODE_ENV of ['development', 'test']) {
    const errors = errorsOf(mainnet({ NODE_ENV }));
    assert.match(errors, /requires a production-like runtime/, NODE_ENV);
    assert.match(errors, /are refused outside a production-like runtime/, NODE_ENV);
  }
  // live flags alone (even on devnet, even acknowledged) are refused in development/test
  for (const NODE_ENV of ['development', 'test']) {
    for (const flag of ['ENABLE_SOLANA_MAINNET', 'ENABLE_LIVE_CRYPTO_PAYMENTS']) {
      assert.match(errorsOf({ NODE_ENV, [flag]: 'true', WALLET_LIVE_ACKNOWLEDGED: LIVE_FUNDS_ACK_VALUE }), /refused outside a production-like runtime/, `${NODE_ENV}/${flag}`);
    }
  }
});

test('mainnet requires the real RPC adapter (not sandbox, not unset)', () => {
  assert.match(errorsOf(mainnet({ WALLET_CHAIN_MODE: 'sandbox' })), /WALLET_CHAIN_MODE/);
  assert.match(errorsOf(mainnet({ WALLET_CHAIN_MODE: undefined })), /WALLET_CHAIN_MODE/);
});

test('mainnet requires an explicit, valid base58 SOLANA_USDC_MINT (no built-in fallback)', () => {
  assert.match(errorsOf(mainnet({ SOLANA_USDC_MINT: undefined })), /SOLANA_USDC_MINT is required for solana-mainnet/);
  assert.match(errorsOf(mainnet({ SOLANA_USDC_MINT: '' })), /SOLANA_USDC_MINT is required for solana-mainnet/);
  assert.match(errorsOf(mainnet({ SOLANA_USDC_MINT: 'not-base58-0OIl' })), /SOLANA_USDC_MINT is not a valid base58/);
  assert.match(errorsOf(mainnet({ SOLANA_USDC_MINT: 'abc' })), /SOLANA_USDC_MINT is not a valid base58/);
  assert.match(errorsOf(mainnet({ SOLANA_USDC_MINT: treasury })), /treasury owner address, not the USDC mint/);
});

test('mainnet requires an explicit, non-default, https RPC; the devnet default is never accepted', () => {
  assert.match(errorsOf(mainnet({ SOLANA_RPC_URL: undefined })), /SOLANA_RPC_URL is required for solana-mainnet/);
  assert.match(errorsOf(mainnet({ SOLANA_RPC_URL: 'https://api.devnet.solana.com' })), /non-default, non-devnet, non-local/);
  assert.match(errorsOf(mainnet({ SOLANA_RPC_URL: 'https://api.testnet.solana.com' })), /non-default, non-devnet, non-local/);
  assert.match(errorsOf(mainnet({ SOLANA_RPC_URL: 'http://localhost:8899' })), /must be https|non-default, non-devnet, non-local/);
  assert.match(errorsOf(mainnet({ SOLANA_RPC_URL: 'http://rpc.example.org' })), /must be https/);
  assert.match(errorsOf(mainnet({ SOLANA_RPC_URL: 'not a url' })), /not a valid http\(s\) URL/);
  assert.match(errorsOf(mainnet({ SOLANA_RPC_URL: 'ftp://rpc.example.org' })), /not a valid http\(s\) URL/);
});

test('error messages never echo the RPC URL (it may embed a provider key)', () => {
  const all = validateEnv(mainnet({ SOLANA_RPC_URL: 'http://rpc.example.org/key-9f8e7d', SOLANA_USDC_MINT: undefined })).errors.join('\n');
  assert.doesNotMatch(all, /key-9f8e7d|rpc\.example\.org/);
});

test('MoonPay key environment must match the network: pk_live_ only with mainnet, pk_test_ only with devnet', () => {
  assert.deepEqual(validateEnv(mainnet({ MOONPAY_PUBLISHABLE_KEY: 'pk_live_abc' })).errors, []);
  assert.match(errorsOf(mainnet({ MOONPAY_PUBLISHABLE_KEY: 'pk_test_abc' })), /test key \(pk_test_\).*only with solana-devnet/);
  assert.deepEqual(validateEnv(devnet({ MOONPAY_PUBLISHABLE_KEY: 'pk_test_abc' })).errors, []);
  assert.match(errorsOf(devnet({ MOONPAY_PUBLISHABLE_KEY: 'pk_live_abc' })), /live key \(pk_live_\).*only with solana-mainnet/);
  assert.match(errorsOf(devnet({ MOONPAY_PUBLISHABLE_KEY: 'sk_whatever' })), /must start with pk_test_ or pk_live_/);
  const echoed = validateEnv(devnet({ MOONPAY_PUBLISHABLE_KEY: 'pk_live_topsecretvalue' })).errors.join('\n');
  assert.doesNotMatch(echoed, /topsecretvalue/);
});

test('devnet must not be combined with ENABLE_LIVE_* (or the mainnet flag)', () => {
  const ack = { WALLET_LIVE_ACKNOWLEDGED: LIVE_FUNDS_ACK_VALUE };
  assert.match(errorsOf(devnet({ ENABLE_LIVE_CRYPTO_PAYMENTS: 'true', ...ack })), /ENABLE_LIVE_CRYPTO_PAYMENTS must not be enabled while SOLANA_NETWORK is solana-devnet/);
  assert.match(errorsOf(devnet({ ENABLE_SOLANA_MAINNET: 'true', ...ack })), /ENABLE_SOLANA_MAINNET must not be enabled while SOLANA_NETWORK is solana-devnet/);
  assert.match(errorsOf(devnet({ SOLANA_NETWORK: 'solana-devnet', ENABLE_LIVE_CRYPTO_PAYMENTS: 'true', ...ack })), /solana-devnet/);
  assert.deepEqual(validateEnv(devnet()).errors, []);
});

test('devnet with a mainnet-looking RPC is refused; a devnet RPC and an unset RPC are fine', () => {
  assert.match(errorsOf(devnet({ SOLANA_RPC_URL: 'https://rpc.example.org/mainnet/v1' })), /looks like a mainnet endpoint but SOLANA_NETWORK is solana-devnet/);
  assert.deepEqual(validateEnv(devnet({ SOLANA_RPC_URL: 'https://api.devnet.solana.com' })).errors, []);
  assert.deepEqual(validateEnv(devnet({ SOLANA_RPC_URL: undefined })).errors, []);
});

test('SOLANA_NETWORK and SOLANA_USDC_MINT are validated on devnet too', () => {
  assert.match(errorsOf(devnet({ SOLANA_NETWORK: 'mainnet' })), /SOLANA_NETWORK must be/);
  assert.match(errorsOf(devnet({ SOLANA_USDC_MINT: 'zzzz' })), /SOLANA_USDC_MINT is not a valid base58/);
  assert.deepEqual(validateEnv(devnet({ SOLANA_USDC_MINT: USDC_DEVNET_MINT })).errors, []);
});

test('SOLANA_USDC_MAINNET_MINT is deprecated: warns when set and different (or alone), silent when equal, never an error', () => {
  const different = validateEnv(mainnet({ SOLANA_USDC_MAINNET_MINT: Keypair.generate().publicKey.toBase58() }));
  assert.deepEqual(different.errors, []);
  assert.match(different.warnings.join('\n'), /SOLANA_USDC_MAINNET_MINT is deprecated and IGNORED/);
  assert.match(validateEnv(devnet({ SOLANA_USDC_MAINNET_MINT: mint })).warnings.join('\n'), /SOLANA_USDC_MAINNET_MINT is deprecated/);
  assert.doesNotMatch(validateEnv(mainnet({ SOLANA_USDC_MAINNET_MINT: mint })).warnings.join('\n'), /deprecated/);
  assert.doesNotMatch(validateEnv(devnet()).warnings.join('\n'), /deprecated/);
});

test('loadRuntimeConfig: one mint source. Devnet falls back to the built-in mint, mainnet requires SOLANA_USDC_MINT and RPC, the legacy variable is ignored', () => {
  const dev = loadRuntimeConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  assert.equal(dev.usdcMint, USDC_DEVNET_MINT);
  assert.equal(loadRuntimeConfig({ NODE_ENV: 'test', SOLANA_USDC_MINT: mint } as NodeJS.ProcessEnv).usdcMint, mint);
  const base = { NODE_ENV: 'production', WALLET_CHAIN_MODE: 'devnet', SOLANA_NETWORK: 'solana-mainnet' };
  assert.throws(() => loadRuntimeConfig({ ...base, SOLANA_RPC_URL: RPC } as NodeJS.ProcessEnv), /SOLANA_USDC_MINT is required/);
  assert.throws(() => loadRuntimeConfig({ ...base, SOLANA_USDC_MINT: mint } as NodeJS.ProcessEnv), /SOLANA_RPC_URL is required/);
  assert.throws(() => loadRuntimeConfig({ ...base, SOLANA_USDC_MAINNET_MINT: mint, SOLANA_RPC_URL: RPC } as NodeJS.ProcessEnv), /SOLANA_USDC_MINT is required/, 'the deprecated variable is NOT a fallback');
  assert.throws(() => loadRuntimeConfig({ ...base, WALLET_CHAIN_MODE: 'sandbox', SOLANA_RPC_URL: RPC, SOLANA_USDC_MINT: mint } as NodeJS.ProcessEnv), /real RPC adapter/);
});
