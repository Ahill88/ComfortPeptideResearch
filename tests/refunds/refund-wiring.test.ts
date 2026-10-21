/**
 * Wiring of the refund engine in Nest and the dev-only treasury signer (tools/dev/dev-treasury-signer.ts), no database:
 *  - MERCHANT_SIGNER defaults to "not bound" (503 in production) and is replaced by overrideProvider exactly like the dev launcher does;
 *  - the order hook (REFUNDED event + stock release) finds INVENTORY_PORT even when it lives in another module;
 *  - the dev signer signs exactly what the engine builds and refuses everything else.
 *
 *   pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only ../../tests/refunds/refund-wiring.test.ts
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { INVENTORY_PORT } from '../../apps/api/src/commerce/inventory.types';
import { PrismaService } from '../../apps/api/src/prisma.service';
import { USDC_DEVNET_MINT } from '../../apps/api/src/wallet/contracts';
import { CHAIN_PORT } from '../../apps/api/src/wallet/checkout/ports';
import { MERCHANT_SIGNER } from '../../apps/api/src/wallet/refunds/merchant-signer.port';
import { OrderRefundedEffects } from '../../apps/api/src/wallet/refunds/order-refunded.effects';
import { REFUND_ORDER_HOOK } from '../../apps/api/src/wallet/refunds/refund-order-hook';
import { RefundsModule } from '../../apps/api/src/wallet/refunds/refunds.module';
import { RefundsService } from '../../apps/api/src/wallet/refunds/refunds.service';
import { ORDER_ID, makeHarness } from '../../apps/api/src/wallet/refunds/__tests__/harness';
import { createDevTreasurySigner } from '../../tools/dev/dev-treasury-signer';

// useFactory, not useValue: values holding BigInt make every dynamic module serialize identically (see admin-order-refund.module.ts).
const base = (h: ReturnType<typeof makeHarness>, extra: any[] = []) => [
  { provide: PrismaService, useFactory: () => h.prisma },
  { provide: CHAIN_PORT, useFactory: () => h.chain },
  ...extra,
];

test('MERCHANT_SIGNER is unbound by default (submit would be 503) and overrideProvider binds it, exactly as the dev launcher does', async () => {
  const h = makeHarness();
  const plain = await Test.createTestingModule({ imports: [RefundsModule.register({ providers: base(h) })] }).compile();
  assert.equal(plain.get(RefundsService).isSigningAvailable(), false);
  const bound = await Test.createTestingModule({ imports: [RefundsModule.register({ providers: base(h) })] })
    .overrideProvider(MERCHANT_SIGNER).useValue(createDevTreasurySigner(h.treasury))
    .compile();
  assert.equal(bound.get(RefundsService).isSigningAvailable(), true);
});

function fakeTx() {
  const events: any[] = [];
  return { events, tx: { orderEvent: { create: async ({ data }: any) => events.push(data) } } as any };
}

test('the order hook writes the REFUNDED event and releases stock for PAID/PROCESSING only; INVENTORY_PORT may live in another module', async () => {
  const released: any[] = [];
  const port = { releaseForOrder: async (_tx: unknown, orderId: string, reason: string) => void released.push({ orderId, reason }) };
  const h = makeHarness();
  @Global()
  @Module({ providers: [{ provide: INVENTORY_PORT, useFactory: () => port }], exports: [INVENTORY_PORT] })
  class StockModule {}
  // Case 1: bound in the global stock module (not imported by RefundsModule)
  const viaGlobal = await Test.createTestingModule({ imports: [StockModule, RefundsModule.register({ providers: base(h) })] }).compile();
  // Case 2: provided straight into the refunds module
  const direct = await Test.createTestingModule({ imports: [RefundsModule.register({ providers: base(h, [{ provide: INVENTORY_PORT, useFactory: () => port }]) })] }).compile();
  for (const module of [viaGlobal, direct]) {
    const hook = module.get<OrderRefundedEffects>(REFUND_ORDER_HOOK);
    assert.ok(hook instanceof OrderRefundedEffects);
    for (const [from, restock] of [['PAID', true], ['PROCESSING', true], ['SHIPPED', false], ['DELIVERED', false]] as const) {
      released.length = 0;
      const { tx, events } = fakeTx();
      await hook.onOrderRefunded(tx, { orderId: 'o1', fromStatus: from, refundId: 'r1', txSignature: 'sig' });
      assert.equal(events.length, 1);
      assert.deepEqual({ kind: events[0].kind, from: events[0].fromStatus, to: events[0].toStatus, admin: events[0].adminId }, { kind: 'STATUS', from, to: 'REFUNDED', admin: null });
      assert.equal(released.length, restock ? 1 : 0, `${from}: restock=${restock}`);
      if (restock) assert.equal(released[0].orderId, 'o1');
    }
  }
});

test('with no inventory implementation anywhere the hook still writes the event and does not throw (the money already moved)', async () => {
  const h = makeHarness();
  const module = await Test.createTestingModule({ imports: [RefundsModule.register({ providers: base(h) })] }).compile();
  const { tx, events } = fakeTx();
  await module.get<OrderRefundedEffects>(REFUND_ORDER_HOOK).onOrderRefunded(tx, { orderId: 'o1', fromStatus: 'PAID', refundId: 'r1', txSignature: null });
  assert.equal(events.length, 1);
});

// ------------------------------------------------------------------------------------------------ dev signer policy

test('the dev treasury signer signs exactly the transaction the engine builds (engine accepts it) and reports the treasury', async () => {
  const h = makeHarness();
  const signer = createDevTreasurySigner(h.treasury);
  assert.equal(await signer.treasuryAddress(), h.treasury.publicKey.toBase58());
  const service = new RefundsService(h.prisma as any, h.chain, signer);
  const requested = await service.requestRefund(ORDER_ID, undefined, 'x', 'admin-1');
  const submitted = await service.prepareAndSubmit(requested.refundId);
  assert.equal(submitted.status, 'SUBMITTED');
  const sent = Transaction.from(h.chain.broadcasts[0] as Buffer);
  assert.equal(sent.signatures.length, 1);
  assert.equal(sent.signatures[0].publicKey.toBase58(), h.treasury.publicKey.toBase58());
  assert.ok(sent.verifySignatures());
});

test('the dev treasury signer refuses a wrong destination, amount, mint, authority, fee payer or an extra instruction, and signs nothing', async () => {
  const h = makeHarness();
  const signer = createDevTreasurySigner(h.treasury);
  const mint = new (await import('@solana/web3.js')).PublicKey(USDC_DEVNET_MINT);
  const customer = h.customer.publicKey;
  const treasury = h.treasury.publicKey;
  const build = (over: { destinationOwner?: typeof customer; amount?: bigint; mintKey?: typeof mint; authority?: typeof customer; feePayer?: typeof customer; extra?: boolean } = {}) => {
    const tx = new Transaction({ feePayer: over.feePayer ?? treasury, blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 });
    tx.add(createTransferCheckedInstruction(
      getAssociatedTokenAddressSync(mint, treasury, true),
      over.mintKey ?? mint,
      getAssociatedTokenAddressSync(over.mintKey ?? mint, over.destinationOwner ?? customer, false),
      over.authority ?? treasury,
      over.amount ?? 1_000_000n,
      6,
    ));
    if (over.extra) tx.add(SystemProgram.transfer({ fromPubkey: treasury, toPubkey: customer, lamports: 1 }));
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  };
  const context = { refundId: 'r', orderId: 'o', amountAtomic: 1_000_000n, destination: customer.toBase58() };
  await signer.signTransaction(build(), context); // the matching one is signed

  const stranger = Keypair.generate().publicKey;
  const bad: Array<[string, string, typeof context]> = [
    ['destination', build({ destinationOwner: stranger }), context],
    ['amount', build({ amount: 1_000_001n }), context],
    ['mint', build({ mintKey: stranger }), context],
    ['authority', build({ authority: stranger }), context],
    ['fee payer', build({ feePayer: stranger }), context],
    ['extra instruction', build({ extra: true }), context],
    ['context destination differs', build(), { ...context, destination: stranger.toBase58() }],
    ['context amount differs', build(), { ...context, amountAtomic: 999_999n }],
  ];
  for (const [label, unsigned, ctx] of bad) await assert.rejects(signer.signTransaction(unsigned, ctx), /dev treasury signer refused/, label);
});
