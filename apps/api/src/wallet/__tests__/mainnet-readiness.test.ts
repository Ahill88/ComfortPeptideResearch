import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { PaymentsService } from '../../payments/payments.service';
import { PrismaService } from '../../prisma.service';
import { usdcMintOf, usdcMintOrNull } from '../chain/chain.types';
import { SandboxSolanaChain } from '../chain/sandbox-solana-chain';
import { USDC_DEVNET_MINT, type WalletFeatureFlags } from '../contracts';
import { CreditsService } from '../credits.service';
import { buildNetworkInfo, NetworkInfoController } from '../network-info.controller';
import { InMemoryPreparedTransactionStore } from '../transfers/prepared-transaction.store';
import { AllowAllComplianceScreen } from '../transfers/compliance-screen';
import { TransfersService } from '../transfers/transfers.service';
import { describeWalletProvider, isSandboxProviderAllowed, SANDBOX_PROVIDER_REFUSED_MESSAGE } from '../wallet-providers';
import { WalletService } from '../wallet.service';
import { FLAGS, linkCustomer, linkRequest, makeConfig, makeHarness, rejection } from './helpers';

// The repo does not hard-code the mainnet mint (operators copy it from Circle), so tests use a generated stand-in.
const MAINNET_MINT = Keypair.generate().publicKey.toBase58();
const USDC = (n: number) => BigInt(n) * 1_000_000n;

/** A chain object that reports mainnet and its own mint but shares the sandbox's balances. */
function asMainnet(chain: SandboxSolanaChain, mint = MAINNET_MINT): SandboxSolanaChain {
  return Object.create(chain, { network: { value: 'solana-mainnet' }, usdcMint: { value: mint } });
}

// ---------------------------------------------------------------- one mint source
test('usdcMintOf: the chain mint wins; only devnet may fall back to the built-in mint; mainnet without one throws', () => {
  assert.equal(usdcMintOf({ network: 'solana-mainnet', usdcMint: MAINNET_MINT } as never), MAINNET_MINT);
  assert.equal(usdcMintOf({ network: 'solana-devnet', usdcMint: MAINNET_MINT } as never), MAINNET_MINT, 'a configured mint also overrides on devnet');
  assert.equal(usdcMintOf({ network: 'solana-devnet' } as never), USDC_DEVNET_MINT);
  assert.throws(() => usdcMintOf({ network: 'solana-mainnet' } as never), /No USDC mint is configured for solana-mainnet/);
  assert.equal(usdcMintOrNull({ network: 'solana-mainnet' } as never), null);
  assert.equal(usdcMintOrNull({ network: 'solana-devnet' } as never), USDC_DEVNET_MINT);
});

// ---------------------------------------------------------------- (h) sandbox provider
test('SANDBOX PROVIDER: linkable in development/test on devnet only', async () => {
  const dev = makeHarness();
  assert.equal((await linkCustomer(dev)).result.created, true);
  assert.equal(isSandboxProviderAllowed({ isProductionLike: false, solanaNetwork: 'solana-devnet' }), true);
  assert.equal(describeWalletProvider('sandbox', makeConfig()).active, true);
});

test('SANDBOX PROVIDER: refused with 400 and a clear message in a production-like runtime', async () => {
  for (const isProductionLike of [true, undefined as unknown as boolean]) {
    const h = makeHarness({ config: { isProductionLike } });
    const keypair = Keypair.generate();
    const err = await rejection(h.wallets.associateWallet('buyer@example.com', linkRequest(h, 'buyer@example.com', keypair)));
    assert.equal(err.status, 400);
    assert.equal(err.message, SANDBOX_PROVIDER_REFUSED_MESSAGE);
    assert.equal(h.prisma.customerWallet.rows.length, 0, 'nothing is stored');
    assert.equal(h.wallets.providerDescriptor('sandbox').active, false);
  }
});

test('SANDBOX PROVIDER: refused on mainnet, whether the config or the live chain says so', async () => {
  const byConfig = makeHarness({ config: { solanaNetwork: 'solana-mainnet' } });
  const err = await rejection(byConfig.wallets.associateWallet('b@example.com', linkRequest(byConfig, 'b@example.com', Keypair.generate())));
  assert.equal(err.status, 400);
  assert.equal(err.message, SANDBOX_PROVIDER_REFUSED_MESSAGE);

  const base = makeHarness();
  const onChain = new WalletService(base.db, asMainnet(base.chain), makeConfig()); // config says devnet, the live chain says mainnet
  const request = linkRequest({ ...base, wallets: onChain } as never, 'c@example.com', Keypair.generate());
  const err2 = await rejection(onChain.associateWallet('c@example.com', request));
  assert.equal(err2.status, 400);
  assert.equal(err2.message, SANDBOX_PROVIDER_REFUSED_MESSAGE);
});

test('SANDBOX PROVIDER: wallets already linked stay readable (descriptor inactive, not an error)', async () => {
  const h = makeHarness({ config: { isProductionLike: true } });
  const { customer } = await linkCustomer(h); // seeds the row like an earlier link would have
  const view = await h.wallets.getWallet('buyer@example.com');
  assert.equal(view.wallet.provider, 'sandbox');
  assert.equal(view.provider.active, false);
  void customer;
});

// ---------------------------------------------------------------- (f) network-scoped balances
async function seedMixed(h: ReturnType<typeof makeHarness>, customerId: string, address: string) {
  const t = h.prisma.cryptoTransaction;
  const row = (over: Record<string, unknown>) => t.create({ data: { customerId, status: 'SUBMITTED', amountAtomic: 0n, sourceAddress: address, destinationAddress: 'x', mint: 'm', txSignature: null, ...over } });
  await row({ type: 'PURCHASE', network: 'solana-devnet', amountAtomic: USDC(5), reference: 'd1', orderId: 'oD1' });
  await row({ type: 'PURCHASE', network: 'solana-mainnet', amountAtomic: USDC(40), reference: 'm1', orderId: 'oM1' });
  await row({ type: 'WITHDRAWAL', network: 'solana-mainnet', amountAtomic: USDC(30), reference: 'm2' });
  await row({ type: 'WITHDRAWAL', network: 'solana-devnet', amountAtomic: USDC(2), reference: 'd2' });
  const soon = new Date(Date.now() + 60_000);
  const reserve = (orderId: string, amountAtomic: bigint) => h.prisma.creditReservation.create({ data: { customerId, orderId, amountAtomic, expiresAt: soon } });
  // reservations carry no network of their own: it is the network of the order's LATEST purchase row
  await reserve('oA', USDC(10)); await row({ type: 'PURCHASE', status: 'PREPARED', network: 'solana-devnet', reference: 'pa', orderId: 'oA' });
  await reserve('oB', USDC(20)); await row({ type: 'PURCHASE', status: 'PREPARED', network: 'solana-mainnet', reference: 'pb', orderId: 'oB' });
  await reserve('oC', USDC(4));
  await row({ type: 'PURCHASE', status: 'EXPIRED', network: 'solana-mainnet', reference: 'pc1', orderId: 'oC', createdAt: new Date(2026, 0, 1) });
  await row({ type: 'PURCHASE', status: 'PREPARED', network: 'solana-devnet', reference: 'pc2', orderId: 'oC', createdAt: new Date(2026, 0, 2) });
  await reserve('oE', USDC(8)); // no purchase row at all: cannot be attributed, kept (lowers spendable only)
  await reserve('oF', USDC(100));
  await row({ type: 'PURCHASE', status: 'PREPARED', network: 'solana-mainnet', reference: 'pf1', orderId: 'oF', createdAt: new Date(2026, 0, 1) });
  await row({ type: 'PURCHASE', status: 'EXPIRED', network: 'solana-devnet', reference: 'pf2', orderId: 'oF', createdAt: new Date(2026, 0, 2) });
  await row({ type: 'PURCHASE', status: 'PREPARED', network: 'solana-mainnet', reference: 'pf3', orderId: 'oF', createdAt: new Date(2026, 0, 3) });
}

test('NETWORK-SCOPED: on devnet only devnet pending rows and devnet-attributed reservations reduce spendable', async () => {
  const h = makeHarness();
  const { customer, address } = await linkCustomer(h);
  h.chain.creditUsdc(address, USDC(1000));
  await seedMixed(h, customer.id, address);
  const balance = await h.credits.getBalance(customer.id);
  assert.equal(balance.pendingOutgoingAtomic, USDC(5) + USDC(2), 'only the two devnet pending rows');
  // oA (devnet) 10 + oC (latest row devnet) 4 + oE (unattributed) 8; oB and oF (latest row mainnet) are ignored. oD1's reservation does not exist.
  assert.equal(balance.activeReservationsAtomic, USDC(10) + USDC(4) + USDC(8));
  assert.equal(balance.spendableAtomic, USDC(1000) - USDC(7) - USDC(22));
});

test('NETWORK-SCOPED: seen from mainnet the same rows split the other way, and devnet rows never touch the mainnet balance', async () => {
  const h = makeHarness();
  const { customer, address } = await linkCustomer(h);
  await seedMixed(h, customer.id, address);
  // Same wallet, now a mainnet deployment: the link row says mainnet (as a real mainnet link would).
  h.prisma.customerWallet.rows[0].network = 'solana-mainnet';
  h.prisma.customerWallet.rows[0].provider = 'privy';
  h.chain.creditUsdc(address, USDC(1000));
  const credits = new CreditsService(h.db, asMainnet(h.chain));
  const balance = await credits.getBalance(customer.id);
  assert.equal(balance.network, 'solana-mainnet');
  assert.equal(balance.mint, MAINNET_MINT);
  assert.equal(balance.pendingOutgoingAtomic, USDC(40) + USDC(30), 'only the two mainnet pending rows');
  assert.equal(balance.activeReservationsAtomic, USDC(20) + USDC(100) + USDC(8), 'oB, oF (latest row mainnet) and the unattributed oE; oA and oC are devnet');
  assert.equal(balance.spendableAtomic, USDC(1000) - USDC(70) - USDC(128));
});

test('NETWORK-SCOPED: a wallet linked under another network is not spendable here (notice, zero), and checkout would 409 too', async () => {
  const h = makeHarness();
  const { customer, address } = await linkCustomer(h); // linked on devnet
  h.chain.creditUsdc(address, USDC(50));
  const credits = new CreditsService(h.db, asMainnet(h.chain));
  const balance = await credits.getBalance(customer.id);
  assert.equal(balance.hasWallet, true);
  assert.equal(balance.stale, false);
  assert.equal(balance.spendableAtomic, 0n);
  assert.equal(balance.finalizedAtomic, 0n);
  assert.match(balance.notice ?? '', /different network/);
  assert.equal((await h.credits.getBalance(customer.id)).spendableAtomic, USDC(50), 'unchanged on its own network');
});

// ---------------------------------------------------------------- (g) transfers gating
async function mainnetTransfers(flags: Partial<WalletFeatureFlags> | undefined, readiness?: { isReady(): boolean; reason(): string }) {
  const h = makeHarness();
  const chain = asMainnet(h.chain);
  const config = makeConfig({ solanaNetwork: 'solana-mainnet', usdcMint: MAINNET_MINT });
  const wallets = new WalletService(h.db, chain, config);
  const credits = new CreditsService(h.db, chain);
  const customer = await wallets.resolveCustomer('buyer@example.com');
  const owner = Keypair.generate().publicKey.toBase58();
  await h.prisma.customerWallet.create({ data: { customerId: customer.id, address: owner, provider: 'privy', network: 'solana-mainnet' } });
  h.chain.creditUsdc(owner, USDC(100));
  const transfers = new TransfersService(
    h.db, credits, wallets, chain, new InMemoryPreparedTransactionStore(), new AllowAllComplianceScreen(),
    flags === undefined ? undefined : { ...FLAGS, ...flags }, readiness,
  );
  return { h, transfers, customer, owner };
}
const destination = () => Keypair.generate().publicKey.toBase58();

test('MAINNET GATING (transfers): the mainnet flag alone is not enough; ENABLE_LIVE_CRYPTO_PAYMENTS is required', async () => {
  const none = await mainnetTransfers(undefined);
  const a = await rejection(none.transfers.prepare(none.customer.id, { destination: destination(), amountAtomic: '1000000' }));
  assert.equal(a.status, 409);
  assert.match(a.message, /mainnet is disabled/);

  const flagOnly = await mainnetTransfers({ enableSolanaMainnet: true });
  const b = await rejection(flagOnly.transfers.prepare(flagOnly.customer.id, { destination: destination(), amountAtomic: '1000000' }));
  assert.equal(b.status, 409);
  assert.match(b.message, /Live crypto payments are disabled/);
  assert.equal(flagOnly.h.prisma.cryptoTransaction.rows.length, 0, 'no PREPARED row was written');

  const liveOnly = await mainnetTransfers({ enableLiveCryptoPayments: true });
  assert.match((await rejection(liveOnly.transfers.prepare(liveOnly.customer.id, { destination: destination(), amountAtomic: '1' }))).message, /mainnet is disabled/);

  const both = await mainnetTransfers({ enableSolanaMainnet: true, enableLiveCryptoPayments: true });
  const prepared = await both.transfers.prepare(both.customer.id, { destination: destination(), amountAtomic: '1000000' });
  assert.equal(prepared.mint, MAINNET_MINT, 'transfers use the one configured mint');
  assert.equal(both.h.prisma.cryptoTransaction.rows[0].network, 'solana-mainnet');
  assert.equal(both.h.prisma.cryptoTransaction.rows[0].mint, MAINNET_MINT);
});

test('MAINNET GATING (transfers): submit is gated too, before anything is looked up', async () => {
  const flagOnly = await mainnetTransfers({ enableSolanaMainnet: true });
  const err = await rejection(flagOnly.transfers.submit(flagOnly.customer.id, 'does-not-exist', 'AAAA'));
  assert.equal(err.status, 409);
  assert.match(err.message, /Live crypto payments are disabled/);
});

test('transfers: devnet and the sandbox need no live flags', async () => {
  const h = makeHarness();
  const { customer, address } = await linkCustomer(h);
  h.chain.creditUsdc(address, USDC(10));
  const prepared = await h.transfers.prepare(customer.id, { destination: destination(), amountAtomic: '1000000' });
  assert.equal(prepared.mint, USDC_DEVNET_MINT);
});

test('chain preflight gates transfers: not ready is 503 with a generic message, ready proceeds', async () => {
  const state = { ready: false };
  const readiness = { isReady: () => state.ready, reason: () => 'genesis hash mismatch (internal detail)' };
  const w = await mainnetTransfers({ enableSolanaMainnet: true, enableLiveCryptoPayments: true }, readiness);
  const err = await rejection(w.transfers.prepare(w.customer.id, { destination: destination(), amountAtomic: '1000000' }));
  assert.equal(err.status, 503);
  assert.doesNotMatch(err.message, /genesis|internal/);
  state.ready = true;
  assert.ok(await w.transfers.prepare(w.customer.id, { destination: destination(), amountAtomic: '1000000' }));
});

// ---------------------------------------------------------------- (7) network info
test('network-info body: devnet and mainnet, livePayments needs mainnet + both flags + a passed preflight', () => {
  const on = { enableSolanaMainnet: true, enableLiveCryptoPayments: true };
  assert.deepEqual(buildNetworkInfo({ network: 'solana-devnet', usdcMint: USDC_DEVNET_MINT, flags: on, chainReady: true }), {
    network: 'solana-devnet',
    usdcMint: USDC_DEVNET_MINT,
    explorerTxBase: 'https://explorer.solana.com/tx/',
    explorerClusterQuery: '?cluster=devnet',
    livePayments: false,
  });
  const main = (flags: Partial<typeof on>, chainReady = true) => buildNetworkInfo({ network: 'solana-mainnet', usdcMint: MAINNET_MINT, flags: { enableSolanaMainnet: false, enableLiveCryptoPayments: false, ...flags }, chainReady });
  assert.equal(main(on).explorerClusterQuery, '');
  assert.equal(main(on).livePayments, true);
  assert.equal(main({ enableSolanaMainnet: true }).livePayments, false);
  assert.equal(main({ enableLiveCryptoPayments: true }).livePayments, false);
  assert.equal(main(on, false).livePayments, false);
});

test('network-info controller: reports the chain actually in use, sets Cache-Control, caches 60 s', () => {
  const chain = asMainnet(new SandboxSolanaChain());
  const flags = { ...FLAGS, enableSolanaMainnet: true, enableLiveCryptoPayments: true };
  const state = { ready: true };
  const controller = new NetworkInfoController(chain, flags, { isReady: () => state.ready } as never);
  let now = 1_000_000;
  controller.clock = () => now;
  const headers: Record<string, string> = {};
  const res = { setHeader: (name: string, value: string | number) => { headers[name] = String(value); } };
  const first = controller.networkInfo(res);
  assert.equal(first.network, 'solana-mainnet');
  assert.equal(first.usdcMint, MAINNET_MINT);
  assert.equal(first.livePayments, true);
  assert.equal(headers['Cache-Control'], 'public, max-age=60');
  assert.doesNotMatch(JSON.stringify(first), /http(s)?:\/\/(?!explorer\.solana\.com)/, 'no RPC URL in the body');
  state.ready = false;
  now += 59_000;
  assert.equal(controller.networkInfo(res), first, 'served from the 60 s cache');
  now += 2_000;
  assert.equal(controller.networkInfo(res).livePayments, false, 'recomputed after 60 s');
});

// ---------------------------------------------------------------- (6) legacy payments path
test('legacy payment intents never hand out the devnet mint for a non-devnet configuration', async () => {
  const saved = { net: process.env.SOLANA_NETWORK, mint: process.env.SOLANA_USDC_MINT, treasury: process.env.SOLANA_USDC_TREASURY };
  const treasury = Keypair.generate().publicKey.toBase58();
  const prisma = {
    order: { findUnique: async () => ({ id: 'o1', totalCents: 1000, status: 'PENDING_PAYMENT', researchAcknowledgedAt: new Date() }) },
    payment: {
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'p1', ...data }),
    },
  };
  const service = new PaymentsService(prisma as unknown as PrismaService, {} as never);
  try {
    process.env.SOLANA_USDC_TREASURY = treasury;
    process.env.SOLANA_NETWORK = 'solana-mainnet';
    const err = await rejection(service.createIntent('o1', 'solana-usdc'));
    assert.equal(err.status, 503);
    assert.match(err.message, /devnet only/);
    delete process.env.SOLANA_NETWORK;
    delete process.env.SOLANA_USDC_MINT;
    assert.equal((await service.createIntent('o1', 'solana-usdc')).mint, USDC_DEVNET_MINT);
    process.env.SOLANA_USDC_MINT = MAINNET_MINT;
    assert.equal((await service.createIntent('o1', 'solana-usdc')).mint, MAINNET_MINT, 'the configured mint wins over the literal');
  } finally {
    for (const [key, value] of [['SOLANA_NETWORK', saved.net], ['SOLANA_USDC_MINT', saved.mint], ['SOLANA_USDC_TREASURY', saved.treasury]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
