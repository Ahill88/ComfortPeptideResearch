import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { USDC_DEVNET_MINT } from '../../contracts';
import { CheckoutService } from '../checkout.service';
import { VerificationService } from '../verification.service';
import type { BalancePort, ChainReadinessPort, WalletLookupPort } from '../ports';
import { CUSTOMER_ID, ORDER_ID, makeHarness, signAs, transferFor } from './harness';

// The repo does not hard-code the mainnet mint; operators record it in SOLANA_USDC_MINT. Tests use a generated stand-in.
const MAINNET_MINT = Keypair.generate().publicKey.toBase58();

/** The harness, re-pointed at "mainnet": chain network + chain.usdcMint, both live flags, a mainnet wallet link. */
function mainnetWorld(opts: { flags?: { mainnet?: boolean; live?: boolean }; mint?: string | null; readiness?: ChainReadinessPort } = {}) {
  const h = makeHarness();
  h.chain.network = 'solana-mainnet';
  if (opts.mint !== null) (h.chain as unknown as { usdcMint: string }).usdcMint = opts.mint ?? MAINNET_MINT;
  h.flags.enableSolanaMainnet = opts.flags?.mainnet ?? true;
  h.flags.enableLiveCryptoPayments = opts.flags?.live ?? true;
  const wallets: WalletLookupPort = { getWallet: async (id) => (id === CUSTOMER_ID ? { address: h.customer.publicKey.toBase58(), network: 'solana-mainnet' } : null) };
  const balances: BalancePort = { getSpendable: async () => ({ finalizedAtomic: 1_000_000_000n, spendableAtomic: 1_000_000_000n, researchCredits: 1000n, stale: false }) };
  const checkout = new CheckoutService(h.prisma as never, h.chain, balances, wallets, h.flags, h.store, h.config, undefined, undefined, opts.readiness);
  const verification = new VerificationService(h.prisma as never, h.chain, h.flags, { trigger: async () => undefined });
  return { h, checkout, verification };
}

async function submitted(w: ReturnType<typeof mainnetWorld>) {
  const prepared = await w.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  const sub = await w.checkout.submit(CUSTOMER_ID, ORDER_ID, signAs(prepared.unsignedTransactionBase64, w.h.customer));
  return { prepared, signature: sub.txSignature };
}

test('mainnet: prepare uses chain.usdcMint (the one mint source), records network and mint on the purchase row', async () => {
  const w = mainnetWorld();
  const prepared = await w.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  assert.equal(prepared.network, 'solana-mainnet');
  assert.equal(prepared.mint, MAINNET_MINT);
  assert.notEqual(prepared.mint, USDC_DEVNET_MINT);
  assert.equal(w.h.prisma.txs[0].mint, MAINNET_MINT);
  assert.equal(w.h.prisma.txs[0].network, 'solana-mainnet');
});

test('mainnet: a chain with no configured mint refuses to prepare (never falls back to the devnet mint)', async () => {
  const w = mainnetWorld({ mint: null });
  await assert.rejects(() => w.checkout.prepare(CUSTOMER_ID, ORDER_ID), (e: any) => e.getStatus?.() === 409 && /USDC mint is not configured/.test(e.message));
  assert.equal(w.h.prisma.reservations.length, 0);
});

test('mainnet: verification settles a finalized transfer of the configured mint (it no longer fails as "wrong mint")', async () => {
  const w = mainnetWorld();
  const { prepared, signature } = await submitted(w);
  w.h.chain.transfers.set(signature, transferFor(w.h, prepared, signature, { network: 'solana-mainnet', mint: MAINNET_MINT }));
  const result = await w.verification.verifyAndSettle({ paymentReference: prepared.paymentReference });
  assert.equal(result.outcome, 'FINALIZED');
  assert.equal(w.h.prisma.orders[0].status, 'PAID');
});

test('MINT EQUALITY: a transfer of any other mint (the devnet mint included) fails as wrong mint on mainnet', async () => {
  for (const other of [USDC_DEVNET_MINT, Keypair.generate().publicKey.toBase58()]) {
    const w = mainnetWorld();
    const { prepared, signature } = await submitted(w);
    w.h.chain.transfers.set(signature, transferFor(w.h, prepared, signature, { network: 'solana-mainnet', mint: other }));
    const result = await w.verification.verifyAndSettle({ paymentReference: prepared.paymentReference });
    assert.equal(result.outcome, 'FAILED');
    assert.match(result.reason ?? '', /wrong mint/);
    assert.equal(w.h.prisma.orders[0].status, 'PENDING_PAYMENT');
  }
});

test('MINT EQUALITY: a purchase row that does not carry the chain mint cannot settle even when the transfer matches the row', async () => {
  // e.g. a row prepared before a mint change, or tampered: row and transfer agree with each other, but not with the configured mint.
  const devnetWorld = () => {
    const h = makeHarness();
    (h.chain as unknown as { usdcMint: string }).usdcMint = Keypair.generate().publicKey.toBase58();
    return { h, checkout: h.checkout, verification: h.verification };
  };
  for (const world of [mainnetWorld(), devnetWorld()]) {
    const prepared = await world.checkout.prepare(CUSTOMER_ID, ORDER_ID);
    const sub = await world.checkout.submit(CUSTOMER_ID, ORDER_ID, signAs(prepared.unsignedTransactionBase64, world.h.customer));
    const rogue = Keypair.generate().publicKey.toBase58();
    world.h.prisma.txs[0].mint = rogue;
    world.h.chain.transfers.set(sub.txSignature, transferFor(world.h, prepared, sub.txSignature, { network: world.h.chain.network, mint: rogue }));
    const result = await world.verification.verifyAndSettle({ paymentReference: prepared.paymentReference });
    assert.equal(result.outcome, 'FAILED', world.h.chain.network);
    assert.match(result.reason ?? '', /wrong mint/);
    assert.equal(world.h.prisma.orders[0].status, 'PENDING_PAYMENT');
  }
});

test('devnet with a configured SOLANA_USDC_MINT: the devnet literal is no longer an acceptable mint', async () => {
  const custom = Keypair.generate().publicKey.toBase58();
  const h = makeHarness();
  (h.chain as unknown as { usdcMint: string }).usdcMint = custom;
  const prepared = await h.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  assert.equal(prepared.mint, custom);
  const sub = await h.checkout.submit(CUSTOMER_ID, ORDER_ID, signAs(prepared.unsignedTransactionBase64, h.customer));
  h.prisma.txs[0].mint = USDC_DEVNET_MINT; // pretend the row carries the old literal
  h.chain.transfers.set(sub.txSignature, transferFor(h, prepared, sub.txSignature, { mint: USDC_DEVNET_MINT }));
  const result = await h.verification.verifyAndSettle({ paymentReference: prepared.paymentReference });
  assert.equal(result.outcome, 'FAILED');
  assert.match(result.reason ?? '', /wrong mint/);
});

test('MAINNET GATING (checkout): both flags are required on prepare and on submit', async () => {
  const noMainnet = mainnetWorld({ flags: { mainnet: false, live: true } });
  await assert.rejects(() => noMainnet.checkout.prepare(CUSTOMER_ID, ORDER_ID), (e: any) => e.getStatus?.() === 409 && /mainnet is disabled/.test(e.message));
  const noLive = mainnetWorld({ flags: { mainnet: true, live: false } });
  await assert.rejects(() => noLive.checkout.prepare(CUSTOMER_ID, ORDER_ID), (e: any) => e.getStatus?.() === 409 && /Live crypto payments are disabled/.test(e.message));
  assert.equal(noLive.h.prisma.reservations.length, 0);

  // A payment prepared while live, then the flag is switched off: submit is refused and nothing is broadcast.
  const w = mainnetWorld();
  const prepared = await w.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  w.h.flags.enableLiveCryptoPayments = false;
  await assert.rejects(() => w.checkout.submit(CUSTOMER_ID, ORDER_ID, signAs(prepared.unsignedTransactionBase64, w.h.customer)), (e: any) => e.getStatus?.() === 409);
  assert.equal(w.h.chain.broadcasts.length, 0);
});

test('chain preflight gates checkout: not ready is 503 (generic message) on prepare and submit; nothing reserved or broadcast', async () => {
  const state = { ready: false };
  const w = mainnetWorld({ readiness: { isReady: () => state.ready, reason: () => 'genesis hash mismatch (internal detail)' } });
  await assert.rejects(() => w.checkout.prepare(CUSTOMER_ID, ORDER_ID), (e: any) => e.getStatus?.() === 503 && !/genesis|internal/.test(e.message));
  assert.equal(w.h.prisma.reservations.length, 0);
  state.ready = true;
  const prepared = await w.checkout.prepare(CUSTOMER_ID, ORDER_ID);
  state.ready = false;
  await assert.rejects(() => w.checkout.submit(CUSTOMER_ID, ORDER_ID, signAs(prepared.unsignedTransactionBase64, w.h.customer)), (e: any) => e.getStatus?.() === 503);
  assert.equal(w.h.chain.broadcasts.length, 0);
  state.ready = true;
  assert.equal((await w.checkout.submit(CUSTOMER_ID, ORDER_ID, signAs(prepared.unsignedTransactionBase64, w.h.customer))).status, 'SUBMITTED');
});

test('a wallet linked under another network is refused with 409 on mainnet (existing rule, unchanged)', async () => {
  const w = mainnetWorld();
  const wrongNetwork: WalletLookupPort = { getWallet: async () => ({ address: w.h.customer.publicKey.toBase58(), network: 'solana-devnet' }) };
  const balances: BalancePort = { getSpendable: async () => ({ finalizedAtomic: 1n << 40n, spendableAtomic: 1n << 40n, researchCredits: 1n, stale: false }) };
  const checkout = new CheckoutService(w.h.prisma as never, w.h.chain, balances, wrongNetwork, w.h.flags, w.h.store, w.h.config);
  await assert.rejects(() => checkout.prepare(CUSTOMER_ID, ORDER_ID), (e: any) => e.getStatus?.() === 409 && /network does not match/.test(e.message));
});
