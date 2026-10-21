/**
 * The four screened surfaces (wallet link, on-ramp intent, transfer prepare, checkout prepare) against the REAL SanctionsComplianceScreen
 * with an in-memory list. Each surface must refuse a listed address with 403 {message:'This wallet cannot be used.'} (generic, no mention
 * of a list), write a SANCTIONS_BLOCKED audit row whose detail is {surface} only, and keep working for an unlisted address.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { OnRampService } from '../../../wallet/onramp/onramp.service';
import { WalletService } from '../../../wallet/wallet.service';
import { TransfersService } from '../../../wallet/transfers/transfers.service';
import { SCREENING_NOT_READY_MESSAGE, WALLET_BLOCKED_MESSAGE } from '../../../wallet/transfers/compliance-screen';
import { InMemoryPreparedTransactionStore } from '../../../wallet/transfers/prepared-transaction.store';
import * as wallet from '../../../wallet/__tests__/helpers';
import * as checkoutH from '../../../wallet/checkout/__tests__/harness';
import { loadSanctionsConfig } from '../sanctions.config';
import { SanctionsComplianceScreen } from '../sanctions.screen';
import type { SanctionsService } from '../sanctions.service';

class FakeSanctions {
  ready = true;
  listed = new Set<string>();
  async isReady() {
    return this.ready;
  }
  async findListed(addresses: readonly string[]) {
    return addresses.some((a) => this.listed.has(a));
  }
}

function makeScreen(runtime: { NODE_ENV: string | undefined } = { NODE_ENV: 'test' }) {
  const fake = new FakeSanctions();
  const screen = new SanctionsComplianceScreen(fake as unknown as SanctionsService, loadSanctionsConfig({ NODE_ENV: 'test' }));
  screen.env = runtime;
  return { fake, screen };
}

/** The wallet harness with every service that screens bound to `screen`. */
function walletStack(screen: SanctionsComplianceScreen) {
  const h = wallet.makeHarness();
  const wallets = new WalletService(h.db, h.chain, h.config, screen);
  const onRamp = new OnRampService(h.db, wallets, h.provider, h.chain, h.config, screen);
  const transfers = new TransfersService(h.db, h.credits, wallets, h.chain, new InMemoryPreparedTransactionStore(), screen);
  return { h, wallets, onRamp, transfers };
}

async function link(stack: ReturnType<typeof walletStack>, email: string, keypair: Keypair) {
  return stack.wallets.associateWallet(email, wallet.linkRequest(stack.h, email, keypair));
}

const addr = (keypair: Keypair) => keypair.publicKey.toBase58();
const auditRows = (h: wallet.Harness) => h.prisma.walletAuditEvent.rows.filter((r: any) => r.action === 'SANCTIONS_BLOCKED');

function assertGenericRefusal(error: { status: number; message: string }) {
  assert.equal(error.status, 403);
  assert.equal(error.message, WALLET_BLOCKED_MESSAGE);
  assert.doesNotMatch(error.message, /sanction|list|ofac|screen|compliance/i);
}

test('wallet link: a listed address is refused (403, generic), audited with {surface} only, and nothing is linked', async () => {
  const { fake, screen } = makeScreen();
  const stack = walletStack(screen);
  const keypair = Keypair.generate();
  fake.listed.add(addr(keypair));

  assertGenericRefusal(await wallet.rejection(link(stack, 'buyer@example.com', keypair)));
  assert.equal(stack.h.prisma.customerWallet.rows.length, 0);
  const rows = auditRows(stack.h);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].detail, { surface: 'wallet_link' });
  assert.ok(!JSON.stringify(stack.h.prisma.walletAuditEvent.rows).includes(addr(keypair)), 'the address is not in any audit row');

  const clean = Keypair.generate();
  const linked = await link(stack, 'clean@example.com', clean);
  assert.equal(linked.created, true);
});

test('wallet link: an already linked wallet that is listed later cannot be "re-linked" either', async () => {
  const { fake, screen } = makeScreen();
  const stack = walletStack(screen);
  const keypair = Keypair.generate();
  await link(stack, 'buyer@example.com', keypair);
  fake.listed.add(addr(keypair));
  assertGenericRefusal(await wallet.rejection(link(stack, 'buyer@example.com', keypair)));
});

test('on-ramp: a listed wallet gets no intent and no provider quote; re-quoting is refused too; an unlisted wallet works', async () => {
  const { fake, screen } = makeScreen();
  const stack = walletStack(screen);
  const keypair = Keypair.generate();
  const { customer } = await wallet.linkCustomer(stack.h, 'other@example.com');
  const buyer = await link(stack, 'buyer@example.com', keypair);
  assert.equal(buyer.created, true);
  const buyerCustomer = await stack.wallets.resolveCustomer('buyer@example.com');

  const ok = await stack.onRamp.createIntent(buyerCustomer.id, { intendedUsdCents: 5_000 });
  assert.equal(ok.status, 'CREATED');
  const intentsBefore = stack.h.prisma.onRampIntent.rows.length;

  fake.listed.add(addr(keypair));
  assertGenericRefusal(await wallet.rejection(stack.onRamp.createIntent(buyerCustomer.id, { intendedUsdCents: 5_000 })));
  const stored = stack.h.prisma.onRampIntent.rows[0] as any;
  assertGenericRefusal(await wallet.rejection(stack.onRamp.requoteIntent(buyerCustomer.id, stored)));
  assert.equal(stack.h.prisma.onRampIntent.rows.length, intentsBefore, 'no intent row is created for a listed wallet');
  const rows = auditRows(stack.h);
  assert.ok(rows.length >= 2);
  for (const row of rows) assert.deepEqual(row.detail, { surface: 'onramp' });
  assert.equal(customer.id === buyerCustomer.id, false);
});

test('transfer prepare: a listed destination, or a listed source wallet, is refused with the generic 403 and no transaction row', async () => {
  const { fake, screen } = makeScreen();
  const stack = walletStack(screen);
  const keypair = Keypair.generate();
  await link(stack, 'buyer@example.com', keypair);
  const customer = await stack.wallets.resolveCustomer('buyer@example.com');
  stack.h.chain.creditUsdc(addr(keypair), 100_000_000n);
  const destination = Keypair.generate();

  const prepared = await stack.transfers.prepare(customer.id, { destination: addr(destination), amountAtomic: '1000000' });
  assert.ok(prepared.transactionId, 'unlisted destination is prepared');
  const rowsBefore = stack.h.prisma.cryptoTransaction.rows.length;

  fake.listed.add(addr(destination));
  assertGenericRefusal(await wallet.rejection(stack.transfers.prepare(customer.id, { destination: addr(destination), amountAtomic: '1000000' })));
  fake.listed.clear();
  fake.listed.add(addr(keypair));
  assertGenericRefusal(await wallet.rejection(stack.transfers.prepare(customer.id, { destination: addr(destination), amountAtomic: '1000000' })));

  assert.equal(stack.h.prisma.cryptoTransaction.rows.length, rowsBefore);
  const rows = auditRows(stack.h);
  assert.equal(rows.length, 2);
  for (const row of rows) assert.deepEqual(row.detail, { surface: 'transfer' });
  assert.ok(!JSON.stringify(stack.h.prisma.walletAuditEvent.rows.filter((r: any) => r.action === 'SANCTIONS_BLOCKED')).includes(addr(destination)));
  assert.equal(stack.h.prisma.walletAuditEvent.rows.some((r: any) => r.action === 'WITHDRAWAL_SCREENING_BLOCKED'), false, 'the legacy generic-block audit is not used for sanctions');
});

test('transfer prepare: a non-sanctions block from a custom screen keeps its original behaviour', async () => {
  const h = wallet.makeHarness({ compliance: { screen: async () => ({ allowed: false, reason: 'custom' }) } });
  const who = await wallet.linkCustomer(h);
  h.chain.creditUsdc(who.address, 10_000_000n);
  const error = await wallet.rejection(h.transfers.prepare(who.customer.id, { destination: addr(Keypair.generate()), amountAtomic: '1' }));
  assert.equal(error.status, 403);
  assert.equal(error.message, 'This transfer cannot be processed');
  assert.equal(h.prisma.walletAuditEvent.rows.filter((r: any) => r.action === 'WITHDRAWAL_SCREENING_BLOCKED').length, 1);
});

test('checkout prepare: a listed paying wallet is refused before any reservation or message exists; an unlisted one prepares', async () => {
  const { fake, screen } = makeScreen();
  const h = checkoutH.makeHarness();
  (h.checkout as unknown as { screen: unknown }).screen = screen;

  const ok = await h.checkout.prepare(checkoutH.CUSTOMER_ID, checkoutH.ORDER_ID);
  assert.ok(ok.unsignedTransactionBase64);
  const reservationsBefore = h.prisma.reservations.length;
  const txsBefore = h.prisma.txs.length;

  const fresh = checkoutH.makeHarness();
  (fresh.checkout as unknown as { screen: unknown }).screen = screen;
  fake.listed.add(fresh.customer.publicKey.toBase58());
  await assert.rejects(fresh.checkout.prepare(checkoutH.CUSTOMER_ID, checkoutH.ORDER_ID), (error: any) => {
    assert.equal(error.getStatus(), 403);
    assert.equal(error.message, WALLET_BLOCKED_MESSAGE);
    assert.doesNotMatch(error.message, /sanction|list|ofac/i);
    return true;
  });
  assert.equal(fresh.prisma.reservations.length, 0);
  assert.equal(fresh.prisma.txs.length, 0);
  const rows = fresh.prisma.audits.filter((r: any) => r.action === 'SANCTIONS_BLOCKED');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].detail, { surface: 'checkout' });
  assert.equal(rows[0].customerId, checkoutH.CUSTOMER_ID);
  assert.ok(!JSON.stringify(fresh.prisma.audits).includes(fresh.customer.publicKey.toBase58()));
  assert.equal(reservationsBefore >= 0 && txsBefore >= 0, true);
});

test('list never loaded: development/test fail open at all four surfaces; every other runtime answers 503 at all four', async () => {
  for (const nodeEnv of ['development', 'test', 'production', undefined, 'staging']) {
    const open = nodeEnv === 'development' || nodeEnv === 'test';
    const { fake, screen } = makeScreen({ NODE_ENV: nodeEnv });
    fake.ready = false;
    const stack = walletStack(screen);
    const keypair = Keypair.generate();
    const clean = Keypair.generate();
    const destination = addr(Keypair.generate());

    // Seed a linked customer through a permissive stack so the later surfaces have something to act on.
    const seed = wallet.makeHarness();
    const seeded = await wallet.linkCustomer(seed, 'seed@example.com', clean);
    seed.chain.creditUsdc(seeded.address, 10_000_000n);
    const seededStack = {
      onRamp: new OnRampService(seed.db, seed.wallets, seed.provider, seed.chain, seed.config, screen),
      transfers: new TransfersService(seed.db, seed.credits, seed.wallets, seed.chain, new InMemoryPreparedTransactionStore(), screen),
    };
    const checkout = checkoutH.makeHarness();
    (checkout.checkout as unknown as { screen: unknown }).screen = screen;

    const surfaces: Array<[string, () => Promise<unknown>]> = [
      ['wallet_link', () => link(stack, 'buyer@example.com', keypair)],
      ['onramp', () => seededStack.onRamp.createIntent(seeded.customer.id, { intendedUsdCents: 5_000 })],
      ['transfer', () => seededStack.transfers.prepare(seeded.customer.id, { destination, amountAtomic: '1' })],
      ['checkout', () => checkout.checkout.prepare(checkoutH.CUSTOMER_ID, checkoutH.ORDER_ID)],
    ];
    for (const [surface, run] of surfaces) {
      if (open) {
        await run();
      } else {
        const error = await wallet.rejection(run()).catch((e) => { throw new Error(`${surface} did not reject for NODE_ENV=${nodeEnv}: ${e.message}`); });
        assert.equal(error.status, 503, `${surface} NODE_ENV=${nodeEnv}`);
        assert.equal(error.message, SCREENING_NOT_READY_MESSAGE);
      }
    }
    if (!open) {
      assert.equal(stack.h.prisma.customerWallet.rows.length, 0, 'nothing is linked while screening is not ready');
      assert.equal(seed.prisma.cryptoTransaction.rows.length, 0);
      assert.equal(checkout.prisma.reservations.length, 0);
    }
  }
});

test('DI: WalletModule no longer binds an allow-all default; COMPLIANCE_SCREEN is the sanctions screen everywhere it is injected', async () => {
  const { Global, Module } = await import('@nestjs/common');
  const { Test } = await import('@nestjs/testing');
  const { PrismaService } = await import('../../../prisma.service');
  const { AdminCoreModule } = await import('../../../admin/admin-core.module');
  const { WalletModule } = await import('../../../wallet/wallet.module');
  const { COMPLIANCE_SCREEN } = await import('../../../wallet/wallet.tokens');
  const { SanctionsModule } = await import('../sanctions.module');
  const { AllowAllComplianceScreen } = await import('../../../wallet/transfers/compliance-screen');

  @Global()
  @Module({ providers: [{ provide: PrismaService, useValue: {} }], exports: [PrismaService] })
  class StubPrismaModule {}

  const moduleRef = await Test.createTestingModule({ imports: [StubPrismaModule, AdminCoreModule, SanctionsModule, WalletModule] }).compile();
  const bound = moduleRef.get(COMPLIANCE_SCREEN, { strict: false });
  assert.ok(bound instanceof SanctionsComplianceScreen);
  assert.ok(!(bound instanceof AllowAllComplianceScreen));
  const transfers = moduleRef.get(TransfersService, { strict: false }) as unknown as { compliance: unknown };
  assert.equal(transfers.compliance, bound, 'TransfersService receives the same instance');
  for (const service of [moduleRef.get(WalletService, { strict: false }), moduleRef.get(OnRampService, { strict: false })]) {
    assert.equal((service as unknown as { screen: unknown }).screen, bound);
  }
  await moduleRef.close();
});
