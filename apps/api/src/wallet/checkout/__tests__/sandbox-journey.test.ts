/**
 * A running sandbox API must be able to complete a purchase on its own: the factory-built sandbox chain
 * auto-finalizes broadcasts and has the treasury token account registered, and settlement is pull-driven.
 * Nothing in this test calls finalize() or reconcile().
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { createSolanaChain } from '../../chain/chain.factory';
import { SandboxSolanaChain } from '../../chain/sandbox-solana-chain';
import { USDC_DEVNET_MINT, computeSpendable, loadFeatureFlags } from '../../contracts';
import { makeConfig } from '../../__tests__/helpers';
import { CheckoutService } from '../checkout.service';
import { InMemoryPreparedMessageStore } from '../prepared-message-store';
import { VerificationService } from '../verification.service';
import type { BalancePort, CheckoutConfig, WalletLookupPort } from '../ports';
import { CUSTOMER_ID, FakePrisma, ORDER_ID, signAs } from './harness';

function boot(treasury: string | null) {
  const flags = loadFeatureFlags({});
  const chain = createSolanaChain(flags, makeConfig({ treasuryAddress: treasury })) as SandboxSolanaChain;
  assert.ok(chain instanceof SandboxSolanaChain);
  const customer = Keypair.generate();
  const address = customer.publicKey.toBase58();
  chain.creditUsdc(address, 1_000_000_000n);
  const prisma = new FakePrisma();
  prisma.tables.customer.push({ id: CUSTOMER_ID, email: 'researcher@example.com', createdAt: new Date(), __seq: 0 });
  prisma.tables.customerEligibility.push({ id: 'elig_1', customerId: CUSTOMER_ID, status: 'APPROVED', requestedAt: new Date(), __seq: 0 });
  prisma.tables.order.push({ id: ORDER_ID, customerId: CUSTOMER_ID, status: 'PENDING_PAYMENT', totalCents: 25_000, currency: 'USD', researchAcknowledgedAt: new Date(), createdAt: new Date(), __seq: 0 });
  const wallets: WalletLookupPort = { getWallet: async () => ({ address, network: 'solana-devnet' }) };
  const balances: BalancePort = {
    async getSpendable() {
      const finalizedAtomic = await chain.getFinalizedUsdcBalance(address);
      return { ...computeSpendable({ finalizedAtomic, pendingOutgoingAtomic: 0n, activeReservationsAtomic: 0n }), stale: false };
    },
  };
  const config: CheckoutConfig = { treasury: treasury ?? undefined, mainnetUsdcMint: undefined, reservationTtlMs: 15 * 60_000, messageReuseMs: 20_000, nodeEnv: 'test' };
  const verification = new VerificationService(prisma as any, chain, flags, { trigger: async () => undefined });
  const checkout = new CheckoutService(prisma as any, chain, balances, wallets, flags, new InMemoryPreparedMessageStore(), config, verification);
  return { chain, customer, address, prisma, checkout };
}

test('sandbox journey: prepare -> sign -> submit -> PAID with no finalize() and no reconciliation', async () => {
  const treasury = Keypair.generate().publicKey.toBase58();
  const { chain, customer, address, prisma, checkout } = boot(treasury);

  const prepared = await checkout.prepare(CUSTOMER_ID, ORDER_ID);
  assert.equal(prepared.merchant, treasury);
  assert.equal(prepared.mint, USDC_DEVNET_MINT);
  const submitted = await checkout.submit(CUSTOMER_ID, ORDER_ID, signAs(prepared.unsignedTransactionBase64, customer));
  assert.equal(submitted.status, 'SUBMITTED');

  // status() is the customer-visible poll; it (or the post-submit kick) settles the order.
  let status = await checkout.status(CUSTOMER_ID, ORDER_ID);
  for (let i = 0; i < 100 && status.orderStatus !== 'PAID'; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    status = await checkout.status(CUSTOMER_ID, ORDER_ID);
  }
  assert.equal(status.orderStatus, 'PAID');
  assert.equal(status.payment?.status, 'FINALIZED');
  assert.equal(status.reservation?.status, 'CONSUMED');
  assert.equal(prisma.audits.filter((a) => a.action === 'checkout.settled').length, 1);
  assert.equal(await chain.getFinalizedUsdcBalance(treasury), BigInt(prepared.amountAtomic));
  assert.equal(await chain.getFinalizedUsdcBalance(address), 1_000_000_000n - BigInt(prepared.amountAtomic));
});

test('sandbox without a registered treasury still cannot pay it (broadcast rejected, order stays payable)', async () => {
  const treasury = Keypair.generate().publicKey.toBase58();
  const { prisma, customer, checkout } = boot(null);
  // CheckoutConfig.treasury is set independently of the chain's registration, as in a misconfigured deployment.
  (checkout as any).config = { ...(checkout as any).config, treasury };
  const prepared = await checkout.prepare(CUSTOMER_ID, ORDER_ID);
  await assert.rejects(checkout.submit(CUSTOMER_ID, ORDER_ID, signAs(prepared.unsignedTransactionBase64, customer)), (e: any) => e.getStatus?.() === 502);
  assert.equal(prisma.orders[0].status, 'PENDING_PAYMENT');
  assert.equal(prisma.txs[0].status, 'PREPARED');
});
