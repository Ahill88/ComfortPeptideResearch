/**
 * Owner refunds of paid orders (docs/api/admin-refunds.md) against REAL PostgreSQL, through HTTP, with the REAL AdminSessionGuard (OWNER vs STAFF
 * sessions), the real RefundsService / AdminOrderRefundService / AdminOrdersService, a fake chain and a throwaway test-only MerchantSigner.
 *
 *   TEST_DATABASE_URL=postgresql://helix@127.0.0.1:54329/helix_field?schema=<your own schema> \
 *   NODE_ENV=test pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only ../../tests/refunds/admin-order-refund.integration.test.ts
 *
 * tests/run-all.mjs reports this file as SKIPPED when TEST_DATABASE_URL is unset. Refuses non-local databases and the public/dev schemas.
 * Every row is tagged and removed in `after` (no truncation).
 */
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Keypair } from '@solana/web3.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for the integration suite (run tests/run-all.mjs to see it reported as SKIPPED).');
const parsed = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || !/helix|test/i.test(parsed.pathname)) throw new Error('Refusing to run: not a local helix/test database.');
if (['public', 'dev'].includes(parsed.searchParams.get('schema') ?? 'public')) throw new Error('Refusing to run against the public/dev schema: use your own scratch schema.');
process.env.DATABASE_URL = url;
if (process.env.NODE_ENV === 'production') process.env.NODE_ENV = 'test';

import { InventoryService } from '../../apps/api/src/commerce/inventory.service';
import { INVENTORY_PORT } from '../../apps/api/src/commerce/inventory.types';
import { AdminCoreModule } from '../../apps/api/src/admin/admin-core.module';
import { hashSessionToken } from '../../apps/api/src/admin/admin-session.guard';
import { AdminOrderRefundModule } from '../../apps/api/src/admin/orders/admin-order-refund.module';
import { AdminOrdersModule } from '../../apps/api/src/admin/orders/admin-orders.module';
import { PrismaService } from '../../apps/api/src/prisma.service';
import { USDC_DEVNET_MINT, type ChainTransfer } from '../../apps/api/src/wallet/contracts';
import { CHAIN_PORT } from '../../apps/api/src/wallet/checkout/ports';
import { referenceKeyFor } from '../../apps/api/src/wallet/checkout/checkout.util';
import { MERCHANT_SIGNER } from '../../apps/api/src/wallet/refunds/merchant-signer.port';
import { RefundsModule } from '../../apps/api/src/wallet/refunds/refunds.module';
import { FakeChain, TestMerchantSigner } from '../../apps/api/src/wallet/refunds/__tests__/harness';

const tag = `rfd${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
type OrderStatus = 'PENDING_PAYMENT' | 'PAID' | 'PROCESSING' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' | 'REFUNDED';
const PRICE_CENTS = 2500;
const PRICE_ATOMIC = 25_000_000n;
const QUANTITY = 2;
const START_STOCK = 8; // what is on hand while an order holds QUANTITY units
const lotCode = `LOT-${tag}`;

/** Idempotent release over the real tables: a faithful stand-in for the stock engineer's InventoryPort. */
class FakeInventory {
  calls = 0;
  failing = false;
  async releaseForOrder(tx: any, orderId: string, _reason: string): Promise<void> {
    this.calls++;
    if (this.failing) throw new Error('inventory unavailable');
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
    if (order.inventoryReleasedAt) return;
    for (const item of order.items) await tx.product.update({ where: { id: item.productId }, data: { inventory: { increment: item.quantity } } });
    await tx.order.update({ where: { id: orderId }, data: { inventoryReleasedAt: new Date() } });
  }
}

interface Stack {
  app: import('@nestjs/common').INestApplication;
  base: string;
  chain: FakeChain;
  signer: TestMerchantSigner | null;
  inventory: FakeInventory | InventoryService;
}

const prisma = new PrismaService();
const treasury = Keypair.generate();
let withSigner: Stack;
let withoutSigner: Stack;
let withRealStock: Stack;
let product: { id: string };
let owner: { id: string; token: string };
let staff: { id: string; token: string };
const customerIds: string[] = [];
const orderIds: string[] = [];
const adminIds: string[] = [];

async function build(bindSigner: boolean, realStock = false): Promise<Stack> {
  const { Global, Module, ValidationPipe } = await import('@nestjs/common');
  const { Test } = await import('@nestjs/testing');
  @Global()
  @Module({ providers: [{ provide: PrismaService, useValue: prisma }], exports: [PrismaService] })
  class RealPrismaModule {}
  const chain = new FakeChain();
  chain.usdc.set(treasury.publicKey.toBase58(), 1_000_000_000n);
  chain.sol.set(treasury.publicKey.toBase58(), 100_000_000n);
  const signer = bindSigner ? new TestMerchantSigner(treasury) : null;
  const inventory = realStock ? new InventoryService() : new FakeInventory();
  const refundsModule = RefundsModule.register({
    providers: [
      // useFactory, not useValue: see the note in admin-order-refund.module.ts (BigInt-holding values break Nest's module identity).
      { provide: CHAIN_PORT, useFactory: () => chain },
      { provide: INVENTORY_PORT, useFactory: () => inventory },
      ...(signer ? [{ provide: MERCHANT_SIGNER, useFactory: () => signer }] : []),
    ],
  });
  const moduleRef = await Test.createTestingModule({
    imports: [RealPrismaModule, AdminCoreModule, AdminOrdersModule, refundsModule, AdminOrderRefundModule.register(refundsModule)],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  return { app, base: (await app.getUrl()).replace('[::1]', '127.0.0.1'), chain, signer, inventory };
}

async function mkAdmin(role: 'OWNER' | 'STAFF') {
  const row = await prisma.adminUser.create({ data: { email: `${tag}-${role.toLowerCase()}@example.test`, name: `${role} ${tag}`, role, passwordHash: 'x', mfaSeedEnc: 'x' } });
  adminIds.push(row.id);
  const token = randomBytes(32).toString('base64url');
  await prisma.adminSession.create({ data: { adminId: row.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3_600_000) } });
  return { id: row.id, token };
}

before(async () => {
  await prisma.$connect();
  owner = await mkAdmin('OWNER');
  staff = await mkAdmin('STAFF');
  product = await prisma.product.create({ data: { sku: `SKU-${tag}`, slug: `slug-${tag}`, name: `Peptide ${tag}`, active: true, priceCents: 1250, inventory: START_STOCK } });
  await prisma.lot.create({ data: { code: lotCode, productId: product.id, coaKey: 'coa/test.pdf', purity: 99 } });
  withSigner = await build(true);
  withoutSigner = await build(false);
  withRealStock = await build(true, true);
});

after(async () => {
  try {
    const orders = { in: orderIds };
    await prisma.adminAuditEvent.deleteMany({ where: { OR: [{ targetId: orders }, { adminId: { in: adminIds } }] } });
    await prisma.walletAuditEvent.deleteMany({ where: { customerId: { in: customerIds } } });
    await prisma.inventoryAdjustment.deleteMany({ where: { productId: product?.id } });
    await prisma.orderEvent.deleteMany({ where: { orderId: orders } });
    await prisma.shipment.deleteMany({ where: { orderId: orders } });
    await prisma.cryptoTransaction.deleteMany({ where: { customerId: { in: customerIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: orders } });
    await prisma.order.deleteMany({ where: { id: orders } });
    await prisma.customerWallet.deleteMany({ where: { customerId: { in: customerIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    await prisma.adminSession.deleteMany({ where: { adminId: { in: adminIds } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: adminIds } } });
    await prisma.lot.deleteMany({ where: { code: lotCode } });
    await prisma.product.deleteMany({ where: { id: product?.id } });
  } finally {
    await withSigner?.app.close();
    await withoutSigner?.app.close();
    await withRealStock?.app.close();
    await prisma.$disconnect();
  }
});

interface Fixture {
  orderId: string;
  customerId: string;
  wallet: Keypair;
}

/** A customer with a linked wallet, an order that holds QUANTITY units of stock, and the FINALIZED purchase that paid it. */
async function fixture(status: OrderStatus = 'PAID', options: { withPurchase?: boolean } = {}): Promise<Fixture> {
  const wallet = Keypair.generate();
  const customer = await prisma.customer.create({ data: { email: `${tag}-${customerIds.length}@example.test` } });
  customerIds.push(customer.id);
  await prisma.customerWallet.create({ data: { customerId: customer.id, address: wallet.publicKey.toBase58(), provider: 'test', network: 'solana-devnet' } });
  const order = await prisma.order.create({
    data: { customerId: customer.id, status, totalCents: PRICE_CENTS, items: { create: [{ productId: product.id, lotCode, quantity: QUANTITY, unitCents: PRICE_CENTS / QUANTITY }] } },
  });
  orderIds.push(order.id);
  if (options.withPurchase !== false) {
    await prisma.cryptoTransaction.create({
      data: {
        customerId: customer.id, type: 'PURCHASE', status: 'FINALIZED', amountAtomic: PRICE_ATOMIC, sourceAddress: wallet.publicKey.toBase58(),
        destinationAddress: treasury.publicKey.toBase58(), mint: USDC_DEVNET_MINT, network: 'solana-devnet', reference: `chk_${order.id}`, orderId: order.id,
        txSignature: `purchase_${order.id}`, finalizedAt: new Date(),
      },
    });
  }
  return { orderId: order.id, customerId: customer.id, wallet };
}

async function call(stack: Stack, method: string, path: string, body?: unknown, token: string | null = owner.token) {
  const res = await fetch(`${stack.base}/v1/admin/orders${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, text: await res.clone().text(), body: (await res.json().catch(() => null)) as any };
}
const request = (stack: Stack, id: string, body: unknown = { reason: 'Customer asked for a refund' }, token: string | null = owner.token) => call(stack, 'POST', `/${id}/refund`, body, token);
const submit = (stack: Stack, id: string, token: string | null = owner.token) => call(stack, 'POST', `/${id}/refund/submit`, {}, token);
const verify = (stack: Stack, id: string, token: string | null = owner.token) => call(stack, 'POST', `/${id}/refund/verify`, {}, token);
const dbOrder = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });
const refundRows = (id: string) => prisma.cryptoTransaction.findMany({ where: { orderId: id, type: 'REFUND' }, orderBy: { createdAt: 'asc' } });
const events = (id: string) => prisma.orderEvent.findMany({ where: { orderId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
const audits = (id: string, action?: string) => prisma.adminAuditEvent.findMany({ where: { targetId: id, ...(action ? { action } : {}) }, orderBy: { createdAt: 'asc' } });
const stock = async () => (await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).inventory;

/** Puts the transfer the refund describes on the fake chain, finalized, with optional overrides. */
async function land(stack: Stack, f: Fixture, overrides: Partial<ChainTransfer> = {}): Promise<void> {
  const [row] = await refundRows(f.orderId);
  stack.chain.transfers.set(row.txSignature!, {
    signature: row.txSignature!, network: 'solana-devnet', finalized: true, succeeded: true, mint: USDC_DEVNET_MINT,
    sourceOwner: treasury.publicKey.toBase58(), destinationOwner: f.wallet.publicKey.toBase58(), amountAtomic: row.amountAtomic,
    referenceKeys: [referenceKeyFor(row.reference).toBase58()], ...overrides,
  });
}

/** Resets the shared product's stock to what it is while one order holds QUANTITY units, so every test can assert exact deltas. */
async function resetStock() {
  await prisma.product.update({ where: { id: product.id }, data: { inventory: START_STOCK } });
}

test('state matrix: PAID and PROCESSING can be refunded; every other status is a 409 for request, submit and verify never changes it', async () => {
  for (const status of ['PAID', 'PROCESSING'] as const) {
    const f = await fixture(status);
    const detail = await call(withSigner, 'GET', `/${f.orderId}`);
    assert.ok(detail.body.allowedActions.includes('refund'), `${status} offers refund`);
    assert.equal(detail.body.refund, null);
    const res = await request(withSigner, f.orderId);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.status, status, 'the order stays PAID/PROCESSING until the refund finalizes');
    assert.equal(res.body.refund.status, 'REQUESTED');
    assert.equal(res.body.refund.amountAtomic, PRICE_ATOMIC.toString());
    assert.equal(res.body.refund.txSignature, null);
    assert.equal(res.body.refund.failureReason, null);
    assert.ok(!res.body.allowedActions.includes('refund'), 'no second refund while one is in progress');
  }
  for (const status of ['SHIPPED', 'DELIVERED', 'CANCELLED', 'PENDING_PAYMENT', 'REFUNDED'] as const) {
    const f = await fixture(status);
    const detail = await call(withSigner, 'GET', `/${f.orderId}`);
    assert.ok(!detail.body.allowedActions.includes('refund'), `${status} must not offer refund`);
    const res = await request(withSigner, f.orderId);
    assert.equal(res.status, 409, `${status}: ${res.text}`);
    if (status === 'SHIPPED' || status === 'DELIVERED') assert.match(res.body.message, /Shipped orders cannot be refunded/);
    assert.equal((await submit(withSigner, f.orderId)).status, 409, `${status} submit`);
    assert.equal((await dbOrder(f.orderId)).status, status);
    assert.equal((await refundRows(f.orderId)).length, 0, `${status}: no refund row`);
    assert.equal(withSigner.signer!.calls.filter((c) => c.context.orderId === f.orderId).length, 0);
  }
  assert.equal((await request(withSigner, 'does-not-exist')).status, 404);
  assert.equal((await submit(withSigner, 'does-not-exist')).status, 404);
  assert.equal((await verify(withSigner, 'does-not-exist')).status, 404);
});

test('OWNER only: STAFF is 403 and no token is 401 on all three routes, and nothing changes', async () => {
  const f = await fixture('PAID');
  for (const token of [staff.token, null, 'garbage']) {
    const expected = token === staff.token ? 403 : 401;
    assert.equal((await request(withSigner, f.orderId, undefined, token)).status, expected);
    assert.equal((await submit(withSigner, f.orderId, token)).status, expected);
    assert.equal((await verify(withSigner, f.orderId, token)).status, expected);
  }
  assert.equal((await refundRows(f.orderId)).length, 0);
  assert.equal((await audits(f.orderId)).length, 0);
  assert.equal((await request(withSigner, f.orderId, { reason: 'ok' }, owner.token)).status, 200);
});

test('request validates the body: reason 1-500 only; a destination, amount or any other property is a 400 and creates nothing', async () => {
  const f = await fixture('PAID');
  const attacker = Keypair.generate().publicKey.toBase58();
  for (const body of [
    null, {}, { reason: '' }, { reason: '   ' }, { reason: 5 }, { reason: 'x'.repeat(501) },
    { reason: 'fine', destination: attacker }, { reason: 'fine', destinationAddress: attacker }, { reason: 'fine', wallet: attacker },
    { reason: 'fine', amountAtomic: '1' }, { reason: 'fine', amount: 1 }, [], 'reason',
  ]) {
    const res = await request(withSigner, f.orderId, body);
    assert.equal(res.status, 400, `${JSON.stringify(body)?.slice(0, 60)} -> ${res.status} ${res.text}`);
  }
  assert.equal((await submit(withSigner, f.orderId)).status, 409, 'nothing was created, so there is nothing to submit');
  assert.equal((await call(withSigner, 'POST', `/${f.orderId}/refund/submit`, { destination: attacker })).status, 400);
  assert.equal((await call(withSigner, 'POST', `/${f.orderId}/refund/verify`, { destination: attacker })).status, 400);
  assert.equal((await refundRows(f.orderId)).length, 0);
  const one = await request(withSigner, f.orderId, { reason: 'x' });
  assert.equal(one.status, 200, 'a one character reason is allowed (contract: 1-500)');
});

test('full flow from PAID: request -> submit -> verify; order REFUNDED, REFUNDED event, stock back exactly once, audit rows, no wallet addresses leaked', async () => {
  await resetStock();
  const f = await fixture('PAID');
  const requested = await request(withSigner, f.orderId);
  assert.equal(requested.status, 200, requested.text);
  const [row] = await refundRows(f.orderId);
  assert.equal(row.destinationAddress, f.wallet.publicKey.toBase58(), 'destination is the customer\'s linked wallet');
  assert.equal(row.sourceAddress, treasury.publicKey.toBase58());
  assert.equal(row.amountAtomic, PRICE_ATOMIC, 'amount is the exact paid amount');

  const early = await verify(withSigner, f.orderId);
  assert.equal(early.status, 200);
  assert.equal(early.body.status, 'PAID', 'verifying a refund that was never submitted changes nothing');
  assert.equal(early.body.refund.status, 'REQUESTED');

  const submitted = await submit(withSigner, f.orderId);
  assert.equal(submitted.status, 200, submitted.text);
  assert.equal(submitted.body.refund.status, 'SUBMITTED');
  assert.ok(submitted.body.refund.txSignature);
  assert.equal(submitted.body.status, 'PAID');
  assert.equal(withSigner.signer!.calls.filter((c) => c.context.orderId === f.orderId).length, 1);
  assert.equal(withSigner.signer!.calls.at(-1)!.context.destination, f.wallet.publicKey.toBase58());
  assert.equal(await stock(), START_STOCK, 'stock is not released before the refund finalizes');

  const pending = await verify(withSigner, f.orderId);
  assert.equal(pending.body.status, 'PAID', 'not on chain yet: still pending');
  assert.equal(pending.body.refund.status, 'SUBMITTED');

  await land(withSigner, f);
  const done = await verify(withSigner, f.orderId);
  assert.equal(done.status, 200, done.text);
  assert.equal(done.body.status, 'REFUNDED');
  assert.equal(done.body.refund.status, 'FINALIZED');
  assert.deepEqual(done.body.allowedActions, ['add-note']);
  assert.equal(await stock(), START_STOCK + QUANTITY, 'unshipped stock is released');
  assert.ok((await dbOrder(f.orderId)).inventoryReleasedAt);
  const statusEvents = (await events(f.orderId)).filter((e) => e.kind === 'STATUS');
  assert.deepEqual(statusEvents.map((e) => [e.fromStatus, e.toStatus]), [['PAID', 'REFUNDED']]);
  assert.deepEqual(done.body.events.map((e: any) => [e.kind, e.fromStatus, e.toStatus]), [['STATUS', 'PAID', 'REFUNDED']]);

  // idempotent: verifying again (or double-clicking) changes nothing and releases nothing more
  const again = await Promise.all([verify(withSigner, f.orderId), verify(withSigner, f.orderId), verify(withSigner, f.orderId)]);
  for (const r of again) assert.equal(r.body.status, 'REFUNDED');
  assert.equal(await stock(), START_STOCK + QUANTITY);
  assert.equal((await events(f.orderId)).filter((e) => e.kind === 'STATUS').length, 1);
  assert.equal((await audits(f.orderId, 'order.refund.verify')).length, 1, 'one verify audit row: only the state change is audited');

  assert.deepEqual((await audits(f.orderId)).map((a) => a.action), ['order.refund.request', 'order.refund.submit', 'order.refund.verify']);
  for (const a of await audits(f.orderId)) {
    assert.equal(a.adminId, owner.id);
    assert.equal(a.targetType, 'order');
    assert.ok(!JSON.stringify(a.detail).includes(f.wallet.publicKey.toBase58()), 'audit detail carries no wallet address');
  }
  for (const text of [requested.text, submitted.text, done.text]) {
    assert.ok(!text.includes(f.wallet.publicKey.toBase58()) && !text.includes(treasury.publicKey.toBase58()), 'responses never carry wallet addresses');
  }
});

test('full flow from PROCESSING: an order being packed can be refunded; stock is released and the event says PROCESSING -> REFUNDED', async () => {
  await resetStock();
  const f = await fixture('PROCESSING');
  assert.equal((await request(withSigner, f.orderId)).status, 200);
  assert.equal((await submit(withSigner, f.orderId)).status, 200);
  await land(withSigner, f);
  const done = await verify(withSigner, f.orderId);
  assert.equal(done.body.status, 'REFUNDED');
  assert.equal(await stock(), START_STOCK + QUANTITY);
  assert.deepEqual((await events(f.orderId)).map((e) => [e.fromStatus, e.toStatus]), [['PROCESSING', 'REFUNDED']]);
});

test('stock is released only for an unshipped order: a refund that finalizes after the order shipped restocks nothing', async () => {
  await resetStock();
  const f = await fixture('PROCESSING');
  await request(withSigner, f.orderId);
  await submit(withSigner, f.orderId);
  // The owner's ship action is blocked while the refund is in flight, so simulate the impossible-by-API case directly in the database.
  await prisma.order.update({ where: { id: f.orderId }, data: { status: 'SHIPPED' } });
  await land(withSigner, f);
  const callsBefore = (withSigner.inventory as FakeInventory).calls;
  const done = await verify(withSigner, f.orderId);
  assert.equal(done.body.status, 'REFUNDED');
  assert.equal(await stock(), START_STOCK, 'goods already left: no restock');
  assert.equal((withSigner.inventory as FakeInventory).calls, callsBefore, 'the inventory port is not even asked');
  assert.deepEqual((await events(f.orderId)).map((e) => [e.fromStatus, e.toStatus]), [['SHIPPED', 'REFUNDED']]);
  assert.equal((await dbOrder(f.orderId)).inventoryReleasedAt, null);
});

test('a refund submitted for an order that has shipped in the meantime is refused (409) before anything is signed or broadcast', async () => {
  const f = await fixture('PROCESSING');
  assert.equal((await request(withSigner, f.orderId)).status, 200);
  await prisma.order.update({ where: { id: f.orderId }, data: { status: 'SHIPPED' } });
  const callsBefore = withSigner.signer!.calls.length;
  const broadcastsBefore = withSigner.chain.broadcasts.length;
  const res = await submit(withSigner, f.orderId);
  assert.equal(res.status, 409);
  assert.match(res.body.message, /Shipped orders cannot be refunded/);
  assert.equal(withSigner.signer!.calls.length, callsBefore);
  assert.equal(withSigner.chain.broadcasts.length, broadcastsBefore);
  assert.equal((await refundRows(f.orderId))[0].status, 'PREPARED');
});

test('while a refund is submitted the order can be neither packed nor shipped (409), and packing is refused after the claim', async () => {
  const paid = await fixture('PAID');
  await request(withSigner, paid.orderId);
  await submit(withSigner, paid.orderId);
  const pack = await call(withSigner, 'POST', `/${paid.orderId}/start-packing`, {});
  assert.equal(pack.status, 409);
  assert.match(pack.body.message, /refund is in progress/i);
  assert.equal((await dbOrder(paid.orderId)).status, 'PAID');

  const packing = await fixture('PROCESSING');
  await request(withSigner, packing.orderId);
  await submit(withSigner, packing.orderId);
  const ship = await call(withSigner, 'POST', `/${packing.orderId}/ship`, { carrier: 'UPS', trackingNumber: '1Z999AA10123456784' });
  assert.equal(ship.status, 409);
  assert.equal((await dbOrder(packing.orderId)).status, 'PROCESSING');
  assert.equal(await prisma.shipment.count({ where: { orderId: packing.orderId } }), 0, 'the rolled-back ship left no shipment');
  assert.equal((await events(packing.orderId)).length, 0, 'and no STATUS event');

  // A REQUESTED (not yet submitted) refund does not block fulfilment: the owner may change their mind.
  const requestedOnly = await fixture('PAID');
  await request(withSigner, requestedOnly.orderId);
  assert.equal((await call(withSigner, 'POST', `/${requestedOnly.orderId}/start-packing`, {})).status, 200);
});

test('double click: concurrent submits sign and broadcast exactly once and all answer 200', async () => {
  const f = await fixture('PAID');
  await request(withSigner, f.orderId);
  const callsBefore = withSigner.signer!.calls.length;
  const broadcastsBefore = withSigner.chain.broadcasts.length;
  const results = await Promise.all(Array.from({ length: 6 }, () => submit(withSigner, f.orderId)));
  for (const r of results) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.refund.status, 'SUBMITTED');
  }
  assert.equal(withSigner.signer!.calls.length - callsBefore, 1, 'the signer was asked once');
  assert.equal(withSigner.chain.broadcasts.length - broadcastsBefore, 1, 'one transfer broadcast');
  assert.equal(new Set(results.map((r) => r.body.refund.txSignature)).size, 1);
  assert.equal((await audits(f.orderId, 'order.refund.submit')).length, 1);
  assert.equal((await refundRows(f.orderId)).length, 1);
  // and a later submit is still a no-op
  assert.equal((await submit(withSigner, f.orderId)).status, 200);
  assert.equal(withSigner.chain.broadcasts.length - broadcastsBefore, 1);
});

test('concurrent requests create exactly one refund (one at a time per order)', async () => {
  const f = await fixture('PAID');
  const results = await Promise.all(Array.from({ length: 5 }, () => request(withSigner, f.orderId)));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  for (const r of results.filter((x) => x.status !== 200)) assert.equal(r.status, 409);
  assert.equal((await refundRows(f.orderId)).length, 1);
  assert.equal((await audits(f.orderId, 'order.refund.request')).length, 1);
  const again = await request(withSigner, f.orderId);
  assert.equal(again.status, 409);
  assert.match(again.body.message, /already in progress/);
});

test('submit without a bound signer is 503 "Refund signing is not available."; the refund stays REQUESTED and nothing is broadcast', async () => {
  const f = await fixture('PAID');
  assert.equal((await request(withoutSigner, f.orderId)).status, 200, 'requesting needs no signer');
  const res = await submit(withoutSigner, f.orderId);
  assert.equal(res.status, 503);
  assert.equal(res.body.message, 'Refund signing is not available.');
  assert.equal(withoutSigner.chain.broadcasts.length, 0);
  assert.equal((await refundRows(f.orderId))[0].status, 'PREPARED');
  assert.equal((await audits(f.orderId, 'order.refund.submit')).length, 0);
  // the same refund is submittable through a stack that does have a signer
  assert.equal((await submit(withSigner, f.orderId)).status, 200);
});

test('the destination is never admin-controlled: it is the linked wallet that paid; a different linked wallet fails closed', async () => {
  const f = await fixture('PAID');
  const other = Keypair.generate().publicKey.toBase58();
  await prisma.customerWallet.update({ where: { customerId: f.customerId }, data: { address: other } });
  const res = await request(withSigner, f.orderId);
  assert.equal(res.status, 409);
  assert.match(res.body.message, /linked wallet/);
  assert.equal((await refundRows(f.orderId)).length, 0);
  assert.ok(!res.text.includes(other));
  await prisma.customerWallet.update({ where: { customerId: f.customerId }, data: { address: f.wallet.publicKey.toBase58() } });
  assert.equal((await request(withSigner, f.orderId)).status, 200);
  // relinking after the request (before submit) is caught at submit: nothing is signed
  await prisma.customerWallet.update({ where: { customerId: f.customerId }, data: { address: other } });
  const callsBefore = withSigner.signer!.calls.length;
  assert.equal((await submit(withSigner, f.orderId)).status, 409);
  assert.equal(withSigner.signer!.calls.length, callsBefore);
  // a customer without any linked wallet cannot be refunded here either
  const none = await fixture('PAID');
  await prisma.customerWallet.delete({ where: { customerId: none.customerId } });
  assert.equal((await request(withSigner, none.orderId)).status, 409);
});

test('an order with no finalized purchase cannot be refunded (409) and creates nothing', async () => {
  const f = await fixture('PAID', { withPurchase: false });
  const res = await request(withSigner, f.orderId);
  assert.equal(res.status, 409);
  assert.equal((await refundRows(f.orderId)).length, 0);
});

test('a transfer that failed on chain: refund FAILED, order untouched, stock untouched, and the owner can request a fresh refund', async () => {
  await resetStock();
  const f = await fixture('PAID');
  await request(withSigner, f.orderId);
  await submit(withSigner, f.orderId);
  await land(withSigner, f, { succeeded: false });
  const failed = await verify(withSigner, f.orderId);
  assert.equal(failed.status, 200);
  assert.equal(failed.body.status, 'PAID');
  assert.equal(failed.body.refund.status, 'FAILED');
  assert.ok(failed.body.refund.failureReason);
  assert.ok(failed.body.allowedActions.includes('refund'), 'a failed refund frees the order for a new request');
  assert.equal(await stock(), START_STOCK);
  assert.equal((await audits(f.orderId, 'order.refund.verify')).length, 1);
  const second = await request(withSigner, f.orderId);
  assert.equal(second.status, 200, second.text);
  assert.equal(second.body.refund.status, 'REQUESTED');
  assert.notEqual(second.body.refund.id, failed.body.refund.id);
  assert.equal(second.body.refund.amountAtomic, PRICE_ATOMIC.toString());
  assert.equal((await refundRows(f.orderId)).length, 2);
});

test('a transfer that does not match the refund (wrong destination) is FAILED, never finalized', async () => {
  const f = await fixture('PAID');
  await request(withSigner, f.orderId);
  await submit(withSigner, f.orderId);
  await land(withSigner, f, { destinationOwner: Keypair.generate().publicKey.toBase58() });
  const res = await verify(withSigner, f.orderId);
  assert.equal(res.body.refund.status, 'FAILED');
  assert.equal(res.body.status, 'PAID');
});

test('stock release is atomic with the status flip: if the inventory port fails the refund is not finalized, and a retry finalizes once', async () => {
  await resetStock();
  const f = await fixture('PAID');
  await request(withSigner, f.orderId);
  await submit(withSigner, f.orderId);
  await land(withSigner, f);
  (withSigner.inventory as FakeInventory).failing = true;
  try {
    const broken = await verify(withSigner, f.orderId);
    assert.equal(broken.status >= 500, true, `expected a server error, got ${broken.status}`);
    assert.equal((await dbOrder(f.orderId)).status, 'PAID', 'the order status flip rolled back with the failed release');
    assert.equal((await events(f.orderId)).length, 0, 'and so did the event');
    assert.equal((await refundRows(f.orderId))[0].status, 'SUBMITTED', 'the refund can be verified again');
    assert.equal(await stock(), START_STOCK);
  } finally {
    (withSigner.inventory as FakeInventory).failing = false;
  }
  const done = await verify(withSigner, f.orderId);
  assert.equal(done.body.status, 'REFUNDED');
  assert.equal(await stock(), START_STOCK + QUANTITY);
  assert.equal((await events(f.orderId)).length, 1);
});

test('concurrent first verifies of a landed refund finalize once: one REFUNDED event, one restock', async () => {
  await resetStock();
  const f = await fixture('PAID');
  await request(withSigner, f.orderId);
  await submit(withSigner, f.orderId);
  await land(withSigner, f);
  const results = await Promise.all(Array.from({ length: 6 }, () => verify(withSigner, f.orderId)));
  for (const r of results) assert.equal(r.body.status, 'REFUNDED');
  assert.equal(await stock(), START_STOCK + QUANTITY);
  assert.equal((await events(f.orderId)).filter((e) => e.toStatus === 'REFUNDED').length, 1);
});

test('verify with no refund is 409; the refund object is null and allowedActions unchanged on orders that never had one', async () => {
  const f = await fixture('PAID');
  assert.equal((await verify(withSigner, f.orderId)).status, 409);
  assert.equal((await submit(withSigner, f.orderId)).status, 409);
  const detail = await call(withSigner, 'GET', `/${f.orderId}`);
  assert.equal(detail.body.refund, null);
  assert.deepEqual(detail.body.allowedActions, ['start-packing', 'refund', 'add-note']);
});

test('race: shipping and submitting the refund at the same moment never leaves a SHIPPED order with a submitted refund', async () => {
  const outcomes = new Set<string>();
  for (let round = 0; round < 8; round++) {
    const f = await fixture('PROCESSING');
    assert.equal((await request(withSigner, f.orderId)).status, 200);
    const [ship, pay] = await Promise.all([
      call(withSigner, 'POST', `/${f.orderId}/ship`, { carrier: 'UPS', trackingNumber: `1Z-RACE-${round}-${tag}` }),
      submit(withSigner, f.orderId),
    ]);
    const order = await dbOrder(f.orderId);
    const [refund] = await refundRows(f.orderId);
    if (order.status === 'SHIPPED') {
      assert.equal(ship.status, 200, ship.text);
      assert.equal(pay.status, 409, `the refund must be refused once the order shipped (got ${pay.status})`);
      assert.equal(refund.status, 'PREPARED', 'nothing was claimed or broadcast for a shipped order');
      assert.equal(refund.txSignature, null);
      outcomes.add('shipped');
    } else {
      assert.equal(order.status, 'PROCESSING');
      assert.equal(ship.status, 409, `shipping must be refused once the refund is submitted (got ${ship.status})`);
      assert.equal(pay.status, 200, pay.text);
      assert.equal(refund.status, 'SUBMITTED');
      assert.equal(await prisma.shipment.count({ where: { orderId: f.orderId } }), 0);
      outcomes.add('refunding');
    }
  }
  assert.ok(outcomes.size >= 1);
});

test('with the REAL InventoryService: the reserved units come back exactly once through the ledger (ORDER_RELEASE) in the same transaction as REFUNDED', async () => {
  await resetStock();
  const f = await fixture('PROCESSING');
  // What order creation leaves behind: one ORDER_RESERVE ledger row per product (the stock itself is START_STOCK after the hold).
  await prisma.inventoryAdjustment.create({ data: { productId: product.id, delta: -QUANTITY, kind: 'ORDER_RESERVE', orderId: f.orderId } });
  assert.equal((await request(withRealStock, f.orderId)).status, 200);
  assert.equal((await submit(withRealStock, f.orderId)).status, 200);
  assert.equal(await stock(), START_STOCK, 'nothing is released before the refund finalizes');
  await land(withRealStock, f);
  const done = await Promise.all([verify(withRealStock, f.orderId), verify(withRealStock, f.orderId), verify(withRealStock, f.orderId)]);
  for (const r of done) assert.equal(r.body.status, 'REFUNDED');
  assert.equal(await stock(), START_STOCK + QUANTITY, 'stock back exactly once');
  const released = await prisma.inventoryAdjustment.findMany({ where: { orderId: f.orderId, kind: 'ORDER_RELEASE' } });
  assert.equal(released.length, 1);
  assert.equal(released[0].delta, QUANTITY);
  assert.match(released[0].reason ?? '', /^refund:/);
  assert.ok((await dbOrder(f.orderId)).inventoryReleasedAt);
  assert.equal((await events(f.orderId)).filter((e) => e.toStatus === 'REFUNDED').length, 1);
});
