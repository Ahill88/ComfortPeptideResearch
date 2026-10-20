/**
 * END-TO-END CONTRACT + CONCURRENCY against REAL PostgreSQL.
 *
 *   TEST_DATABASE_URL=postgresql://helix@127.0.0.1:54329/helix_field?schema=public \
 *   NODE_ENV=test pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only ../../tests/wallet/e2e.integration.test.ts
 *
 * Boots the real Nest wallet + checkout + orders modules (real Prisma, factory-built sandbox chain) over HTTP and
 * drives them ONLY through the real storefront client (apps/storefront/lib/wallet/api.ts). That is what catches
 * client/API field-name drift, and real Postgres is what exposes transaction/uniqueness behavior fakes cannot.
 *
 * Fails loudly without TEST_DATABASE_URL (tests/run-all.mjs reports this file as SKIPPED instead of running it).
 * Refuses to run against anything but a local database whose name contains "helix" or "test", because it TRUNCATES.
 * The customer's key is a throwaway Keypair created inside this test: the customer's own key, never the platform's.
 */
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { createRequire } from 'node:module';
import * as path from 'node:path';

// This file lives outside apps/api, so resolve dependencies from there (same approach as sandbox-scenario.test.ts).
const apiRequire = createRequire(path.join(__dirname, '../../apps/api/package.json'));
const { Keypair, Transaction } = apiRequire('@solana/web3.js') as typeof import('@solana/web3.js');
type Keypair = import('@solana/web3.js').Keypair;

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for the integration suite (run tests/run-all.mjs to see it reported as SKIPPED).');
const parsed = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || !/helix|test/i.test(parsed.pathname)) {
  throw new Error(`Refusing to run: ${parsed.hostname}${parsed.pathname} is not a local helix/test database (this suite truncates tables).`);
}
process.env.DATABASE_URL = url;
process.env.NODE_ENV = process.env.NODE_ENV === 'production' ? 'test' : process.env.NODE_ENV ?? 'test';
delete process.env.WALLET_CHAIN_MODE; // factory default = sandbox, auto-finalizing
const treasury = Keypair.generate().publicKey.toBase58();
process.env.SOLANA_USDC_TREASURY = treasury;

type Client = typeof import('../../apps/storefront/lib/wallet/api');
let app: import('@nestjs/common').INestApplication;
let prisma: import('../../apps/api/src/prisma.service').PrismaService;
let client: Client;
let base = '';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sign = (unsignedBase64: string, key: Keypair) => {
  const tx = Transaction.from(Buffer.from(unsignedBase64, 'base64'));
  tx.partialSign(key);
  return tx.serialize().toString('base64');
};

before(async () => {
  const { Global, Module, ValidationPipe } = await import('@nestjs/common');
  const { Test } = await import('@nestjs/testing');
  const { PrismaService } = await import('../../apps/api/src/prisma.service');
  const { WalletModule } = await import('../../apps/api/src/wallet/wallet.module');
  const { CheckoutModule } = await import('../../apps/api/src/wallet/checkout/checkout.module');
  const { checkoutPortProviders } = await import('../../apps/api/src/wallet/wallet.wiring');
  const { OrdersModule } = await import('../../apps/api/src/orders/orders.module');

  const realPrisma = new PrismaService();
  await realPrisma.$connect();
  prisma = realPrisma;
  await prisma.$executeRawUnsafe(
    'TRUNCATE "WalletAuditEvent","CreditReservation","CryptoTransaction","OnRampIntent","BalanceSnapshot","DelegatedPermission","CustomerWallet","OrderItem","Payment","LedgerEntry","Order","Lot","Product","Customer" RESTART IDENTITY CASCADE',
  );
  @Global()
  @Module({ providers: [{ provide: PrismaService, useValue: realPrisma }], exports: [PrismaService] })
  class RealPrismaModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [RealPrismaModule, WalletModule, OrdersModule, CheckoutModule.register({ imports: [WalletModule], providers: checkoutPortProviders })],
  }).compile();
  app = moduleRef.createNestApplication({ logger: process.env.E2E_LOG ? ['error', 'warn'] : false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  process.env.NEXT_PUBLIC_API_URL = `${base}/v1`; // the client reads this at import time
  client = await import('../../apps/storefront/lib/wallet/api');
});

after(async () => {
  await app?.close();
  await prisma?.$disconnect();
});

/** The customer's wallet proving key control: signs the link message with the throwaway Keypair (node:crypto, ed25519 detached). */
function walletSigner(key: Keypair) {
  const { createPrivateKey, sign } = require('node:crypto') as typeof import('node:crypto');
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(key.secretKey.slice(0, 32))]);
  return async (message: string) => sign(null, Buffer.from(message, 'utf8'), createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })).toString('base64');
}

/** Seeds (or changes) the customer's persisted eligibility decision. Checkout is gated on APPROVED. */
async function setEligibility(email: string, status: 'APPROVED' | 'PENDING' | 'REJECTED') {
  const customer = await prisma.customer.findUniqueOrThrow({ where: { email } });
  await prisma.customerEligibility.upsert({
    where: { customerId: customer.id },
    create: { customerId: customer.id, status, ...(status === 'APPROVED' ? { reviewedAt: new Date(), reviewedBy: 'e2e-seed' } : {}) },
    update: { status },
  });
}

/**
 * Create a funded customer and a priced order through the real API. The customer is seeded APPROVED (the checkout
 * eligibility gate stays enforced; pass approved=false to exercise it).
 */
async function setup(label: string, fundCents: number, priceCents: number, approved = true) {
  const email = `${label}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const key = Keypair.generate();
  await client.registerWallet(email, key.publicKey.toBase58(), 'sandbox', walletSigner(key));
  if (approved) await setEligibility(email, 'APPROVED');
  const quote = await client.createOnrampQuote(email, fundCents);
  await client.mockCompleteOnramp(email, quote.intentId);
  const sku = `SKU-${label}-${Math.random().toString(36).slice(2, 8)}`;
  const product = await prisma.product.create({ data: { sku, slug: sku.toLowerCase(), name: label, active: true, priceCents, inventory: 10 } });
  await prisma.lot.create({ data: { code: `LOT-${sku}`, productId: product.id, coaKey: 'coa/test.pdf', purity: 99 } });
  const res = await fetch(`${base}/v1/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `order-${sku}-0001` },
    body: JSON.stringify({ email, shippingAddress: '1 Lab Way, Boston, MA', researchUseAcknowledged: true, items: [{ productId: product.id, lotCode: `LOT-${sku}`, quantity: 1 }] }),
  });
  const order = (await res.json()) as { id: string };
  assert.equal(res.status, 201, `order creation failed: ${JSON.stringify(order)} (sent productId=${product.id} lot=LOT-${sku})`);
  return { email, key, orderId: order.id, priceCents };
}

async function settleViaPolling(email: string, orderId: string) {
  for (let i = 0; i < 30; i++) {
    const status = await client.fetchCheckoutStatus(email, orderId);
    if (status.phase === 'finalized' || status.phase === 'failed') return status;
    await sleep(40);
  }
  throw new Error('checkout never reached a terminal phase');
}

test('journey through the real storefront client: link, fund, send, pay, balance falls by exactly the price', async () => {
  const email = `journey-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const key = Keypair.generate();
  const address = key.publicKey.toBase58();

  assert.equal(await client.fetchWallet(email), null);
  await client.registerWallet(email, address, 'sandbox', walletSigner(key));
  const wallet = await client.fetchWallet(email);
  assert.ok(wallet, 'fetchWallet must see the linked wallet (API nests it under `wallet`)');
  assert.equal(wallet.address, address);
  assert.equal(wallet.provider, 'sandbox');
  await setEligibility(email, 'APPROVED'); // checkout is gated on an APPROVED CustomerEligibility

  const quote = await client.createOnrampQuote(email, 5_000);
  assert.equal(quote.sandbox, true);
  assert.ok(quote.widgetUrl.length > 0, 'widgetUrl must be read from the nested quote');
  assert.equal(quote.estimatedUsdcAtomic, null, 'no invented USDC estimate');
  assert.equal((await client.fetchBalance(email)).spendableAtomic, 0n, 'credits must not appear before USDC arrives');
  await client.mockCompleteOnramp(email, quote.intentId);
  const funded = await client.fetchBalance(email);
  assert.equal(funded.spendableAtomic, 5_000_000n * 10n); // $50.00 sandbox deposit = 50 USDC
  assert.equal(funded.researchCredits, 50n);

  // external transfer
  const destination = Keypair.generate().publicKey.toBase58();
  const prepared = await client.prepareTransfer(email, { destination, amountAtomic: 5_000_000n });
  assert.equal(prepared.amountAtomic, 5_000_000n);
  assert.ok(prepared.feeLamports !== null && prepared.feeLamports > 0n, 'fee is read from fee.estimatedTotalLamports');
  const sent = await client.submitTransfer(email, prepared.id, sign(prepared.unsignedTransactionBase64, key));
  assert.ok(sent.signature.length >= 64, 'signature is read from txSignature');
  const history = await client.fetchTransactions(email);
  const withdrawal = history.find((t) => t.type === 'WITHDRAWAL');
  assert.ok(withdrawal);
  assert.equal(withdrawal.signature, sent.signature);
  assert.equal(withdrawal.counterparty, destination, 'withdrawal counterparty is the destination');
  assert.equal(withdrawal.status, 'finalized');
  const deposit = history.find((t) => t.type === 'DEPOSIT');
  assert.ok(deposit);
  assert.equal(deposit.counterparty !== destination, true);
  assert.equal((await client.fetchBalance(email)).spendableAtomic, 45_000_000n);

  // pay with credits for a 2 x $19.99 style order ($39.98)
  const sku = `SKU-journey-${Math.random().toString(36).slice(2, 8)}`;
  const product = await prisma.product.create({ data: { sku, slug: sku.toLowerCase(), name: 'Journey', active: true, priceCents: 1_999, inventory: 10 } });
  await prisma.lot.create({ data: { code: `LOT-${sku}`, productId: product.id, coaKey: 'coa/test.pdf', purity: 99 } });
  const res = await fetch(`${base}/v1/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `order-${sku}-0001` },
    body: JSON.stringify({ email, shippingAddress: '1 Lab Way, Boston, MA', researchUseAcknowledged: true, items: [{ productId: product.id, lotCode: `LOT-${sku}`, quantity: 2 }] }),
  });
  const order = (await res.json()) as { id: string; totalCents: number };
  assert.equal(order.totalCents, 3_998);

  const checkout = await client.prepareCheckout(email, order.id);
  assert.equal(checkout.amountAtomic, 39_980_000n);
  assert.equal(checkout.merchant, treasury);
  assert.equal(checkout.network, 'solana-devnet');
  assert.equal((await client.fetchCheckoutStatus(email, order.id)).phase, 'awaiting');
  await client.submitCheckout(email, order.id, sign(checkout.unsignedTransactionBase64, key));
  const final = await settleViaPolling(email, order.id);
  assert.equal(final.phase, 'finalized', `expected finalized, got ${final.phase} (${final.rawStatus})`);

  const after = await client.fetchBalance(email);
  assert.equal(after.finalizedAtomic, 45_000_000n - 39_980_000n, 'USDC fell by exactly the price');
  assert.equal(after.spendableAtomic, 5_020_000n, 'no separate credit deduction on top of the transfer');
  assert.equal(after.researchCredits, 5n);
  const purchase = (await client.fetchTransactions(email)).find((t) => t.type === 'PURCHASE');
  assert.ok(purchase);
  assert.equal(purchase.status, 'finalized');
  assert.equal(purchase.counterparty, treasury);
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status, 'PAID');
});

test('authorization: the platform rejects unsigned, forged-signature, and tampered transactions', async () => {
  const s = await setup('auth', 10_000, 2_500);
  const prepared = await client.prepareCheckout(s.email, s.orderId);
  const customer = s.key.publicKey;

  // 1) unsigned
  await assert.rejects(client.submitCheckout(s.email, s.orderId, prepared.unsignedTransactionBase64), /./, 'unsigned must be rejected');

  // 2) forged signature: right slot, bytes not produced by the customer's key (a different key cannot fill the slot legitimately)
  const forged = Transaction.from(Buffer.from(prepared.unsignedTransactionBase64, 'base64'));
  forged.addSignature(customer, Buffer.alloc(64, 7));
  await assert.rejects(client.submitCheckout(s.email, s.orderId, forged.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')), /./, 'a forged signature must be rejected');

  // 3) tampered message, validly signed by the customer: the platform must only broadcast exactly what it prepared
  const tampered = Transaction.from(Buffer.from(prepared.unsignedTransactionBase64, 'base64'));
  tampered.recentBlockhash = Keypair.generate().publicKey.toBase58(); // any change to the signed message
  tampered.partialSign(s.key);
  await assert.rejects(client.submitCheckout(s.email, s.orderId, tampered.serialize().toString('base64')), /./, 'a tampered message must be rejected even with the customer signature');

  const rows = await prisma.cryptoTransaction.findMany({ where: { orderId: s.orderId } });
  assert.ok(rows.every((r) => r.txSignature === null), 'nothing may be broadcast');
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: s.orderId } })).status, 'PENDING_PAYMENT');
  assert.equal((await client.fetchBalance(s.email)).finalizedAtomic, 100_000_000n, 'no funds moved');

  // 4) and the genuine, customer-signed payload still goes through afterwards
  await client.submitCheckout(s.email, s.orderId, sign(prepared.unsignedTransactionBase64, s.key));
  assert.equal((await settleViaPolling(s.email, s.orderId)).phase, 'finalized');
});

test('eligibility gate: an unapproved customer gets 403 on prepare and submit, with no reservation and nothing broadcast', async () => {
  for (const status of [null, 'PENDING', 'REJECTED'] as const) {
    const s = await setup(`elig-${status ?? 'none'}`.toLowerCase(), 10_000, 2_500, false);
    if (status) await setEligibility(s.email, status);
    await assert.rejects(client.prepareCheckout(s.email, s.orderId), (e: any) => e.status === 403, `prepare must be 403 for ${status ?? 'no record'}`);
    assert.equal(await prisma.creditReservation.count({ where: { orderId: s.orderId } }), 0, 'no reservation');
    assert.equal(await prisma.cryptoTransaction.count({ where: { orderId: s.orderId } }), 0, 'no purchase row');
    // The gate runs before the payload is even decoded, so any DTO-valid base64 body gets 403 (not 400) and nothing is claimed.
    await assert.rejects(client.submitCheckout(s.email, s.orderId, 'A'.repeat(64)), (e: any) => e.status === 403, 'submit must be 403');
    assert.equal(await prisma.cryptoTransaction.count({ where: { orderId: s.orderId } }), 0);
  }
});

test('eligibility gate: approved customer works; approval revoked between prepare and submit => submit 403 and nothing broadcast', async () => {
  const s = await setup('elig-revoke', 10_000, 2_500);
  const prepared = await client.prepareCheckout(s.email, s.orderId);
  const signed = sign(prepared.unsignedTransactionBase64, s.key);
  await setEligibility(s.email, 'REJECTED');
  await assert.rejects(client.submitCheckout(s.email, s.orderId, signed), (e: any) => e.status === 403, 'revoked approval must not be usable after prepare');
  const rows = await prisma.cryptoTransaction.findMany({ where: { orderId: s.orderId, type: 'PURCHASE' } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'PREPARED');
  assert.equal(rows[0].txSignature, null, 'nothing was broadcast or claimed');
  assert.equal((await client.fetchBalance(s.email)).finalizedAtomic, 100_000_000n, 'no funds moved');
  // Re-approval lets the very same signed payload through.
  await setEligibility(s.email, 'APPROVED');
  await client.submitCheckout(s.email, s.orderId, signed);
  assert.equal((await settleViaPolling(s.email, s.orderId)).phase, 'finalized');
});

test('isolation and insufficient funds', async () => {
  const owner = await setup('owner', 10_000, 2_500);
  const intruder = await setup('intruder', 10_000, 2_500);
  await assert.rejects(client.fetchCheckoutStatus(intruder.email, owner.orderId), (e: any) => e.status === 404);
  await assert.rejects(client.prepareCheckout(intruder.email, owner.orderId), (e: any) => e.status === 404);

  const poor = await setup('poor', 1_000, 5_000); // $10 funded, $50 order
  await assert.rejects(client.prepareCheckout(poor.email, poor.orderId), (e: any) => e.status === 400 || e.status === 402 || e.status === 409);
  assert.equal(await prisma.creditReservation.count({ where: { orderId: poor.orderId } }), 0, 'no reservation for an unaffordable order');
});

test('concurrency: 10 parallel prepares for one order create exactly one reservation and one purchase row', async () => {
  const s = await setup('race-prepare', 20_000, 3_000);
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => client.prepareCheckout(s.email, s.orderId)));
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  const serverErrors = rejected.filter((r) => (r.reason?.status ?? 0) >= 500);
  assert.equal(serverErrors.length, 0, `unexpected 5xx under concurrency: ${serverErrors.map((r) => r.reason?.message).join(' | ')}`);
  assert.ok(results.some((r) => r.status === 'fulfilled'), 'at least one prepare must succeed');
  assert.equal(await prisma.creditReservation.count({ where: { orderId: s.orderId } }), 1);
  assert.equal(await prisma.cryptoTransaction.count({ where: { orderId: s.orderId, type: 'PURCHASE' } }), 1);
});

test('concurrency: parallel status polls settle exactly once', async () => {
  const s = await setup('race-settle', 20_000, 3_000);
  const prepared = await client.prepareCheckout(s.email, s.orderId);
  await client.submitCheckout(s.email, s.orderId, sign(prepared.unsignedTransactionBase64, s.key));
  await Promise.allSettled(Array.from({ length: 12 }, () => client.fetchCheckoutStatus(s.email, s.orderId)));
  const final = await settleViaPolling(s.email, s.orderId);
  assert.equal(final.phase, 'finalized');
  const settledEvents = await prisma.walletAuditEvent.count({ where: { action: 'checkout.settled', detail: { path: ['orderId'], equals: s.orderId } } });
  assert.equal(settledEvents, 1, 'exactly one settlement audit record');
  const reservation = await prisma.creditReservation.findUniqueOrThrow({ where: { orderId: s.orderId } });
  assert.equal(reservation.status, 'CONSUMED');
  assert.equal(await prisma.cryptoTransaction.count({ where: { orderId: s.orderId, status: 'FINALIZED' } }), 1);
  const balance = await client.fetchBalance(s.email);
  assert.equal(balance.finalizedAtomic, 200_000_000n - 30_000_000n, 'charged once');
});

test('concurrency: duplicate parallel submits of one signed payload broadcast once', async () => {
  const s = await setup('race-submit', 20_000, 3_000);
  const prepared = await client.prepareCheckout(s.email, s.orderId);
  const signed = sign(prepared.unsignedTransactionBase64, s.key);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => client.submitCheckout(s.email, s.orderId, signed)));
  assert.equal(results.filter((r) => r.status === 'rejected' && ((r as PromiseRejectedResult).reason?.status ?? 0) >= 500).length, 0, 'no 5xx');
  const rows = await prisma.cryptoTransaction.findMany({ where: { orderId: s.orderId, type: 'PURCHASE' } });
  assert.equal(rows.length, 1);
  assert.ok(rows[0].txSignature, 'exactly one signature recorded');
  const final = await settleViaPolling(s.email, s.orderId);
  assert.equal(final.phase, 'finalized');
  assert.equal((await client.fetchBalance(s.email)).finalizedAtomic, 200_000_000n - 30_000_000n);
});

test('concurrency: two orders that together exceed the balance can never both be paid', async () => {
  const s = await setup('overspend-a', 5_000, 3_000); // $50 funded, $30 order
  const sku = `SKU-b-${Math.random().toString(36).slice(2, 8)}`;
  const product = await prisma.product.create({ data: { sku, slug: sku.toLowerCase(), name: 'B', active: true, priceCents: 3_000, inventory: 10 } });
  await prisma.lot.create({ data: { code: `LOT-${sku}`, productId: product.id, coaKey: 'c', purity: 99 } });
  const res = await fetch(`${base}/v1/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `order-${sku}-0001` },
    body: JSON.stringify({ email: s.email, shippingAddress: '1 Lab Way, Boston, MA', researchUseAcknowledged: true, items: [{ productId: product.id, lotCode: `LOT-${sku}`, quantity: 1 }] }),
  });
  const second = (await res.json()) as { id: string };

  const prepared = await Promise.allSettled([client.prepareCheckout(s.email, s.orderId), client.prepareCheckout(s.email, second.id)]);
  const ok = prepared.filter((p) => p.status === 'fulfilled').length;
  assert.ok(ok >= 1);
  // Whatever prepare allowed, the sum actually PAID can never exceed what the wallet held.
  for (const [i, p] of prepared.entries()) {
    if (p.status !== 'fulfilled') continue;
    const orderId = i === 0 ? s.orderId : second.id;
    await client.submitCheckout(s.email, orderId, sign(p.value.unsignedTransactionBase64, s.key)).catch(() => undefined);
  }
  await sleep(200);
  for (const orderId of [s.orderId, second.id]) await client.fetchCheckoutStatus(s.email, orderId).catch(() => undefined);
  const paid = await prisma.order.count({ where: { id: { in: [s.orderId, second.id] }, status: 'PAID' } });
  const balance = await client.fetchBalance(s.email);
  assert.ok(paid <= 1, `both orders paid with only $50 for $60 of orders (paid=${paid})`);
  assert.ok(balance.finalizedAtomic >= 0n);
  assert.equal(balance.finalizedAtomic, 50_000_000n - BigInt(paid) * 30_000_000n);
});

test('database enforces uniqueness the application relies on', async () => {
  const rows = await prisma.$queryRawUnsafe<{ tablename: string; indexdef: string }[]>(
    `select tablename, indexdef from pg_indexes where schemaname='public' and indexdef ilike '%unique%'`,
  );
  // pg_indexes prints identifiers unquoted when they are plain lowercase, quoted otherwise (e.g. ("txSignature")).
  const has = (table: string, column: string) => rows.some((r) => r.tablename === table && new RegExp(`\\("?${column}"?\\)`).test(r.indexdef));
  assert.ok(has('CryptoTransaction', 'txSignature'), 'txSignature must be unique (replay protection)');
  assert.ok(has('CryptoTransaction', 'reference'), 'reference must be unique');
  assert.ok(has('CreditReservation', 'orderId'), 'one reservation per order');
  assert.ok(has('CustomerWallet', 'address'), 'a wallet address belongs to one customer');
  assert.ok(has('CustomerWallet', 'customerId'), 'one wallet per customer');
});
