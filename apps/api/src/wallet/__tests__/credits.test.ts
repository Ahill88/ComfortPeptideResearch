import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { linkCustomer, makeHarness } from './helpers';

test('credits floor fractional balances and spendable stays exact', async () => {
  const h = makeHarness();
  const { customer, address } = await linkCustomer(h);
  h.chain.creditUsdc(address, 1_999_999n);
  const balance = await h.credits.getBalance(customer.id);
  assert.equal(balance.finalizedAtomic, 1_999_999n);
  assert.equal(balance.spendableAtomic, 1_999_999n);
  assert.equal(balance.researchCredits, 1n);
  assert.equal(balance.stale, false);
  h.chain.creditUsdc(address, 1n);
  assert.equal((await h.credits.getBalance(customer.id)).researchCredits, 2n);
});

test('zero and sub-1-USDC balances give 0 credits', async () => {
  const h = makeHarness();
  const { customer, address } = await linkCustomer(h);
  assert.equal((await h.credits.getBalance(customer.id)).researchCredits, 0n);
  h.chain.creditUsdc(address, 999_999n);
  assert.equal((await h.credits.getBalance(customer.id)).researchCredits, 0n);
});

test('pending SUBMITTED/CONFIRMED outgoing and active reservations are subtracted; others are not', async () => {
  const h = makeHarness();
  const { customer, address } = await linkCustomer(h);
  h.chain.creditUsdc(address, 100_000_000n);
  const base = { customerId: customer.id, sourceAddress: address, destinationAddress: 'x', mint: 'm', network: 'solana-devnet' };
  let n = 0;
  const tx = (type: string, status: string, amountAtomic: bigint) =>
    h.prisma.cryptoTransaction.create({ data: { ...base, type, status, amountAtomic, reference: `ref${++n}` } });
  await tx('WITHDRAWAL', 'SUBMITTED', 10_000_000n); // counts
  await tx('PURCHASE', 'CONFIRMED', 5_000_000n); // counts
  await tx('WITHDRAWAL', 'PREPARED', 50_000_000n); // does not count
  await tx('WITHDRAWAL', 'FINALIZED', 50_000_000n); // already in chain balance
  await tx('WITHDRAWAL', 'FAILED', 50_000_000n);
  await tx('DEPOSIT', 'SUBMITTED', 50_000_000n); // incoming is never subtracted
  const future = new Date(Date.now() + 60_000);
  const past = new Date(Date.now() - 60_000);
  let o = 0;
  const reservation = (status: string, expiresAt: Date, amountAtomic: bigint) =>
    h.prisma.creditReservation.create({ data: { customerId: customer.id, orderId: `o${++o}`, amountAtomic, status, expiresAt } });
  await reservation('ACTIVE', future, 20_000_000n); // counts
  await reservation('ACTIVE', past, 40_000_000n); // expired
  await reservation('RELEASED', future, 40_000_000n);
  await reservation('CONSUMED', future, 40_000_000n);

  const balance = await h.credits.getBalance(customer.id);
  assert.equal(balance.pendingOutgoingAtomic, 15_000_000n);
  assert.equal(balance.activeReservationsAtomic, 20_000_000n);
  assert.equal(balance.spendableAtomic, 65_000_000n);
  assert.equal(balance.researchCredits, 65n);
});

test('spendable never goes negative when pending exceeds the chain balance', async () => {
  const h = makeHarness();
  const { customer, address } = await linkCustomer(h);
  h.chain.creditUsdc(address, 1_000_000n);
  await h.prisma.cryptoTransaction.create({
    data: { customerId: customer.id, type: 'WITHDRAWAL', status: 'SUBMITTED', amountAtomic: 9_000_000n, sourceAddress: address, destinationAddress: 'x', mint: 'm', network: 'solana-devnet', reference: 'r1' },
  });
  const balance = await h.credits.getBalance(customer.id);
  assert.equal(balance.spendableAtomic, 0n);
  assert.equal(balance.researchCredits, 0n);
});

test('chain outage fails closed: stale and spendable 0, never a cached higher value', async () => {
  const h = makeHarness();
  const { customer, address } = await linkCustomer(h);
  h.chain.creditUsdc(address, 50_000_000n);
  assert.equal((await h.credits.getBalance(customer.id)).spendableAtomic, 50_000_000n);
  h.chain.setOutage(true);
  const stale = await h.credits.getBalance(customer.id);
  assert.equal(stale.stale, true);
  assert.equal(stale.spendableAtomic, 0n);
  assert.equal(stale.researchCredits, 0n);
  assert.equal(stale.finalizedAtomic, 0n);
  h.chain.setOutage(false);
  assert.equal((await h.credits.getBalance(customer.id)).stale, false);
});

test('balance ignores on-ramp intent status entirely (credits come from chain only)', async () => {
  const h = makeHarness();
  const { customer, address } = await linkCustomer(h);
  await h.prisma.onRampIntent.create({
    data: { customerId: customer.id, provider: 'moonpay-sandbox', status: 'COMPLETED', intendedUsdCents: 10_000, destinationAddress: address },
  });
  assert.equal((await h.credits.getBalance(customer.id)).spendableAtomic, 0n);
});

test('customer without a wallet has an empty non-stale balance', async () => {
  const h = makeHarness();
  const customer = await h.wallets.resolveCustomer('nowallet@example.com');
  const balance = await h.credits.getBalance(customer.id);
  assert.equal(balance.hasWallet, false);
  assert.equal(balance.spendableAtomic, 0n);
});

test('listTransactions returns newest first with bigint amounts', async () => {
  const h = makeHarness();
  const { customer, address } = await linkCustomer(h);
  for (const [i, amountAtomic] of [1n, 2n].entries()) {
    await h.prisma.cryptoTransaction.create({
      data: { customerId: customer.id, type: 'DEPOSIT', status: 'FINALIZED', amountAtomic, sourceAddress: 'a', destinationAddress: address, mint: 'm', network: 'n', reference: `r${i}`, createdAt: new Date(2026, 0, 1 + i) },
    });
  }
  const rows = await h.credits.listTransactions(customer.id);
  assert.deepEqual(rows.map((r) => r.amountAtomic), [2n, 1n]);
});

// ---- in-flight purchase accounting (no double subtraction, never overstated) ----------------------------

import { Keypair } from '@solana/web3.js';
import { USDC_DEVNET_MINT } from '../contracts';

function purchaseRow(customerId: string, address: string, orderId: string, signature: string, status = 'SUBMITTED') {
  return {
    customerId, type: 'PURCHASE', status, amountAtomic: 30_000_000n, sourceAddress: address, destinationAddress: 'merchant',
    mint: USDC_DEVNET_MINT, network: 'solana-devnet', reference: `ref-${orderId}`, orderId, txSignature: signature,
  };
}

test('an in-flight purchase is subtracted once, not as both a pending row and its reservation', async () => {
  const h = makeHarness();
  const { customer, address } = await linkCustomer(h);
  h.chain.creditUsdc(address, 100_000_000n);
  await h.prisma.creditReservation.create({ data: { customerId: customer.id, orderId: 'ord-1', amountAtomic: 30_000_000n, status: 'ACTIVE', expiresAt: new Date(Date.now() + 60_000) } });
  await h.prisma.cryptoTransaction.create({ data: purchaseRow(customer.id, address, 'ord-1', 'sig-not-on-chain') });
  const balance = await h.credits.getBalance(customer.id);
  assert.equal(balance.pendingOutgoingAtomic, 30_000_000n);
  assert.equal(balance.activeReservationsAtomic, 0n);
  assert.equal(balance.spendableAtomic, 70_000_000n);
});

test('a purchase finalized on chain is already in the balance and is not subtracted again', async () => {
  const h = makeHarness();
  const { customer, address } = await linkCustomer(h);
  h.chain.creditUsdc(address, 100_000_000n);
  const merchant = Keypair.generate().publicKey.toBase58(); // test-only throwaway address
  h.chain.recordTransfer({
    signature: 'sig-finalized', network: 'solana-devnet', finalized: true, succeeded: true, mint: USDC_DEVNET_MINT,
    sourceOwner: address, destinationOwner: merchant, amountAtomic: 30_000_000n, referenceKeys: [],
  }, { applyBalances: true });
  await h.prisma.cryptoTransaction.create({ data: purchaseRow(customer.id, address, 'ord-2', 'sig-finalized') });
  const balance = await h.credits.getBalance(customer.id);
  assert.equal(balance.finalizedAtomic, 70_000_000n);
  assert.equal(balance.pendingOutgoingAtomic, 0n);
  assert.equal(balance.spendableAtomic, 70_000_000n); // not 40
});

test('a purchase that is not yet finalized still reduces spendable funds (never overstated)', async () => {
  const h = makeHarness();
  const { customer, address } = await linkCustomer(h);
  h.chain.creditUsdc(address, 100_000_000n);
  h.chain.recordTransfer({
    signature: 'sig-pending', network: 'solana-devnet', finalized: false, succeeded: true, mint: USDC_DEVNET_MINT,
    sourceOwner: address, destinationOwner: 'merchant', amountAtomic: 30_000_000n, referenceKeys: [],
  });
  await h.prisma.cryptoTransaction.create({ data: purchaseRow(customer.id, address, 'ord-3', 'sig-pending') });
  const balance = await h.credits.getBalance(customer.id);
  assert.equal(balance.finalizedAtomic, 100_000_000n);
  assert.equal(balance.spendableAtomic, 70_000_000n);
});

test('an outage while checking pending transfers fails closed', async () => {
  const h = makeHarness();
  const { customer, address } = await linkCustomer(h);
  h.chain.creditUsdc(address, 100_000_000n);
  await h.prisma.cryptoTransaction.create({ data: purchaseRow(customer.id, address, 'ord-4', 'sig-x') });
  h.chain.setOutage(true);
  const balance = await h.credits.getBalance(customer.id);
  assert.equal(balance.stale, true);
  assert.equal(balance.spendableAtomic, 0n);
});
