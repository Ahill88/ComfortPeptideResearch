import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { MINT_SIZE, MintLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';
import { USDC_DEVNET_MINT } from '../../contracts';
import { SOLANA_GENESIS_HASHES, type WalletRuntimeConfig } from '../../wallet.config';
import { ChainPreflight, type PreflightConnection } from '../chain-preflight';

const MAINNET_STAND_IN_MINT = Keypair.generate().publicKey.toBase58(); // the repo does not hard-code the mainnet mint

function mintData(opts: { decimals?: number; initialized?: boolean; mintAuthority?: boolean; freezeAuthority?: boolean; length?: number } = {}): Buffer {
  const buffer = Buffer.alloc(opts.length ?? MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: opts.mintAuthority === false ? 0 : 1,
      mintAuthority: PublicKey.default,
      supply: 0n,
      decimals: opts.decimals ?? 6,
      isInitialized: opts.initialized ?? true,
      freezeAuthorityOption: opts.freezeAuthority === false ? 0 : 1,
      freezeAuthority: PublicKey.default,
    },
    buffer,
  );
  return buffer;
}

interface FakeOptions {
  genesis?: string | Error;
  account?: null | { owner?: PublicKey; data?: Buffer } | Error;
}
class FakeConnection {
  calls: string[] = [];
  constructor(public opts: FakeOptions = {}) {}
  async getGenesisHash() {
    this.calls.push('genesis');
    const value = this.opts.genesis ?? SOLANA_GENESIS_HASHES['solana-devnet'];
    if (value instanceof Error) throw value;
    return value;
  }
  async getAccountInfo(_key: PublicKey) {
    this.calls.push('account');
    const value = this.opts.account === undefined ? { owner: TOKEN_PROGRAM_ID, data: mintData() } : this.opts.account;
    if (value instanceof Error) throw value;
    if (value === null) return null;
    return { owner: value.owner ?? TOKEN_PROGRAM_ID, data: value.data ?? mintData(), executable: false, lamports: 1 };
  }
}

const config = (over: Partial<WalletRuntimeConfig> = {}): WalletRuntimeConfig => ({
  chainMode: 'devnet',
  isProductionLike: false,
  isProduction: false,
  solanaRpcUrl: 'https://rpc.invalid',
  solanaNetwork: 'solana-devnet',
  usdcMint: USDC_DEVNET_MINT,
  treasuryAddress: null,
  moonpayPublishableKey: null,
  moonpaySigningSecret: null,
  privyAppId: null,
  ...over,
});
const make = (conn: FakeConnection, over: Partial<WalletRuntimeConfig> = {}, retryMs = 5) =>
  new ChainPreflight(config(over), { connection: conn as unknown as PreflightConnection, retryMs, callTimeoutMs: 200 });

test('genesis constants are the two distinct public cluster hashes (32-byte base58)', () => {
  assert.equal(SOLANA_GENESIS_HASHES['solana-devnet'], 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
  assert.equal(SOLANA_GENESIS_HASHES['solana-mainnet'], '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
  for (const hash of Object.values(SOLANA_GENESIS_HASHES)) assert.equal(new PublicKey(hash).toBytes().length, 32);
});

test('sandbox chain: skipped and ready, the connection is never touched', async () => {
  const conn = new FakeConnection();
  const pre = make(conn, { chainMode: 'sandbox' });
  await pre.onModuleInit();
  assert.equal(pre.getState(), 'skipped');
  assert.equal(pre.isReady(), true);
  assert.deepEqual(conn.calls, []);
});

test('not ready before the first check', () => {
  const pre = make(new FakeConnection());
  assert.equal(pre.getState(), 'pending');
  assert.equal(pre.isReady(), false);
});

test('devnet: matching genesis and a valid USDC mint pass; authority presence is not a failure', async () => {
  for (const flags of [{}, { mintAuthority: false, freezeAuthority: false }]) {
    const pre = make(new FakeConnection({ account: { data: mintData(flags) } }));
    await pre.onModuleInit();
    assert.equal(pre.getState(), 'passed');
    assert.equal(pre.isReady(), true);
    assert.equal(pre.reason(), '');
  }
});

test('mainnet config passes only against the mainnet genesis hash', async () => {
  const cfg = { solanaNetwork: 'solana-mainnet' as const, usdcMint: MAINNET_STAND_IN_MINT };
  const ok = make(new FakeConnection({ genesis: SOLANA_GENESIS_HASHES['solana-mainnet'] }), cfg);
  await ok.onModuleInit();
  assert.equal(ok.getState(), 'passed');
  // The devnet cluster behind a mainnet configuration (the classic silent mistake) refuses to start.
  const wrong = make(new FakeConnection({ genesis: SOLANA_GENESIS_HASHES['solana-devnet'] }), cfg);
  await assert.rejects(() => wrong.onModuleInit(), /genesis hash.*expects 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d/);
  assert.equal(wrong.isReady(), false);
});

test('GENESIS GUARD: a devnet configuration on any other cluster refuses to start, and the mint is never read', async () => {
  const conn = new FakeConnection({ genesis: SOLANA_GENESIS_HASHES['solana-mainnet'] });
  const pre = make(conn);
  await assert.rejects(() => pre.onModuleInit(), /refusing to start.*SOLANA_RPC_URL does not serve solana-devnet/);
  assert.equal(pre.getState(), 'failed');
  assert.equal(pre.isReady(), false);
  assert.deepEqual(conn.calls, ['genesis'], 'no further RPC reads once the cluster is wrong');
  // A garbage hash is also refused.
  await assert.rejects(() => make(new FakeConnection({ genesis: 'not-a-genesis' })).onModuleInit(), /genesis hash/);
});

test('mint checks: missing account, wrong owner program, Token-2022, not a mint, uninitialized, wrong decimals', async () => {
  const cases: Array<[string, FakeOptions['account'], RegExp]> = [
    ['missing', null, /does not exist/],
    ['wrong owner', { owner: Keypair.generate().publicKey }, /not the SPL Token program/],
    ['token-2022', { owner: TOKEN_2022_PROGRAM_ID }, /Token-2022/],
    ['too short', { data: Buffer.alloc(40) }, /not a token mint/],
    ['uninitialized', { data: mintData({ initialized: false }) }, /not initialized/],
    ['decimals 9', { data: mintData({ decimals: 9 }) }, /9 decimals, expected 6/],
    ['decimals 0', { data: mintData({ decimals: 0 }) }, /0 decimals, expected 6/],
  ];
  for (const [name, account, pattern] of cases) {
    const pre = make(new FakeConnection({ account }));
    await assert.rejects(() => pre.onModuleInit(), pattern, name);
    assert.equal(pre.getState(), 'failed', name);
    assert.equal(pre.isReady(), false, name);
  }
});

test('an invalid or absent mint in the config is a definitive failure', async () => {
  await assert.rejects(() => make(new FakeConnection(), { usdcMint: 'not-base58-0OIl' }).onModuleInit(), /not a valid base58/);
  await assert.rejects(() => make(new FakeConnection(), { usdcMint: null }).onModuleInit(), /no USDC mint/);
});

test('unreachable RPC at boot starts DEGRADED (not ready), then recovers on the timer', async () => {
  const conn = new FakeConnection({ genesis: new Error('connect ECONNREFUSED https://rpc.example/key-1234') });
  const pre = make(conn);
  await pre.onModuleInit(); // must not throw
  assert.equal(pre.getState(), 'degraded');
  assert.equal(pre.isReady(), false);
  assert.match(pre.reason(), /could not be read/);
  assert.doesNotMatch(pre.reason(), /key-1234|https?:/, 'an RPC URL (which may carry a provider key) never reaches the reason');
  conn.opts.genesis = SOLANA_GENESIS_HASHES['solana-devnet'];
  const deadline = Date.now() + 2000;
  while (!pre.isReady() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(pre.getState(), 'passed');
  pre.onModuleDestroy();
});

test('timer re-check that finds a definitive failure stays not ready and stops retrying', async () => {
  const conn = new FakeConnection({ genesis: new Error('timeout') });
  const pre = make(conn);
  await pre.onModuleInit();
  assert.equal(pre.getState(), 'degraded');
  conn.opts.genesis = SOLANA_GENESIS_HASHES['solana-mainnet']; // the endpoint now answers, as the WRONG cluster
  const deadline = Date.now() + 2000;
  while (pre.getState() === 'degraded' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(pre.getState(), 'failed');
  assert.equal(pre.isReady(), false);
  const seen = conn.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(conn.calls.length, seen, 'no further checks after a definitive failure');
  pre.onModuleDestroy();
});

test('a hanging RPC call times out into degraded instead of blocking boot', async () => {
  const hanging = { getGenesisHash: () => new Promise<string>(() => undefined), getAccountInfo: async () => null } as unknown as PreflightConnection;
  const pre = new ChainPreflight(config(), { connection: hanging, retryMs: 10_000, callTimeoutMs: 20 });
  await pre.onModuleInit();
  assert.equal(pre.getState(), 'degraded');
  assert.match(pre.reason(), /timed out/);
  pre.onModuleDestroy();
});

test('onModuleDestroy cancels the retry timer', async () => {
  const conn = new FakeConnection({ genesis: new Error('down') });
  const pre = make(conn, {}, 5);
  await pre.onModuleInit();
  pre.onModuleDestroy();
  const seen = conn.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(conn.calls.length, seen);
});
