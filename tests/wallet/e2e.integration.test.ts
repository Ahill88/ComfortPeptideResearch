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
  // COMPLIANCE_SCREEN is provided by the global SanctionsModule in the app; this fixture binds allow-all (sanctions have their own suites).
  const { COMPLIANCE_SCREEN: SCREEN_TOKEN } = await import('../../apps/api/src/wallet/wallet.tokens');
  const { AllowAllComplianceScreen } = await import('../../apps/api/src/wallet/transfers/compliance-screen');
  @Global()
  @Module({ providers: [{ provide: SCREEN_TOKEN, useFactory: () => new AllowAllComplianceScreen() }], exports: [SCREEN_TOKEN] })
  class AllowAllScreenModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [RealPrismaModule, AllowAllScreenModule, WalletModule, OrdersModule, CheckoutModule.register({ imports: [WalletModule], providers: checkoutPortProviders })],
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
  assert.equal(quote.simulationAvailable, true, 'sandbox chain: simulation is advertised and then works (mockCompleteOnramp below)');
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

// ---------------------------------------------------------------------------------------------
// Order-linked on-ramp top-up: POST /v1/wallet/onramp/order-topup
// ---------------------------------------------------------------------------------------------

async function orderTopUpRaw(email: string, orderId: unknown) {
  const res = await fetch(`${base}/v1/wallet/onramp/order-topup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-customer-email': email },
    body: JSON.stringify({ orderId }),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

test('order top-up: shortfall -> on-ramp to the customer wallet -> auto-complete payment signed by the customer key; treasury never a destination', async () => {
  // $1.00 funded, $2.50 order: shortfall 1.50 USDC, rounded UP to whole dollars => $2.
  const s = await setup('topup-loop', 100, 250);
  const wallet = await client.fetchWallet(s.email);
  assert.ok(wallet);
  assert.equal((await client.fetchBalance(s.email)).spendableAtomic, 1_000_000n);
  await assert.rejects(client.prepareCheckout(s.email, s.orderId), (e: any) => e.status === 402, 'prepare refuses while short');

  const topUp = await client.createOrderTopUp(s.email, s.orderId);
  assert.ok(topUp.topUpNeeded);
  assert.equal(topUp.orderId, s.orderId);
  assert.equal(topUp.requiredAtomic, 2_500_000n);
  assert.equal(topUp.spendableAtomic, 1_000_000n);
  assert.equal(topUp.shortfallAtomic, 1_500_000n);
  assert.equal(topUp.topUpUsdCents, 200);
  assert.equal(topUp.status, 'CREATED');
  assert.equal(topUp.merchant, treasury, 'the consent screen can show the exact merchant before the customer agrees');
  assert.equal(topUp.quote.sandbox, true);
  assert.ok(topUp.quote.widgetUrl.length > 0);

  // Wire shape: exact contract field names, BigInts as decimal strings, quote shaped like POST /wallet/onramp.
  const raw = await orderTopUpRaw(s.email, s.orderId);
  assert.equal(raw.status, 200);
  assert.deepEqual(Object.keys(raw.body).sort(), ['intentId', 'merchant', 'orderId', 'quote', 'requiredAtomic', 'shortfallAtomic', 'spendableAtomic', 'status', 'topUpNeeded', 'topUpUsdCents']);
  assert.equal(raw.body.merchant, treasury, 'the wire response names the merchant treasury');
  assert.equal(raw.body.intentId, topUp.intentId, 'repeat is idempotent');
  assert.equal(raw.body.requiredAtomic, '2500000');
  assert.equal(raw.body.spendableAtomic, '1000000');
  assert.equal(raw.body.shortfallAtomic, '1500000');
  assert.equal(raw.body.topUpUsdCents, 200);
  assert.equal(raw.body.quote.destinationAddress, wallet.address);
  const plain = await client.createOnrampQuote(s.email, 200);
  assert.ok(plain.intentId);
  const plainRaw = await (await fetch(`${base}/v1/wallet/onramp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-customer-email': s.email }, body: JSON.stringify({ amountUsdCents: 200 }) })).json();
  assert.deepEqual(Object.keys(raw.body.quote).sort(), Object.keys(plainRaw.quote).sort(), 'quote has exactly the POST /wallet/onramp shape');
  // Additive contract: the quote (never the top-level response) carries simulationAvailable. The e2e API runs the in-memory sandbox chain, so it is true on both routes.
  const quoteKeys = ['destinationAddress', 'disclosures', 'estimatedFeeUsdCents', 'estimatedUsdcAtomic', 'intendedUsdCents', 'provider', 'sandbox', 'simulationAvailable', 'widgetUrl'];
  assert.deepEqual(Object.keys(raw.body.quote).sort(), quoteKeys);
  assert.deepEqual(Object.keys(plainRaw.quote).sort(), quoteKeys);
  assert.equal(raw.body.quote.simulationAvailable, true);
  assert.equal(plainRaw.quote.simulationAvailable, true);
  assert.equal(topUp.quote.simulationAvailable, true, 'the storefront client reads the flag from the order top-up quote');
  assert.equal(plain.simulationAvailable, true, 'the storefront client reads the flag from the on-ramp quote');

  const intent = await prisma.onRampIntent.findUniqueOrThrow({ where: { id: topUp.intentId } });
  assert.equal(intent.orderId, s.orderId);
  assert.equal(intent.destinationAddress, wallet.address);
  assert.notEqual(intent.destinationAddress, treasury);
  assert.equal(intent.intendedUsdCents, 200);
  assert.equal(await prisma.onRampIntent.count({ where: { orderId: s.orderId } }), 1, 'the repeat created no second intent');
  assert.equal(
    await prisma.walletAuditEvent.count({ where: { action: 'ONRAMP_ORDER_TOPUP_CREATED', detail: { path: ['orderId'], equals: s.orderId } } }),
    1,
  );
  assert.equal((await client.fetchBalance(s.email)).spendableAtomic, 1_000_000n, 'an intent alone credits nothing');
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: s.orderId } })).status, 'PENDING_PAYMENT');

  // The purchase "completes": USDC lands in the customer's own wallet and only then does spendable rise.
  await client.mockCompleteOnramp(s.email, topUp.intentId);
  const after = await client.fetchBalance(s.email);
  assert.equal(after.spendableAtomic, 3_000_000n);
  assert.ok(after.spendableAtomic >= topUp.requiredAtomic);
  const recheck = await client.createOrderTopUp(s.email, s.orderId);
  assert.equal(recheck.topUpNeeded, false, 'once funded the checkout needs no further top-up');
  assert.equal(recheck.spendableAtomic, 3_000_000n);

  // The browser then pays with the customer's own key.
  const prepared = await client.prepareCheckout(s.email, s.orderId);
  assert.equal(prepared.amountAtomic, 2_500_000n);
  assert.equal(prepared.merchant, treasury);
  await client.submitCheckout(s.email, s.orderId, sign(prepared.unsignedTransactionBase64, s.key));
  const final = await settleViaPolling(s.email, s.orderId);
  assert.equal(final.phase, 'finalized', `expected finalized, got ${final.phase} (${final.rawStatus})`);
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: s.orderId } })).status, 'PAID');
  assert.equal((await client.fetchBalance(s.email)).finalizedAtomic, 500_000n, '3.00 funded - 2.50 paid');

  // Treasury is the payee of the purchase only; it is never an on-ramp destination or a deposit destination.
  const customer = await prisma.customer.findUniqueOrThrow({ where: { email: s.email } });
  const customerIntents = await prisma.onRampIntent.findMany({ where: { customerId: customer.id } });
  assert.ok(customerIntents.length >= 2);
  assert.ok(customerIntents.every((i) => i.destinationAddress === wallet.address && i.destinationAddress !== treasury));
  const deposits = await prisma.cryptoTransaction.findMany({ where: { customerId: customer.id, type: 'DEPOSIT' } });
  assert.ok(deposits.every((d) => d.destinationAddress === wallet.address && d.destinationAddress !== treasury));
  const purchases = await prisma.cryptoTransaction.findMany({ where: { customerId: customer.id, type: 'PURCHASE' } });
  assert.ok(purchases.every((p) => p.sourceAddress === wallet.address && p.destinationAddress === treasury));
});

test('order top-up: enough funds => topUpNeeded false and no intent', async () => {
  const s = await setup('topup-rich', 10_000, 2_500); // $100 funded, $25 order
  const before = await prisma.onRampIntent.count({ where: { orderId: s.orderId } });
  const res = await orderTopUpRaw(s.email, s.orderId);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { topUpNeeded: false, orderId: s.orderId, requiredAtomic: '25000000', spendableAtomic: '100000000' });
  assert.equal(await prisma.onRampIntent.count({ where: { orderId: s.orderId } }), before);
  assert.equal(before, 0);
});

test("order top-up: other customer's order is 404, a missing order is 404, bad body is 400, no identity is 401", async () => {
  const owner = await setup('topup-owner', 100, 500);
  const intruder = await setup('topup-intruder', 100, 500);
  const foreign = await orderTopUpRaw(intruder.email, owner.orderId);
  const missing = await orderTopUpRaw(intruder.email, 'no-such-order');
  assert.equal(foreign.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(foreign.body.message, missing.body.message, 'a foreign order is indistinguishable from a missing one');
  assert.equal(await prisma.onRampIntent.count({ where: { orderId: owner.orderId } }), 0);
  assert.equal((await orderTopUpRaw(owner.email, undefined)).status, 400);
  assert.equal((await orderTopUpRaw(owner.email, { $ne: null })).status, 400);
  const anonymous = await fetch(`${base}/v1/wallet/onramp/order-topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orderId: owner.orderId }) });
  assert.equal(anonymous.status, 401);
});

test('order top-up: a non-PENDING_PAYMENT order is 409 and creates no intent', async () => {
  const s = await setup('topup-paid', 100, 500);
  await prisma.order.update({ where: { id: s.orderId }, data: { status: 'CANCELLED' } });
  assert.equal((await orderTopUpRaw(s.email, s.orderId)).status, 409);
  assert.equal(await prisma.onRampIntent.count({ where: { orderId: s.orderId } }), 0);
});

test('order top-up: unapproved eligibility is 403 and creates no intent', async () => {
  for (const status of [null, 'PENDING', 'REJECTED'] as const) {
    const s = await setup(`topup-elig-${status ?? 'none'}`.toLowerCase(), 100, 500, false);
    if (status) await setEligibility(s.email, status);
    const res = await orderTopUpRaw(s.email, s.orderId);
    assert.equal(res.status, 403, `status ${status ?? 'no record'}`);
    assert.equal(await prisma.onRampIntent.count({ where: { orderId: s.orderId } }), 0);
  }
});

test('order top-up: a stale chain is 503 (not zero spendable) and creates no intent; recovers afterwards', async () => {
  const { SOLANA_CHAIN } = await import('../../apps/api/src/wallet/wallet.tokens');
  const chain = app.get(SOLANA_CHAIN, { strict: false }) as import('../../apps/api/src/wallet/chain/sandbox-solana-chain').SandboxSolanaChain;
  const s = await setup('topup-stale', 10_000, 500); // comfortably funded: a "0 spendable" misreading would wrongly create an intent
  chain.setOutage(true);
  try {
    const res = await orderTopUpRaw(s.email, s.orderId);
    assert.equal(res.status, 503);
    assert.equal(await prisma.onRampIntent.count({ where: { orderId: s.orderId } }), 0);
  } finally {
    chain.setOutage(false);
  }
  const ok = await orderTopUpRaw(s.email, s.orderId);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.topUpNeeded, false);
});

test('order top-up: a changed amount creates a new intent and expires the old open one', async () => {
  const s = await setup('topup-change', 100, 250); // shortfall 1.50 => $2
  const first = await orderTopUpRaw(s.email, s.orderId);
  assert.equal(first.status, 200);
  assert.equal(first.body.topUpUsdCents, 200);
  // The customer funds $0.50 some other way; the shortfall is now 1.00 => $1.
  const wallet = await prisma.customerWallet.findFirstOrThrow({ where: { customer: { email: s.email } } });
  const chain = app.get((await import('../../apps/api/src/wallet/wallet.tokens')).SOLANA_CHAIN, { strict: false }) as import('../../apps/api/src/wallet/chain/sandbox-solana-chain').SandboxSolanaChain;
  chain.creditUsdc(wallet.address, 500_000n);
  const second = await orderTopUpRaw(s.email, s.orderId);
  assert.equal(second.status, 200);
  assert.equal(second.body.topUpUsdCents, 100);
  assert.equal(second.body.shortfallAtomic, '1000000');
  assert.notEqual(second.body.intentId, first.body.intentId);
  const rows = await prisma.onRampIntent.findMany({ where: { orderId: s.orderId } });
  assert.equal(rows.find((r) => r.id === first.body.intentId)?.status, 'EXPIRED');
  assert.equal(rows.find((r) => r.id === second.body.intentId)?.status, 'CREATED');
  assert.equal(rows.filter((r) => r.status === 'CREATED' || r.status === 'PENDING').length, 1);
  // An expired intent can no longer be mock-completed (no credit from a superseded intent).
  await assert.rejects(client.mockCompleteOnramp(s.email, first.body.intentId), (e: any) => e.status === 409);
});

test('order top-up: parallel identical requests create exactly one intent', async () => {
  const s = await setup('topup-race', 100, 250);
  const results = await Promise.all(Array.from({ length: 8 }, () => orderTopUpRaw(s.email, s.orderId)));
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
  assert.equal(new Set(results.map((r) => r.body.intentId)).size, 1);
  assert.equal(await prisma.onRampIntent.count({ where: { orderId: s.orderId } }), 1);
});

test("order top-up: the order's own reservation is not double counted once the customer has prepared", async () => {
  const s = await setup('topup-hold', 300, 250); // $3.00 covers the $2.50 order
  await client.prepareCheckout(s.email, s.orderId);
  assert.equal((await client.fetchBalance(s.email)).spendableAtomic, 500_000n, 'balance endpoint subtracts the hold');
  const res = await orderTopUpRaw(s.email, s.orderId);
  assert.equal(res.status, 200);
  assert.equal(res.body.topUpNeeded, false);
  assert.equal(res.body.spendableAtomic, '3000000');
  assert.equal(await prisma.onRampIntent.count({ where: { orderId: s.orderId } }), 0);
});

// ---------------------------------------------------------------------------------------------
// Platform-paid Solana network fee ("fee sponsorship"): POST /v1/wallet/checkout/:orderId/prepare|submit
//
// Real Postgres + the factory-built sandbox chain + the sandbox-only in-memory fee-payer signer (the only signer that
// exists in this repository). The default app was booted with FEE_SPONSORSHIP unset, which is asserted first; the
// sponsorship tests then switch the live CHECKOUT_CONFIG object on (and restore it), exactly as an operator's env would.
// The customer's key is a throwaway Keypair created here; the signer's key lives only inside the sandbox signer.
// ---------------------------------------------------------------------------------------------

type SponsorshipPolicy = { enabled: boolean; minSponsorLamports: bigint; maxPerCustomerDay: number };

async function sponsorFixtures() {
  const { SOLANA_CHAIN } = await import('../../apps/api/src/wallet/wallet.tokens');
  const { CHECKOUT_CONFIG, FEE_PAYER_SIGNER } = await import('../../apps/api/src/wallet/checkout/ports');
  const { CheckoutService } = await import('../../apps/api/src/wallet/checkout/checkout.service');
  const { VerificationService } = await import('../../apps/api/src/wallet/checkout/verification.service');
  const chain = app.get(SOLANA_CHAIN, { strict: false }) as import('../../apps/api/src/wallet/chain/sandbox-solana-chain').SandboxSolanaChain;
  const config = app.get(CHECKOUT_CONFIG, { strict: false }) as import('../../apps/api/src/wallet/checkout/ports').CheckoutConfig;
  const signer = app.get(FEE_PAYER_SIGNER, { strict: false }) as import('../../apps/api/src/wallet/checkout/ports').FeePayerSigner;
  const service = app.get(CheckoutService, { strict: false }) as any;
  const verification = app.get(VerificationService, { strict: false }) as import('../../apps/api/src/wallet/checkout/verification.service').VerificationService;
  return { chain, config, signer, service, verification };
}

/** Runs `body` with sponsorship switched on in the live config, restoring the original policy afterwards. */
async function withSponsorship<T>(policy: Partial<SponsorshipPolicy>, body: (f: Awaited<ReturnType<typeof sponsorFixtures>>) => Promise<T>): Promise<T> {
  const f = await sponsorFixtures();
  const original = f.config.feeSponsorship;
  f.config.feeSponsorship = { enabled: true, minSponsorLamports: 50_000_000n, maxPerCustomerDay: 20, ...policy };
  f.chain.setSolBalance(f.signer.publicKey, 100_000_000_000n);
  try {
    return await body(f);
  } finally {
    f.config.feeSponsorship = original;
    f.chain.setSolBalance(f.signer.publicKey, 100_000_000_000n);
  }
}

/** The customer's wallet signing ONLY its own slot of a fee-sponsored transaction (the fee-payer slot stays empty). */
const signCustomerOnly = (unsignedBase64: string, key: Keypair) => {
  const tx = Transaction.from(Buffer.from(unsignedBase64, 'base64'));
  tx.partialSign(key);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
};
const checkoutRaw = async (email: string, orderId: string, step: 'prepare' | 'submit', body: unknown = {}) => {
  const res = await fetch(`${base}/v1/wallet/checkout/${orderId}/${step}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-customer-email': email },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};
const zeroSol = async (email: string) => {
  const { chain } = await sponsorFixtures();
  const wallet = await client.fetchWallet(email);
  assert.ok(wallet);
  chain.setSolBalance(wallet.address, 0n);
  return { chain, address: wallet.address };
};
async function addOrder(email: string, label: string, priceCents: number) {
  const sku = `SKU-${label}-${Math.random().toString(36).slice(2, 8)}`;
  const product = await prisma.product.create({ data: { sku, slug: sku.toLowerCase(), name: label, active: true, priceCents, inventory: 10 } });
  await prisma.lot.create({ data: { code: `LOT-${sku}`, productId: product.id, coaKey: 'coa/test.pdf', purity: 99 } });
  const res = await fetch(`${base}/v1/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `order-${sku}-0001` },
    body: JSON.stringify({ email, shippingAddress: '1 Lab Way, Boston, MA', researchUseAcknowledged: true, items: [{ productId: product.id, lotCode: `LOT-${sku}`, quantity: 1 }] }),
  });
  const order = (await res.json()) as { id: string };
  assert.equal(res.status, 201, JSON.stringify(order));
  return order.id;
}
const purchaseRow = (orderId: string) => prisma.cryptoTransaction.findFirstOrThrow({ where: { orderId, type: 'PURCHASE' }, orderBy: { createdAt: 'desc' } });

test('fee sponsorship: OFF by default (real startup config); a zero-SOL customer is still refused with 402 and the wire shows the customer as fee payer', async () => {
  const f = await sponsorFixtures();
  assert.equal(f.config.feeSponsorship?.enabled, false, 'FEE_SPONSORSHIP unset => off');
  assert.equal(f.config.feeSponsorship?.minSponsorLamports, 50_000_000n);
  assert.equal(f.config.feeSponsorship?.maxPerCustomerDay, 20);
  assert.ok(f.signer, 'the sandbox chain binds the sandbox-only signer');
  assert.equal(f.signer.constructor.name, 'SandboxFeePayerSigner');

  const s = await setup('fee-off', 5_000, 2_500);
  const { address } = await zeroSol(s.email);
  const refused = await checkoutRaw(s.email, s.orderId, 'prepare');
  assert.equal(refused.status, 402);
  assert.match(refused.body.message, /Insufficient SOL/);
  assert.equal(await prisma.walletAuditEvent.count({ where: { action: 'CHECKOUT_FEE_SPONSORED' } }), 0);

  f.chain.setSolBalance(address, 1_000_000_000n);
  const prepared = await checkoutRaw(s.email, s.orderId, 'prepare');
  assert.equal(prepared.status, 200);
  assert.equal(prepared.body.feeSponsored, false);
  assert.equal(prepared.body.feePayer, address);
  assert.equal(prepared.body.feeLamports, '5000');
  assert.match(prepared.body.disclosures.join(' '), /paid in SOL by your own wallet/);
  const tx = Transaction.from(Buffer.from(prepared.body.unsignedTransactionBase64, 'base64'));
  assert.equal(tx.feePayer!.toBase58(), address);
  assert.equal(tx.signatures.length, 1);
});

test('fee sponsorship ON: a customer with ZERO SOL pays end to end; USDC falls by exactly the price; the platform pays the fee; the fee payer is in no instruction', async () => {
  await withSponsorship({}, async ({ chain, signer }) => {
    const s = await setup('fee-on', 5_000, 2_500); // $50.00 funded, $25.00 order
    const { address } = await zeroSol(s.email);
    const sponsorBefore = await chain.getSolBalanceLamports(signer.publicKey);

    const prepared = await client.prepareCheckout(s.email, s.orderId);
    assert.equal(prepared.feeSponsored, true);
    assert.equal(prepared.feePayer, signer.publicKey);
    assert.notEqual(prepared.feePayer, address);
    assert.equal(prepared.feeLamports, 10_000n);
    assert.match(prepared.disclosures.join(' '), /paid by Helix & Field/);
    assert.doesNotMatch(prepared.disclosures.join(' '), /paid in SOL by your own wallet/);

    const wire = await checkoutRaw(s.email, s.orderId, 'prepare');
    assert.equal(wire.status, 200);
    assert.equal(wire.body.feePayer, signer.publicKey);
    assert.equal(wire.body.feeSponsored, true);
    assert.ok(!JSON.stringify(wire.body).includes(sponsorBefore.toString()), 'the sponsor balance is never leaked');

    const unsigned = Transaction.from(Buffer.from(prepared.unsignedTransactionBase64, 'base64'));
    const message = unsigned.compileMessage();
    assert.equal(message.accountKeys[0].toBase58(), signer.publicKey);
    assert.deepEqual(message.accountKeys.slice(0, message.header.numRequiredSignatures).map((k) => k.toBase58()), [signer.publicKey, address]);
    assert.ok(message.instructions.every((ix) => !ix.accounts.includes(0) && ix.programIdIndex !== 0), 'fee payer is in no instruction');
    assert.equal(unsigned.instructions[0].keys[3].pubkey.toBase58(), address, 'the customer is still the USDC authority');
    assert.ok(unsigned.signatures.every((sig) => sig.signature === null), 'nothing is platform-signed at prepare');

    await client.submitCheckout(s.email, s.orderId, signCustomerOnly(prepared.unsignedTransactionBase64, s.key));
    const final = await settleViaPolling(s.email, s.orderId);
    assert.equal(final.phase, 'finalized', `expected finalized, got ${final.phase} (${final.rawStatus})`);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: s.orderId } })).status, 'PAID');

    assert.equal((await client.fetchBalance(s.email)).finalizedAtomic, 25_000_000n, '50.00 funded - exactly 25.00 paid');
    assert.equal(await chain.getSolBalanceLamports(address), 0n, 'the customer never held or spent SOL');
    assert.equal(await chain.getSolBalanceLamports(signer.publicKey), sponsorBefore - 10_000n, 'the platform paid 2 x 5000 lamports');

    // The recorded transaction id is the FEE PAYER's signature, and the same id is what the status route reports.
    const row = await purchaseRow(s.orderId);
    assert.equal(row.status, 'FINALIZED');
    assert.equal(row.sourceAddress, address);
    assert.equal(row.destinationAddress, treasury);
    assert.equal(row.feeLamports, 10_000n);
    assert.equal(final.signature, row.txSignature);
    const onChain = await chain.getTransfer(row.txSignature!);
    assert.ok(onChain);
    assert.equal(onChain.sourceOwner, address, 'verification is bound to the customer wallet, not the fee payer');

    const events = await prisma.walletAuditEvent.findMany({ where: { action: 'CHECKOUT_FEE_SPONSORED', detail: { path: ['reference'], equals: row.reference } } });
    assert.equal(events.length, 1, 'one sponsorship audit event per sponsored payment');
    const submitted = await prisma.walletAuditEvent.findFirstOrThrow({ where: { action: 'checkout.submitted', detail: { path: ['reference'], equals: row.reference } } });
    assert.equal((submitted.detail as any).txSignature, row.txSignature);
    assert.equal((submitted.detail as any).feeSponsored, true);
  });
});

test('fee sponsorship ON: a customer-supplied fee-payer signature is replaced, a missing/forged customer signature is rejected, and a tampered message is rejected; nothing is broadcast', async () => {
  await withSponsorship({}, async ({ chain, signer }) => {
    const s = await setup('fee-forge', 5_000, 2_500);
    const { address } = await zeroSol(s.email);
    const prepared = await client.prepareCheckout(s.email, s.orderId);
    const sponsorBefore = await chain.getSolBalanceLamports(signer.publicKey);
    const refuse = async (signed: string, status: number, match: RegExp) => {
      const res = await checkoutRaw(s.email, s.orderId, 'submit', { signedTransactionBase64: signed });
      assert.equal(res.status, status, JSON.stringify(res.body));
      assert.match(res.body.message, match);
      assert.equal((await purchaseRow(s.orderId)).status, 'PREPARED', 'nothing was claimed');
      assert.equal((await purchaseRow(s.orderId)).txSignature, null);
      assert.equal(await chain.getSolBalanceLamports(signer.publicKey), sponsorBefore, 'no fee was taken: nothing was broadcast');
      assert.equal(await chain.getFinalizedUsdcBalance(address), 50_000_000n, 'no USDC moved');
    };
    // missing customer signature (fully unsigned, and a fee-payer slot stuffed with junk instead)
    await refuse(prepared.unsignedTransactionBase64, 400, /not signed by the customer/);
    const stuffed = Transaction.from(Buffer.from(prepared.unsignedTransactionBase64, 'base64'));
    stuffed.signatures[0].signature = Buffer.alloc(64, 1);
    await refuse(stuffed.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), 400, /not signed by the customer/);
    // forged customer signature
    const forged = Transaction.from(Buffer.from(prepared.unsignedTransactionBase64, 'base64'));
    forged.signatures[1].signature = Buffer.alloc(64, 7);
    await refuse(forged.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), 400, /signature is invalid/);
    // tampered message (different amount), correctly signed by the customer over the TAMPERED bytes
    const tampered = Transaction.from(Buffer.from(prepared.unsignedTransactionBase64, 'base64'));
    tampered.instructions[0].data[1] ^= 1;
    tampered.partialSign(s.key);
    await refuse(tampered.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), 400, /does not match the prepared payment/);

    // A junk fee-payer signature riding along with a genuine customer signature is ignored: the payment succeeds, and the
    // chain saw a valid platform signature instead of the junk.
    const genuine = Transaction.from(Buffer.from(signCustomerOnly(prepared.unsignedTransactionBase64, s.key), 'base64'));
    const junk = Buffer.alloc(64, 5);
    genuine.signatures[0].signature = junk;
    await client.submitCheckout(s.email, s.orderId, genuine.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'));
    const final = await settleViaPolling(s.email, s.orderId);
    assert.equal(final.phase, 'finalized');
    const row = await purchaseRow(s.orderId);
    const { base58Encode } = await import('../../apps/api/src/wallet/checkout/checkout.util');
    assert.notEqual(row.txSignature, base58Encode(junk), 'the junk never became the transaction id');
    assert.equal(await chain.getSolBalanceLamports(signer.publicKey), sponsorBefore - 10_000n);
    assert.equal((await client.fetchBalance(s.email)).finalizedAtomic, 25_000_000n);
  });
});

test('fee sponsorship ON: sponsor below the minimum balance => fallback (402 for a zero-SOL customer, customer-paid success for a customer with SOL)', async () => {
  await withSponsorship({}, async ({ chain, signer }) => {
    chain.setSolBalance(signer.publicKey, 49_999_999n);
    const poor = await setup('fee-lowsponsor-zero', 5_000, 2_500);
    await zeroSol(poor.email);
    const refused = await checkoutRaw(poor.email, poor.orderId, 'prepare');
    assert.equal(refused.status, 402);
    assert.match(refused.body.message, /Insufficient SOL in the customer wallet/);

    const rich = await setup('fee-lowsponsor-sol', 5_000, 2_500); // sandbox faucet gives every new owner 1 SOL
    const prepared = await client.prepareCheckout(rich.email, rich.orderId);
    assert.equal(prepared.feeSponsored, false);
    assert.equal(prepared.feeLamports, 5_000n);
    const wallet = await client.fetchWallet(rich.email);
    assert.equal(prepared.feePayer, wallet!.address);
    await client.submitCheckout(rich.email, rich.orderId, sign(prepared.unsignedTransactionBase64, rich.key));
    assert.equal((await settleViaPolling(rich.email, rich.orderId)).phase, 'finalized');
    assert.equal(await chain.getSolBalanceLamports(signer.publicKey), 49_999_999n, 'the sponsor paid nothing');
  });
});

test('fee sponsorship ON: the per-customer daily cap (real WalletAuditEvent rows, last 24h) falls back to customer-pays', async () => {
  await withSponsorship({ maxPerCustomerDay: 1 }, async () => {
    const s = await setup('fee-cap', 10_000, 2_500);
    await zeroSol(s.email);
    const first = await client.prepareCheckout(s.email, s.orderId);
    assert.equal(first.feeSponsored, true);
    const again = await client.prepareCheckout(s.email, s.orderId); // re-prepare: same payment, not counted twice
    assert.equal(again.feeSponsored, true);
    const customer = await prisma.customer.findUniqueOrThrow({ where: { email: s.email } });
    assert.equal(await prisma.walletAuditEvent.count({ where: { customerId: customer.id, action: 'CHECKOUT_FEE_SPONSORED' } }), 1);

    // A second payment by the same customer hits the cap of 1 and, with zero SOL, is refused like before.
    const second = await addOrder(s.email, 'fee-cap-2', 1_000);
    const refused = await checkoutRaw(s.email, second, 'prepare');
    assert.equal(refused.status, 402);
    assert.match(refused.body.message, /Insufficient SOL in the customer wallet/);
    assert.equal(await prisma.walletAuditEvent.count({ where: { customerId: customer.id, action: 'CHECKOUT_FEE_SPONSORED' } }), 1, 'a fallback is not counted');

    // Events older than 24 hours do not count: age the event and the second order is sponsored.
    await prisma.walletAuditEvent.updateMany({ where: { customerId: customer.id, action: 'CHECKOUT_FEE_SPONSORED' }, data: { createdAt: new Date(Date.now() - 25 * 3_600_000) } });
    const allowed = await checkoutRaw(s.email, second, 'prepare');
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    assert.equal(allowed.body.feeSponsored, true);

    // Another customer is unaffected by this customer's count.
    const other = await setup('fee-cap-other', 5_000, 2_500);
    await zeroSol(other.email);
    assert.equal((await client.prepareCheckout(other.email, other.orderId)).feeSponsored, true);
  });
});

test('fee sponsorship ON: signer unbound => fallback at prepare, and a sponsored submit is 503 with nothing broadcast; signer failure releases the claim and a retry works', async () => {
  await withSponsorship({}, async ({ chain, signer, service }) => {
    const s = await setup('fee-signer', 5_000, 2_500);
    const { address } = await zeroSol(s.email);
    const prepared = await client.prepareCheckout(s.email, s.orderId);
    assert.equal(prepared.feeSponsored, true);
    const signed = signCustomerOnly(prepared.unsignedTransactionBase64, s.key);
    const sponsorBefore = await chain.getSolBalanceLamports(signer.publicKey);

    // unbound
    const bound = service.feePayerSigner;
    service.feePayerSigner = undefined;
    try {
      const noSigner = await checkoutRaw(s.email, s.orderId, 'submit', { signedTransactionBase64: signed });
      assert.equal(noSigner.status, 503);
      assert.equal((await purchaseRow(s.orderId)).status, 'PREPARED');
      const fallback = await checkoutRaw(s.email, s.orderId, 'prepare');
      assert.equal(fallback.status, 402, 'zero-SOL customer, no signer => the old refusal');
    } finally {
      service.feePayerSigner = bound;
    }

    // signer throws
    const realSign = signer.signMessage.bind(signer);
    let calls = 0;
    (signer as any).signMessage = async (message: Uint8Array) => {
      calls++;
      throw new Error('KMS unavailable');
    };
    try {
      const prep = await checkoutRaw(s.email, s.orderId, 'prepare'); // fresh message after the fallback above
      assert.equal(prep.status, 200);
      assert.equal(prep.body.feeSponsored, true);
      const failed = await checkoutRaw(s.email, s.orderId, 'submit', { signedTransactionBase64: signCustomerOnly(prep.body.unsignedTransactionBase64, s.key) });
      assert.equal(failed.status, 503);
      assert.ok(calls >= 1);
    } finally {
      (signer as any).signMessage = realSign;
    }
    const released = await purchaseRow(s.orderId);
    assert.equal(released.status, 'PREPARED', 'claim released');
    assert.equal(released.txSignature, null);
    assert.equal(await chain.getSolBalanceLamports(signer.publicKey), sponsorBefore, 'nothing was broadcast');
    assert.equal(await chain.getFinalizedUsdcBalance(address), 50_000_000n);

    // retry works with the same customer-signed payload
    const retryPrep = await client.prepareCheckout(s.email, s.orderId);
    await client.submitCheckout(s.email, s.orderId, signCustomerOnly(retryPrep.unsignedTransactionBase64, s.key));
    assert.equal((await settleViaPolling(s.email, s.orderId)).phase, 'finalized');
    assert.equal((await client.fetchBalance(s.email)).finalizedAtomic, 25_000_000n);
  });
});

test('fee sponsorship ON: a sponsor key equal to the customer wallet or the merchant treasury is refused (customer-pays fallback), never used', async () => {
  await withSponsorship({}, async ({ chain, service }) => {
    const s = await setup('fee-samekey', 5_000, 2_500);
    const { address } = await zeroSol(s.email);
    const bound = service.feePayerSigner;
    try {
      for (const publicKey of [address, treasury]) {
        let asked = 0;
        service.feePayerSigner = { publicKey, signMessage: async () => (asked++, new Uint8Array(64)) };
        chain.setSolBalance(publicKey, publicKey === address ? 0n : 100_000_000_000n);
        const res = await checkoutRaw(s.email, s.orderId, 'prepare');
        assert.equal(res.status, 402, `${publicKey === address ? 'customer' : 'merchant'} key: ${JSON.stringify(res.body)}`);
        assert.equal(asked, 0);
        assert.equal(await prisma.walletAuditEvent.count({ where: { action: 'CHECKOUT_FEE_SPONSORED', detail: { path: ['orderId'], equals: s.orderId } } }), 0);
      }
    } finally {
      service.feePayerSigner = bound;
    }
  });
});

test('fee sponsorship: verification refuses a transfer whose authority is the fee payer or any non-customer (real DB, sandbox chain)', async () => {
  await withSponsorship({}, async ({ chain, signer, verification }) => {
    const { createHash } = await import('node:crypto');
    const { referenceKeyFor } = await import('../../apps/api/src/wallet/checkout/checkout.util');
    const { USDC_DEVNET_MINT } = await import('../../apps/api/src/wallet/contracts');
    const authorities: Array<[string, () => string]> = [
      ['the fee payer', () => signer.publicKey],
      ['a stranger', () => Keypair.generate().publicKey.toBase58()],
    ];
    for (const [label, authority] of authorities) {
      const s = await setup(`fee-verify-${label.replace(/\W/g, '')}`, 5_000, 2_500);
      const wallet = await client.fetchWallet(s.email);
      const customer = await prisma.customer.findUniqueOrThrow({ where: { email: s.email } });
      const signature = createHash('sha256').update(`forged-${label}-${s.orderId}`).digest('hex').padEnd(88, 'a');
      const reference = `chk_fee_${s.orderId}`.slice(0, 40);
      await prisma.cryptoTransaction.create({
        data: { customerId: customer.id, type: 'PURCHASE', status: 'SUBMITTED', amountAtomic: 25_000_000n, sourceAddress: wallet!.address, destinationAddress: treasury, mint: USDC_DEVNET_MINT, network: 'solana-devnet', reference, orderId: s.orderId, txSignature: signature },
      });
      chain.recordTransfer({
        signature,
        network: 'solana-devnet',
        finalized: true,
        succeeded: true,
        mint: USDC_DEVNET_MINT,
        sourceOwner: authority(),
        destinationOwner: treasury,
        amountAtomic: 25_000_000n,
        referenceKeys: [referenceKeyFor(reference).toBase58()],
      });
      const result = await verification.verifyAndSettle({ paymentReference: reference });
      assert.equal(result.outcome, 'FAILED', label);
      assert.match(result.reason ?? '', /wrong source owner/, label);
      assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: s.orderId } })).status, 'PENDING_PAYMENT', `${label}: the order is not paid`);
    }
  });
});

test('fee sponsorship does not touch withdrawals: the customer is still the fee payer and sole signer, and the sponsor pays nothing', async () => {
  await withSponsorship({}, async ({ chain, signer }) => {
    const s = await setup('fee-withdraw', 5_000, 2_500);
    const { address } = await zeroSol(s.email);
    chain.setSolBalance(address, 1_000_000_000n);
    const sponsorBefore = await chain.getSolBalanceLamports(signer.publicKey);
    const destination = Keypair.generate().publicKey.toBase58();
    const prepared = await client.prepareTransfer(s.email, { destination, amountAtomic: 1_000_000n });
    const tx = Transaction.from(Buffer.from(prepared.unsignedTransactionBase64, 'base64'));
    assert.equal(tx.feePayer!.toBase58(), address);
    assert.equal(tx.signatures.length, 1);
    assert.ok(!tx.instructions.some((ix) => ix.keys.some((k) => k.pubkey.toBase58() === signer.publicKey)));
    const sent = await client.submitTransfer(s.email, prepared.id, sign(prepared.unsignedTransactionBase64, s.key));
    assert.ok(sent.signature.length >= 64);
    assert.equal(await chain.getSolBalanceLamports(signer.publicKey), sponsorBefore, 'withdrawals stay customer-paid');
    assert.equal((await client.fetchBalance(s.email)).spendableAtomic, 49_000_000n);
  });
});

// ---------------------------------------------------------------------------------------------
// MoonPay BUY webhook: POST /v1/webhooks/moonpay (real Postgres, real Prisma JSON-path queries and row locks)
//
// The default app above is booted the way the older tests need it (no configureApp), so the webhook is exercised through a
// SECOND real WalletModule app that uses the production transport setup (configureApp: raw body for this route) against the
// SAME database. The webhook may only touch OnRampIntent + WalletAuditEvent; every test that completes an intent asserts the
// money tables (balances, crypto transactions, reservations, orders, payments, ledger) are untouched and that the balance
// derived from the chain does not move: credits and order payment come from the finalized on-chain balance, never from MoonPay.
// ---------------------------------------------------------------------------------------------

const WEBHOOK_KEY = `whk_e2e_${Math.random().toString(36).slice(2)}_0123456789`;
let hookApp: import('@nestjs/common').INestApplication | undefined;
let hookBase = '';

after(async () => {
  await hookApp?.close();
});

async function webhookBase(): Promise<string> {
  if (hookApp) return hookBase;
  const { Global, Module, ValidationPipe, Logger } = await import('@nestjs/common');
  const { Test } = await import('@nestjs/testing');
  const { PrismaService } = await import('../../apps/api/src/prisma.service');
  const { WalletModule } = await import('../../apps/api/src/wallet/wallet.module');
  const { configureApp } = await import('../../apps/api/src/config/configure-app');
  const saved = { key: process.env.MOONPAY_WEBHOOK_KEY, tolerance: process.env.MOONPAY_WEBHOOK_TOLERANCE_SECONDS };
  process.env.MOONPAY_WEBHOOK_KEY = WEBHOOK_KEY; // read by the WalletModule factory while the module compiles
  delete process.env.MOONPAY_WEBHOOK_TOLERANCE_SECONDS;
  try {
    @Global()
    @Module({ providers: [{ provide: PrismaService, useValue: prisma }], exports: [PrismaService] })
    class HookPrismaModule {}
    const { COMPLIANCE_SCREEN: SCREEN_TOKEN } = await import('../../apps/api/src/wallet/wallet.tokens');
    const { AllowAllComplianceScreen } = await import('../../apps/api/src/wallet/transfers/compliance-screen');
    @Global()
    @Module({ providers: [{ provide: SCREEN_TOKEN, useFactory: () => new AllowAllComplianceScreen() }], exports: [SCREEN_TOKEN] })
    class HookScreenModule {}
    const moduleRef = await Test.createTestingModule({ imports: [HookPrismaModule, HookScreenModule, WalletModule] }).compile();
    const created = moduleRef.createNestApplication<import('@nestjs/platform-express').NestExpressApplication>({ logger: false });
    created.setGlobalPrefix('v1');
    created.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    configureApp(created, process.env);
    Logger.overrideLogger(false);
    await created.listen(0, '127.0.0.1');
    hookApp = created;
    hookBase = (await created.getUrl()).replace('[::1]', '127.0.0.1');
  } finally {
    if (saved.key === undefined) delete process.env.MOONPAY_WEBHOOK_KEY;
    else process.env.MOONPAY_WEBHOOK_KEY = saved.key;
    if (saved.tolerance !== undefined) process.env.MOONPAY_WEBHOOK_TOLERANCE_SECONDS = saved.tolerance;
  }
  return hookBase;
}

/** MoonPay's documented algorithm, written out here independently of the production verifier. */
function hookHeader(rawBody: string, key = WEBHOOK_KEY, t = Math.floor(Date.now() / 1000)) {
  const { createHmac } = require('node:crypto') as typeof import('node:crypto');
  return `t=${t},s=${createHmac('sha256', key).update(`${t}.${rawBody}`).digest('hex')}`;
}

interface HookIntent { email: string; intentId: string; customerId: string; address: string }
/** A linked wallet plus an on-ramp intent created through the real API, re-labelled as a real-MoonPay intent (sandbox quotes are 'moonpay-sandbox'). */
async function hookIntent(label: string, overrides: Record<string, unknown> = {}): Promise<HookIntent> {
  const email = `${label}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const key = Keypair.generate();
  await client.registerWallet(email, key.publicKey.toBase58(), 'sandbox', walletSigner(key));
  const quote = await client.createOnrampQuote(email, 5_000);
  const customer = await prisma.customer.findUniqueOrThrow({ where: { email } });
  await prisma.onRampIntent.update({ where: { id: quote.intentId }, data: { provider: 'moonpay', ...overrides } });
  return { email, intentId: quote.intentId, customerId: customer.id, address: key.publicKey.toBase58() };
}

const minute = (n: number) => `2026-10-21T11:${String(n).padStart(2, '0')}:00.000Z`;
function hookEvent(i: HookIntent, o: { type?: string; status?: string; at?: string; id?: string; data?: Record<string, unknown> } = {}) {
  return {
    type: o.type ?? 'transaction_updated',
    data: {
      id: o.id ?? `mp-${i.intentId}`,
      updatedAt: o.at ?? minute(1),
      status: o.status ?? 'pending',
      failureReason: null,
      walletAddress: i.address,
      cryptoTransactionId: null,
      currency: { code: 'usdc_sol' },
      externalTransactionId: i.intentId,
      externalCustomerId: i.customerId,
      ...o.data,
    },
    externalCustomerId: i.customerId,
  };
}
async function deliver(event: unknown, over: { header?: string | null; key?: string; spaced?: boolean } = {}) {
  const body = over.spaced ? JSON.stringify(event, null, 2) : JSON.stringify(event);
  const header = over.header === undefined ? hookHeader(body, over.key) : over.header;
  const res = await fetch(`${await webhookBase()}/v1/webhooks/moonpay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(header ? { 'moonpay-signature-v2': header } : {}) },
    body,
  });
  return res.status;
}
const intentRow = (id: string) => prisma.onRampIntent.findUniqueOrThrow({ where: { id } });
const hookAudits = (customerId: string, action?: string) => prisma.walletAuditEvent.findMany({ where: { customerId, ...(action ? { action } : {}) }, orderBy: { createdAt: 'asc' } });

/** Everything that holds or moves value. The webhook must leave every one of these exactly as it found them. */
async function moneyState() {
  return JSON.stringify({
    cryptoTransactions: await prisma.cryptoTransaction.findMany({ orderBy: { id: 'asc' } }),
    balanceSnapshots: await prisma.balanceSnapshot.findMany({ orderBy: { id: 'asc' } }),
    reservations: await prisma.creditReservation.findMany({ orderBy: { id: 'asc' } }),
    orders: await prisma.order.findMany({ orderBy: { id: 'asc' } }),
    payments: await prisma.payment.findMany({ orderBy: { id: 'asc' } }),
    ledger: await prisma.ledgerEntry.findMany({ orderBy: { id: 'asc' } }),
  }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

test('moonpay webhook (real DB): created -> pending -> completed advances the intent, saves externalReference, audits each step, and never touches money tables', async () => {
  const i = await hookIntent('hook-flow');
  const before = await moneyState();
  const txId = `mp-${i.intentId}`;

  assert.equal(await deliver(hookEvent(i, { type: 'transaction_created', status: 'waitingPayment', at: minute(1) })), 200);
  let row = await intentRow(i.intentId);
  assert.equal(row.status, 'PENDING');
  assert.equal(row.externalReference, txId);
  assert.equal(await deliver(hookEvent(i, { status: 'pending', at: minute(2) }, ), { spaced: true }), 200, 'pretty-printed raw bytes verify too');
  assert.equal(await deliver(hookEvent(i, { status: 'completed', at: minute(3), data: { cryptoTransactionId: '5Zfake' } })), 200);
  row = await intentRow(i.intentId);
  assert.equal(row.status, 'COMPLETED');

  // duplicate deliveries and a late older event: 200, no change, no new audit rows
  const auditsBefore = (await hookAudits(i.customerId)).filter((a) => a.action.startsWith('MOONPAY_WEBHOOK_')).length;
  assert.equal(await deliver(hookEvent(i, { status: 'completed', at: minute(3), data: { cryptoTransactionId: '5Zfake' } })), 200);
  assert.equal(await deliver(hookEvent(i, { status: 'pending', at: minute(2) })), 200);
  row = await intentRow(i.intentId);
  assert.equal(row.status, 'COMPLETED');
  const audits = (await hookAudits(i.customerId)).filter((a) => a.action.startsWith('MOONPAY_WEBHOOK_')); // (the wallet-link audit row is not ours)
  const processed = audits.filter((a) => a.action === 'MOONPAY_WEBHOOK_PROCESSED');
  assert.equal(processed.length, 3);
  assert.deepEqual(processed.map((a) => (a.detail as any).moonpayUpdatedAt), [minute(1), minute(2), minute(3)].map((m) => m));
  assert.equal(audits.length, auditsBefore + 1, 'only the older event added a (stale) audit row; the exact duplicate added none');
  assert.equal(audits.filter((a) => a.action === 'MOONPAY_WEBHOOK_STALE').length, 1);
  for (const a of audits) {
    const text = JSON.stringify(a.detail);
    assert.ok(!text.includes(i.email) && !text.includes(i.address) && !/signature|whk_e2e/i.test(text), `no PII, wallet address, signature or key in audit detail: ${text}`);
  }

  assert.equal(await moneyState(), before, 'balances, crypto transactions, reservations, orders, payments and ledger are untouched');
});

test('moonpay webhook (real DB): a completed event for a NEVER-FUNDED wallet changes no balance and pays no order', async () => {
  const i = await hookIntent('hook-nofund');
  await setEligibility(i.email, 'APPROVED'); // so the 402 below is about the balance, not the eligibility gate
  const orderId = await addOrder(i.email, 'hook-nofund', 2_500);
  const balanceBefore = await client.fetchBalance(i.email);
  assert.equal(balanceBefore.spendableAtomic, 0n);
  const before = await moneyState();
  const counts = async () => [await prisma.cryptoTransaction.count(), await prisma.creditReservation.count(), await prisma.balanceSnapshot.count(), await prisma.order.count()];
  const countsBefore = await counts();

  assert.equal(await deliver(hookEvent(i, { type: 'transaction_updated', status: 'completed', at: minute(9), data: { cryptoTransactionId: '4xNotRealOnChain' } })), 200);
  assert.equal((await intentRow(i.intentId)).status, 'COMPLETED', 'the intent bookkeeping follows MoonPay...');

  const balanceAfter = await client.fetchBalance(i.email);
  assert.equal(balanceAfter.spendableAtomic, 0n, '...but the balance is derived from the chain, which received nothing');
  assert.equal(balanceAfter.stale, balanceBefore.stale);
  assert.deepEqual(await counts(), countsBefore, 'no CryptoTransaction, reservation, snapshot or order row was created');
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status, 'PENDING_PAYMENT', 'the order is NOT marked paid');
  assert.equal(await moneyState(), before);
  await assert.rejects(client.prepareCheckout(i.email, orderId), (e: any) => e.status === 402, 'checkout still refuses: there is no balance to spend');
});

test('moonpay webhook (real DB): invalid signature variants are 401 and leave every table untouched; the same body signed correctly is accepted', async () => {
  const i = await hookIntent('hook-auth');
  const event = hookEvent(i, { status: 'completed', at: minute(4) });
  const body = JSON.stringify(event);
  const good = hookHeader(body);
  const before = JSON.stringify([await intentRow(i.intentId), await prisma.walletAuditEvent.count()]);
  const old = Math.floor(Date.now() / 1000) - 3_600;
  const cases: [string, Parameters<typeof deliver>[1]][] = [
    ['missing header', { header: null }],
    ['malformed header', { header: 'nonsense' }],
    ['short mac', { header: good.slice(0, good.length - 4) }],
    ['wrong key', { key: 'not-the-key' }],
    ['stale timestamp', { header: hookHeader(body, WEBHOOK_KEY, old) }],
    ['body signed, then tampered', { header: hookHeader(JSON.stringify(hookEvent(i, { status: 'waitingPayment', at: minute(4) }))) }],
  ];
  for (const [label, over] of cases) assert.equal(await deliver(event, over), 401, label);
  assert.equal(JSON.stringify([await intentRow(i.intentId), await prisma.walletAuditEvent.count()]), before);
  assert.equal(await deliver(event), 200);
  assert.equal((await intentRow(i.intentId)).status, 'COMPLETED');
});

test('moonpay webhook (real DB): unknown intent => 200 + MOONPAY_WEBHOOK_UNKNOWN_INTENT audit (deduplicated); other event types => 200 no-op; invalid payload => 400', async () => {
  const i = await hookIntent('hook-unknown');
  const unknown = hookEvent(i, { data: { externalTransactionId: 'no-such-intent' }, id: 'mp-unknown-1' });
  assert.equal(await deliver(unknown), 200);
  assert.equal(await deliver(unknown), 200);
  const audits = await hookAudits(i.customerId, 'MOONPAY_WEBHOOK_UNKNOWN_INTENT');
  assert.equal(audits.length, 1);
  // a customer id that does not exist at all is still auditable (WalletAuditEvent.customerId has no foreign key)
  assert.equal(await deliver({ ...unknown, data: { ...unknown.data, id: 'mp-unknown-2', externalCustomerId: undefined }, externalCustomerId: undefined }), 200);
  assert.equal((await prisma.walletAuditEvent.findMany({ where: { customerId: 'unknown', action: 'MOONPAY_WEBHOOK_UNKNOWN_INTENT' } })).length >= 1, true);

  const before = JSON.stringify(await intentRow(i.intentId));
  for (const type of ['sell_transaction_updated', 'identity_check_updated', 'swap_transaction_created']) assert.equal(await deliver({ ...hookEvent(i, { status: 'completed' }), type }), 200, type);
  assert.equal(JSON.stringify(await intentRow(i.intentId)), before);
  assert.equal(await deliver({ type: 'transaction_updated', data: { id: 'x' } }), 400);
  assert.equal(await deliver('not an envelope'), 400);
  const rawBody = '{not json';
  const res = await fetch(`${await webhookBase()}/v1/webhooks/moonpay`, { method: 'POST', headers: { 'content-type': 'application/json', 'moonpay-signature-v2': hookHeader(rawBody) }, body: rawBody });
  assert.equal(res.status, 400, 'authentic but not JSON');
});

test('moonpay webhook (real DB): wallet / currency / customer / provider mismatches change nothing and are flagged manualReview', async () => {
  const i = await hookIntent('hook-mismatch');
  const before = JSON.stringify(await intentRow(i.intentId));
  const stranger = Keypair.generate().publicKey.toBase58();
  const cases: [string, Record<string, unknown>][] = [
    ['wallet-mismatch', { walletAddress: stranger }],
    ['currency-mismatch', { currency: { code: 'usdc' } }],
    ['customer-mismatch', { externalCustomerId: 'another-customer' }],
  ];
  for (const [reason, data] of cases) {
    assert.equal(await deliver(hookEvent(i, { status: 'completed', at: minute(5), data })), 200, reason);
    assert.equal(JSON.stringify(await intentRow(i.intentId)), before, reason);
  }
  const audits = await hookAudits(i.customerId, 'MOONPAY_WEBHOOK_MISMATCH');
  assert.deepEqual(audits.map((a) => (a.detail as any).reason).sort(), ['currency-mismatch', 'customer-mismatch', 'wallet-mismatch']);
  assert.ok(audits.every((a) => (a.detail as any).manualReview === true));
  assert.equal((await hookAudits(i.customerId, 'MOONPAY_WEBHOOK_PROCESSED')).length, 0);

  // a sandbox-simulation intent can never be completed by a (real) MoonPay event
  const sandboxIntent = await hookIntent('hook-sandbox-provider', { provider: 'moonpay-sandbox' });
  assert.equal(await deliver(hookEvent(sandboxIntent, { status: 'completed' })), 200);
  assert.equal((await intentRow(sandboxIntent.intentId)).status, 'CREATED');
  assert.equal(((await hookAudits(sandboxIntent.customerId, 'MOONPAY_WEBHOOK_MISMATCH'))[0].detail as any).reason, 'provider-not-moonpay');
});

test('moonpay webhook (real DB): an EXPIRED intent + completed event => COMPLETED with an audit note; expired + pending stays EXPIRED', async () => {
  const done = await hookIntent('hook-expired-done', { status: 'EXPIRED' });
  assert.equal(await deliver(hookEvent(done, { status: 'completed', at: minute(6) })), 200);
  assert.equal((await intentRow(done.intentId)).status, 'COMPLETED');
  assert.equal(((await hookAudits(done.customerId, 'MOONPAY_WEBHOOK_PROCESSED'))[0].detail as any).note, 'completed-after-expiry');

  const kept = await hookIntent('hook-expired-pending', { status: 'EXPIRED' });
  assert.equal(await deliver(hookEvent(kept, { status: 'pending', at: minute(6) })), 200);
  const row = await intentRow(kept.intentId);
  assert.equal(row.status, 'EXPIRED');
  assert.equal(row.externalReference, `mp-${kept.intentId}`);
});

test('moonpay webhook (real DB): externalReference is unique in Postgres; a MoonPay transaction id claimed by another intent is a mismatch (sequential and racing)', async () => {
  const a = await hookIntent('hook-ref-a');
  const b = await hookIntent('hook-ref-b');
  const shared = `mp-shared-${a.intentId}`;
  assert.equal(await deliver(hookEvent(a, { id: shared, status: 'pending', at: minute(1) })), 200);
  assert.equal((await intentRow(a.intentId)).externalReference, shared);
  assert.equal(await deliver(hookEvent(b, { id: shared, status: 'completed', at: minute(2) })), 200);
  const bRow = await intentRow(b.intentId);
  assert.equal(bRow.externalReference, null);
  assert.equal(bRow.status, 'CREATED');
  assert.equal(((await hookAudits(b.customerId, 'MOONPAY_WEBHOOK_MISMATCH'))[0].detail as any).reason, 'transaction-id-claimed-by-other-intent');
  // a different transaction id for an intent that already has one: kept, manual review
  assert.equal(await deliver(hookEvent(a, { id: 'mp-other-tx', status: 'completed', at: minute(3) })), 200);
  assert.equal((await intentRow(a.intentId)).status, 'PENDING');
  assert.equal(((await hookAudits(a.customerId, 'MOONPAY_WEBHOOK_MISMATCH'))[0].detail as any).reason, 'transaction-id-differs');

  // racing: two fresh intents receive the same MoonPay transaction id at the same instant; exactly one wins, both answer 200
  const c = await hookIntent('hook-ref-c');
  const d = await hookIntent('hook-ref-d');
  const racing = `mp-race-${c.intentId}`;
  const statuses = await Promise.all([deliver(hookEvent(c, { id: racing, status: 'pending' })), deliver(hookEvent(d, { id: racing, status: 'pending' }))]);
  assert.deepEqual(statuses, [200, 200]);
  const holders = (await prisma.onRampIntent.findMany({ where: { externalReference: racing } })).map((r) => r.id);
  assert.equal(holders.length, 1, 'the unique index admitted exactly one holder');
  const loser = holders[0] === c.intentId ? d : c;
  assert.equal((await intentRow(loser.intentId)).status, 'CREATED');
  assert.equal((await hookAudits(loser.customerId, 'MOONPAY_WEBHOOK_MISMATCH')).length, 1);
});

test('moonpay webhook (real DB): concurrent, duplicated and shuffled deliveries converge on the newest updatedAt with one audit row per distinct revision', async () => {
  for (let round = 0; round < 6; round++) {
    const i = await hookIntent(`hook-race-${round}`);
    const revisions = [
      hookEvent(i, { type: 'transaction_created', status: 'waitingPayment', at: minute(1) }),
      hookEvent(i, { status: 'pending', at: minute(2) }),
      hookEvent(i, { status: 'waitingAuthorization', at: minute(3) }),
      hookEvent(i, { status: 'completed', at: minute(4) }),
    ];
    const deliveries = revisions.flatMap((r) => [r, r, r]).sort(() => Math.random() - 0.5);
    const statuses = await Promise.all(deliveries.map((e) => deliver(e)));
    assert.ok(statuses.every((s) => s === 200), `round ${round}: ${statuses.join(',')}`);
    const row = await intentRow(i.intentId);
    assert.equal(row.status, 'COMPLETED', `round ${round}`);
    assert.equal(row.externalReference, `mp-${i.intentId}`);
    const stamps = (await hookAudits(i.customerId, 'MOONPAY_WEBHOOK_PROCESSED')).map((a) => (a.detail as any).moonpayUpdatedAt as string);
    assert.equal(new Set(stamps).size, stamps.length, `round ${round}: no revision was processed twice`);
    assert.ok(stamps.includes(minute(4)) && stamps.length >= 1 && stamps.length <= 4);
    assert.equal(stamps.slice().sort().at(-1), minute(4));
    // Applied order is increasing updatedAt (older ones are skipped as stale), so the before/after statuses must chain exactly.
    const chain = (await hookAudits(i.customerId, 'MOONPAY_WEBHOOK_PROCESSED')).map((a) => a.detail as any).sort((x, y) => x.moonpayUpdatedAt.localeCompare(y.moonpayUpdatedAt));
    chain.forEach((d, n) => assert.equal(d.statusBefore, n === 0 ? 'CREATED' : chain[n - 1].statusAfter, `round ${round}: status chain breaks at revision ${d.moonpayUpdatedAt}`));
    assert.equal(chain.at(-1).statusAfter, 'COMPLETED');
    // Row createdAt is deliberately NOT asserted to be monotonic: a delivery whose transaction started earlier can wait for the
    // row lock and commit later with an earlier createdAt. That is exactly why the service takes the maximum moonpayUpdatedAt
    // over an intent's PROCESSED rows instead of trusting the newest row.
  }
});

// ---------------------------------------------------------------------------------------------
// Durable prepared-message store: a prepared checkout survives an API restart.
//
// The default store is Postgres (DATABASE_URL is set), so "restart" = build a SECOND Nest app over the same database. It is a
// separate module graph with separate service and store instances, so nothing in process memory is shared with the first app.
// The sandbox chain is the only thing carried over (a real cluster outlives an API restart; the in-memory sandbox does not).
// ---------------------------------------------------------------------------------------------

/** A second, independent Nest app over the same database; `storeMode` is applied while its modules compile (they read env then). */
async function restartedApp(storeMode?: 'memory') {
  const { Global, Module, ValidationPipe } = await import('@nestjs/common');
  const { Test } = await import('@nestjs/testing');
  const { PrismaService } = await import('../../apps/api/src/prisma.service');
  const { WalletModule } = await import('../../apps/api/src/wallet/wallet.module');
  const { CheckoutModule } = await import('../../apps/api/src/wallet/checkout/checkout.module');
  const { checkoutPortProviders } = await import('../../apps/api/src/wallet/wallet.wiring');
  const { OrdersModule } = await import('../../apps/api/src/orders/orders.module');
  const { SOLANA_CHAIN, COMPLIANCE_SCREEN } = await import('../../apps/api/src/wallet/wallet.tokens');
  const chain = app.get(SOLANA_CHAIN, { strict: false });
  // Same screen instance the first app resolved (whichever module provides it), so this helper never depends on how that is wired.
  const screen = app.get(COMPLIANCE_SCREEN, { strict: false });
  const saved = process.env.WALLET_PREPARED_STORE;
  if (storeMode) process.env.WALLET_PREPARED_STORE = storeMode;
  else delete process.env.WALLET_PREPARED_STORE;
  try {
    // Its own client and pool, like a freshly started process; closing this app disconnects only this client.
    const ownPrisma = new PrismaService();
    @Global()
    @Module({ providers: [{ provide: PrismaService, useValue: ownPrisma }], exports: [PrismaService] })
    class RestartPrismaModule {}
    @Global()
    @Module({ providers: [{ provide: COMPLIANCE_SCREEN, useValue: screen }], exports: [COMPLIANCE_SCREEN] })
    class RestartScreenModule {}
    const moduleRef = await Test.createTestingModule({
      imports: [RestartPrismaModule, RestartScreenModule, WalletModule, OrdersModule, CheckoutModule.register({ imports: [WalletModule], providers: checkoutPortProviders })],
    })
      .overrideProvider(SOLANA_CHAIN).useValue(chain)
      .compile();
    const created = moduleRef.createNestApplication({ logger: false });
    created.setGlobalPrefix('v1');
    created.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await created.listen(0, '127.0.0.1');
    return { app: created, base: (await created.getUrl()).replace('[::1]', '127.0.0.1') };
  } finally {
    if (saved === undefined) delete process.env.WALLET_PREPARED_STORE;
    else process.env.WALLET_PREPARED_STORE = saved;
  }
}

async function checkoutCall(apiBase: string, email: string, orderId: string, action: 'prepare' | 'submit' | 'status', body?: unknown) {
  const res = await fetch(`${apiBase}/v1/wallet/checkout/${orderId}/${action}`, {
    method: action === 'status' ? 'GET' : 'POST',
    headers: { 'x-customer-email': email, ...(action === 'status' ? {} : { 'content-type': 'application/json' }) },
    body: action === 'status' ? undefined : JSON.stringify(body ?? {}),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, json };
}

test('prepared-message store (real DB): prepare, restart the API (new Nest app, same database), submit the signed payload and settle', async () => {
  const s = await setup('restart', 10_000, 2_500);
  const prepared = await client.prepareCheckout(s.email, s.orderId);
  const signed = sign(prepared.unsignedTransactionBase64, s.key);

  // The prepared message is a durable row (namespaced key, kind msg), with the payload as JSON the codec can read back.
  const stored = await prisma.preparedMessage.findUniqueOrThrow({ where: { key: `msg:${prepared.paymentReference}` } });
  assert.equal(stored.kind, 'msg');
  assert.ok(stored.expiresAt.getTime() > Date.now());
  assert.equal((stored.payload as Record<string, unknown>).amountAtomic, prepared.amountAtomic.toString());

  const restarted = await restartedApp();
  try {
    // Nothing prepared in this process: only the database can answer.
    const submit = await checkoutCall(restarted.base, s.email, s.orderId, 'submit', { signedTransactionBase64: signed });
    assert.ok([200, 201].includes(submit.status), `submit after restart failed: ${JSON.stringify(submit.json)}`);
    assert.ok(submit.json.txSignature, 'the restarted API broadcast the customer-signed payload');

    let final = '';
    for (let i = 0; i < 40 && final !== 'PAID'; i++) {
      await checkoutCall(restarted.base, s.email, s.orderId, 'status');
      final = (await prisma.order.findUniqueOrThrow({ where: { id: s.orderId } })).status;
      if (final !== 'PAID') await sleep(40);
    }
    assert.equal(final, 'PAID', 'the order settled through the restarted API');
    const purchase = await prisma.cryptoTransaction.findFirstOrThrow({ where: { orderId: s.orderId, type: 'PURCHASE' } });
    assert.equal(purchase.status, 'FINALIZED');
    assert.equal(purchase.txSignature, submit.json.txSignature);
  } finally {
    await restarted.app.close();
  }
});

test('prepared-message store (real DB): two live API instances share one store; the in-memory store (explicit, test only) would not survive the same restart', async () => {
  // Second instance prepares, the FIRST (original) app submits: they are different processes' worth of state.
  const other = await restartedApp();
  try {
    const s = await setup('shared', 10_000, 1_500);
    const prepared = await checkoutCall(other.base, s.email, s.orderId, 'prepare');
    assert.ok([200, 201].includes(prepared.status), JSON.stringify(prepared.json));
    const signed = sign(prepared.json.unsignedTransactionBase64, s.key);
    const submitted = await checkoutCall(base, s.email, s.orderId, 'submit', { signedTransactionBase64: signed });
    assert.ok(submitted.json.txSignature, `instance A could not submit what instance B prepared: ${JSON.stringify(submitted.json)}`);
  } finally {
    await other.app.close();
  }

  // Control: with the in-memory store a restart loses the prepared message, and submit fails closed with 409.
  const memoryA = await restartedApp('memory');
  const memoryB = await restartedApp('memory');
  try {
    const s = await setup('amnesia', 10_000, 1_500);
    const prepared = await checkoutCall(memoryA.base, s.email, s.orderId, 'prepare');
    const signed = sign(prepared.json.unsignedTransactionBase64, s.key);
    const submitted = await checkoutCall(memoryB.base, s.email, s.orderId, 'submit', { signedTransactionBase64: signed });
    assert.equal(submitted.status, 409, JSON.stringify(submitted.json));
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: s.orderId } })).status, 'PENDING_PAYMENT');
  } finally {
    await memoryA.app.close();
    await memoryB.app.close();
  }
});
