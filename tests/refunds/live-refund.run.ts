/**
 * MANUAL LIVE DEVNET PROOF of owner refunds (not part of tests/run-all.mjs: the file name does not end in .test.ts).
 *
 * Boots a throwaway Nest app on a random port with a REAL DevnetSolanaChain against the public devnet RPC, a throwaway dev treasury as the merchant,
 * the dev-only treasury signer bound as MERCHANT_SIGNER (tools/dev/dev-treasury-signer.ts, exactly like the dev launcher), and platform-paid fees from
 * the sponsor key. Then: a customer wallet is linked through the real proof-of-control flow, pays a $1.25 order, the OWNER refunds it through the admin
 * API (request -> submit -> verify) and every result is re-checked directly on chain.
 *
 *   DEVNET_KEYPAIR_FILE=/path/customer-keypair.json \               # throwaway devnet customer wallet holding devnet USDC (needs no SOL)
 *   DEVNET_SPONSOR_KEYPAIR_FILE=/path/sponsor-keypair.json \        # throwaway devnet key holding devnet SOL (pays fees and rent)
 *   DEV_TREASURY_KEYPAIR_FILE=/path/dev-treasury-keypair.json \     # created here if missing; throwaway, never reused for anything real
 *   TEST_DATABASE_URL=postgresql://helix@127.0.0.1:54329/helix_field?schema=<your own schema> \
 *   pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only ../../tests/refunds/live-refund.run.ts
 *
 * Preflight (plain web3, idempotent): creates the treasury key file if absent, sends it 0.02 SOL from the sponsor, creates its USDC token account
 * (paid by the sponsor, because the customer wallet holds no SOL) and sends it 3 USDC from the customer wallet. Refuses non-devnet RPC URLs, public/dev
 * schemas and non-local databases. Keys are read from files, never printed or logged; only public keys and transaction signatures are shown.
 */
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const apiRequire = createRequire(path.join(__dirname, '../../apps/api/package.json'));
const web3 = apiRequire('@solana/web3.js') as typeof import('@solana/web3.js');
const spl = apiRequire('@solana/spl-token') as typeof import('@solana/spl-token');
const { Connection, Keypair, PublicKey, SystemProgram, Transaction } = web3;

const customerFile = process.env.DEVNET_KEYPAIR_FILE;
const sponsorFile = process.env.DEVNET_SPONSOR_KEYPAIR_FILE;
const treasuryFile = process.env.DEV_TREASURY_KEYPAIR_FILE;
const dbUrl = process.env.TEST_DATABASE_URL;
const rpcUrl = process.env.SOLANA_RPC_URL?.trim() || 'https://api.devnet.solana.com';
if (!customerFile || !sponsorFile || !treasuryFile || !dbUrl) throw new Error('DEVNET_KEYPAIR_FILE, DEVNET_SPONSOR_KEYPAIR_FILE, DEV_TREASURY_KEYPAIR_FILE and TEST_DATABASE_URL are required.');
if (!/devnet/i.test(rpcUrl)) throw new Error(`Refusing to run: ${rpcUrl} does not look like a devnet RPC URL.`);
const db = new URL(dbUrl);
if (!['127.0.0.1', 'localhost'].includes(db.hostname)) throw new Error('Refusing to run: database is not local.');
if (['public', 'dev'].includes(db.searchParams.get('schema') ?? 'public')) throw new Error('Refusing to run against the public/dev schema: use your own scratch schema.');

const readKey = (file: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8')) as number[]));
const customer = readKey(customerFile);
const sponsor = readKey(sponsorFile);
if (!fs.existsSync(treasuryFile)) {
  fs.writeFileSync(treasuryFile, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
  console.log('created a new throwaway dev treasury key file (public key shown below)');
}
const treasury = readKey(treasuryFile);
if (new Set([customer.publicKey.toBase58(), sponsor.publicKey.toBase58(), treasury.publicKey.toBase58()]).size !== 3) throw new Error('customer, sponsor and treasury must be three different keys.');

process.env.DATABASE_URL = dbUrl;
process.env.NODE_ENV = 'test'; // header identity for the storefront client; never production-like
process.env.WALLET_CHAIN_MODE = 'devnet';
process.env.SOLANA_NETWORK = 'solana-devnet';
process.env.SOLANA_RPC_URL = rpcUrl;
process.env.SOLANA_USDC_TREASURY = treasury.publicKey.toBase58(); // the throwaway treasury is the merchant for this run only (.env is not touched)
process.env.FEE_SPONSORSHIP = 'true';
process.env.WALLET_RECONCILE_INTERVAL_MS = '0';

const MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const connection = new Connection(rpcUrl, 'finalized');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...parts: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...parts);
const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

const results: { step: string; ok: boolean; detail: string }[] = [];
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    const value = await fn();
    results.push({ step: name, ok: true, detail: '' });
    log('PASS', name);
    return value;
  } catch (error) {
    results.push({ step: name, ok: false, detail: (error as Error).message });
    log('FAIL', name, '->', (error as Error).message);
    throw error;
  }
}
/** Retries through transient public-RPC failures (429 / 503 / timeouts) for up to `ms`; `fn` returns null to keep waiting. */
async function until<T>(what: string, ms: number, fn: () => Promise<T | null>, pause = 3_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value !== null) return value;
    } catch (error) {
      last = (error as Error).message;
    }
    await sleep(pause);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${last})` : ''}`);
}
/** One RPC call with retries on rate limiting. */
const rpc = <T>(what: string, fn: () => Promise<T>) => until(what, 90_000, async () => fn(), 4_000);

async function usdcOf(owner: web3.PublicKey): Promise<bigint> {
  return rpc(`USDC balance of ${owner.toBase58().slice(0, 6)}`, async () => {
    try {
      return (await spl.getAccount(connection, spl.getAssociatedTokenAddressSync(MINT, owner, true), 'finalized')).amount;
    } catch (error) {
      if (/could not find account|TokenAccountNotFound/i.test(String((error as Error).name + (error as Error).message))) return 0n;
      throw error;
    }
  });
}
const solOf = (owner: web3.PublicKey) => rpc('SOL balance', () => connection.getBalance(owner, 'finalized'));

/** Sends a transaction whose fee payer is the sponsor, signed by the given keys, and waits for finalization. */
async function sendAsSponsor(instructions: web3.TransactionInstruction[], extraSigners: web3.Keypair[] = []): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await rpc('blockhash', () => connection.getLatestBlockhash('finalized'));
  const tx = new Transaction({ feePayer: sponsor.publicKey, blockhash, lastValidBlockHeight }).add(...instructions);
  tx.sign(sponsor, ...extraSigners);
  const signature = await rpc('send', () => connection.sendRawTransaction(tx.serialize()));
  await rpc('confirm', async () => {
    const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'finalized');
    if (result.value.err) throw new Error(`transaction failed: ${JSON.stringify(result.value.err)}`);
    return true;
  });
  return signature;
}

function customerSign(unsignedBase64: string): string {
  const tx = Transaction.from(Buffer.from(unsignedBase64, 'base64'));
  tx.partialSign(customer); // only the customer's own slot; the platform fills the fee-payer slot at submit
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}
function ed25519Signer(key: web3.Keypair) {
  const { createPrivateKey, sign: edSign } = require('node:crypto') as typeof import('node:crypto');
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(key.secretKey.slice(0, 32))]);
  return (message: Uint8Array) => new Uint8Array(edSign(null, Buffer.from(message), createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })));
}

async function main() {
  const { Global, Module, ValidationPipe } = await import('@nestjs/common');
  const { Test } = await import('@nestjs/testing');
  const { PrismaService } = await import('../../apps/api/src/prisma.service');
  const { WalletModule } = await import('../../apps/api/src/wallet/wallet.module');
  const { CheckoutModule } = await import('../../apps/api/src/wallet/checkout/checkout.module');
  const { checkoutPortProviders } = await import('../../apps/api/src/wallet/wallet.wiring');
  const { FEE_PAYER_SIGNER, CHAIN_PORT } = await import('../../apps/api/src/wallet/checkout/ports');
  const { SOLANA_CHAIN } = await import('../../apps/api/src/wallet/wallet.tokens');
  const { OrdersModule } = await import('../../apps/api/src/orders/orders.module');
  const { RefundsModule } = await import('../../apps/api/src/wallet/refunds/refunds.module');
  const { MERCHANT_SIGNER } = await import('../../apps/api/src/wallet/refunds/merchant-signer.port');
  const { AdminCoreModule } = await import('../../apps/api/src/admin/admin-core.module');
  const { hashSessionToken } = await import('../../apps/api/src/admin/admin-session.guard');
  const { AdminOrdersModule } = await import('../../apps/api/src/admin/orders/admin-orders.module');
  const { AdminOrderRefundModule } = await import('../../apps/api/src/admin/orders/admin-order-refund.module');
  const { createDevTreasurySigner } = await import('../../tools/dev/dev-treasury-signer');
  const { AllowAllComplianceScreen } = await import('../../apps/api/src/wallet/transfers/compliance-screen');
  const { COMPLIANCE_SCREEN } = await import('../../apps/api/src/wallet/wallet.tokens');

  const treasuryAta = spl.getAssociatedTokenAddressSync(MINT, treasury.publicKey, true);
  const customerAta = spl.getAssociatedTokenAddressSync(MINT, customer.publicKey, false);
  const price = 125;
  const priceAtomic = 1_250_000n;
  const fund = 3_000_000n;
  log('customer wallet', customer.publicKey.toBase58());
  log('sponsor (pays fees and rent)', sponsor.publicKey.toBase58());
  log('dev treasury (merchant)', treasury.publicKey.toBase58(), 'USDC account', treasuryAta.toBase58());

  // ------------------------------------------------------------------ preflight: fund the throwaway treasury
  await step('preflight: the sponsor holds devnet SOL; the customer wallet holds enough devnet USDC and no SOL is needed from it', async () => {
    assert.ok((await solOf(sponsor.publicKey)) >= 40_000_000, 'the sponsor needs >= 0.04 devnet SOL');
    const usdc = await usdcOf(customer.publicKey);
    const treasuryHas = await usdcOf(treasury.publicKey);
    assert.ok(treasuryHas >= fund || usdc >= fund + priceAtomic, `the customer needs >= ${Number(fund + priceAtomic) / 1e6} devnet USDC to fund the treasury and pay the order, has ${Number(usdc) / 1e6}`);
  });
  await step('preflight: treasury has SOL (0.02 from the sponsor), a USDC token account (rent paid by the sponsor) and 3 USDC (from the customer wallet)', async () => {
    const instructions: web3.TransactionInstruction[] = [];
    if ((await solOf(treasury.publicKey)) < 10_000_000) instructions.push(SystemProgram.transfer({ fromPubkey: sponsor.publicKey, toPubkey: treasury.publicKey, lamports: 20_000_000 }));
    if (!(await rpc('treasury account', async () => ({ info: await connection.getAccountInfo(treasuryAta, 'finalized') }))).info) {
      instructions.push(spl.createAssociatedTokenAccountIdempotentInstruction(sponsor.publicKey, treasuryAta, treasury.publicKey, MINT));
    }
    if (instructions.length > 0) log('   funding transaction', explorer(await sendAsSponsor(instructions)));
    if ((await usdcOf(treasury.publicKey)) < fund) {
      const send = spl.createTransferCheckedInstruction(customerAta, MINT, treasuryAta, customer.publicKey, fund, 6);
      log('   USDC funding transaction', explorer(await sendAsSponsor([send], [customer])));
    }
    await until('funding to be visible', 90_000, async () => ((await usdcOf(treasury.publicKey)) >= fund && (await solOf(treasury.publicKey)) >= 10_000_000 ? true : null));
  });

  // ------------------------------------------------------------------ the throwaway app
  const prisma = new PrismaService();
  await prisma.$connect();
  @Global()
  @Module({ providers: [{ provide: PrismaService, useValue: prisma }], exports: [PrismaService] })
  class RealPrismaModule {}
  // The app binds the OFAC sanctions screen globally (SanctionsModule); this run stays offline and deterministic with an allow-all stand-in.
  @Global()
  @Module({ providers: [{ provide: COMPLIANCE_SCREEN, useFactory: () => new AllowAllComplianceScreen() }], exports: [COMPLIANCE_SCREEN] })
  class OfflineScreenModule {}
  const devSigner = createDevTreasurySigner(treasury);
  let signerCalls = 0;
  const countingSigner = {
    treasuryAddress: () => devSigner.treasuryAddress(),
    signTransaction: (...args: Parameters<typeof devSigner.signTransaction>) => {
      signerCalls++;
      return devSigner.signTransaction(...args);
    },
  };
  const signFee = ed25519Signer(sponsor);
  const feePayerSigner = { publicKey: sponsor.publicKey.toBase58(), signMessage: async (message: Uint8Array) => signFee(message) };
  const refundsModule = RefundsModule.register({
    imports: [WalletModule],
    providers: [
      { provide: CHAIN_PORT, useExisting: SOLANA_CHAIN },
      { provide: MERCHANT_SIGNER, useFactory: () => countingSigner }, // bound exactly like the dev launcher's override
    ],
  });
  const moduleRef = await Test.createTestingModule({
    imports: [
      RealPrismaModule,
      OfflineScreenModule,
      AdminCoreModule,
      WalletModule,
      OrdersModule,
      CheckoutModule.register({ imports: [WalletModule], providers: [...checkoutPortProviders, { provide: FEE_PAYER_SIGNER, useFactory: () => feePayerSigner }] }),
      AdminOrdersModule,
      refundsModule,
      AdminOrderRefundModule.register(refundsModule),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  process.env.NEXT_PUBLIC_API_URL = `${base}/v1`;
  const client = await import('../../apps/storefront/lib/wallet/api');
  log('throwaway API on', base);

  const address = customer.publicKey.toBase58();
  // An address belongs to one account only: a re-run reuses the account this wallet is already linked to (the proof-of-control link is idempotent).
  const linked = await prisma.customerWallet.findUnique({ where: { address }, include: { customer: { select: { email: true } } } });
  const email = linked?.customer.email ?? `live-refund-${address.slice(0, 8).toLowerCase()}-${randomBytes(3).toString('hex')}@example.test`;
  const adminToken = randomBytes(32).toString('base64url');
  const owner = await prisma.adminUser.create({ data: { email: `owner-${randomBytes(4).toString('hex')}@example.test`, name: 'Live refund owner', role: 'OWNER', passwordHash: 'x', mfaSeedEnc: 'x' } });
  await prisma.adminSession.create({ data: { adminId: owner.id, tokenHash: hashSessionToken(adminToken), expiresAt: new Date(Date.now() + 3_600_000) } });
  const admin = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(`${base}/v1/admin/orders${route}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };

  try {
    await step('link the customer wallet with proof of key control (challenge -> sign -> register)', async () => {
      await client.registerWallet(email, address, 'sandbox', async (message: string) => {
        const { createPrivateKey, sign: edSign } = require('node:crypto') as typeof import('node:crypto');
        const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(customer.secretKey.slice(0, 32))]);
        return edSign(null, Buffer.from(message, 'utf8'), createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })).toString('base64');
      });
      assert.equal((await client.fetchWallet(email))?.address, address);
    });
    const customerRow = await prisma.customer.findUniqueOrThrow({ where: { email } });
    await prisma.customerEligibility.upsert({
      where: { customerId: customerRow.id },
      create: { customerId: customerRow.id, status: 'APPROVED', reviewedAt: new Date(), reviewedBy: 'live-refund-run' },
      update: { status: 'APPROVED' },
    });

    // ------------------------------------------------------------------ the purchase ($1.25)
    const sku = `LIVE-RFD-${Date.now().toString(36)}`;
    const startStock = 5;
    const product = await prisma.product.create({ data: { sku, slug: sku.toLowerCase(), name: 'Live refund test item', active: true, priceCents: price, inventory: startStock } });
    await prisma.lot.create({ data: { code: `LOT-${sku}`, productId: product.id, coaKey: 'coa/none.pdf', purity: 0 } });
    const orderRes = await fetch(`${base}/v1/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `order-${sku}` },
      body: JSON.stringify({ email, shippingAddress: '1 Lab Way, Boston, MA', researchUseAcknowledged: true, items: [{ productId: product.id, lotCode: `LOT-${sku}`, quantity: 1 }] }),
    });
    const order = (await orderRes.json()) as { id: string; totalCents: number };
    assert.equal(orderRes.status, 201, JSON.stringify(order));
    assert.equal(order.totalCents, price);
    await step('the order reserved one unit of stock', async () => {
      assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).inventory, startStock - 1);
    });

    const prepared = await step('checkout prepare: exact amount to the dev treasury, fees sponsored', async () => {
      const p = await client.prepareCheckout(email, order.id);
      assert.equal(p.amountAtomic, priceAtomic);
      assert.equal(p.merchant, treasury.publicKey.toBase58());
      assert.equal(p.feeSponsored, true);
      return p;
    });
    await step('checkout submit: customer-signed payment is broadcast to devnet', async () => {
      await client.submitCheckout(email, order.id, customerSign(prepared.unsignedTransactionBase64));
    });
    await step('the payment finalizes on devnet and the order is PAID', async () => {
      await until('checkout to finalize', 240_000, async () => {
        const status = await client.fetchCheckoutStatus(email, order.id);
        if (status.phase === 'failed') throw new Error(`checkout failed: ${status.rawStatus}`);
        return status.phase === 'finalized' ? status : null;
      });
      assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status, 'PAID');
    });
    const purchase = await prisma.cryptoTransaction.findFirstOrThrow({ where: { orderId: order.id, type: 'PURCHASE', status: 'FINALIZED' } });
    log('   PURCHASE signature', purchase.txSignature, explorer(purchase.txSignature!));

    const customerAfterPurchase = await until('customer balance after the purchase', 90_000, async () => {
      const amount = await usdcOf(customer.publicKey);
      return amount;
    });
    const treasuryAfterPurchase = await usdcOf(treasury.publicKey);
    const treasurySolBefore = await solOf(treasury.publicKey);
    const customerSolBefore = await solOf(customer.publicKey);
    log('   before refund: customer USDC', customerAfterPurchase, 'treasury USDC', treasuryAfterPurchase, 'treasury SOL', treasurySolBefore, 'customer SOL', customerSolBefore);

    // ------------------------------------------------------------------ the refund
    await step('admin detail offers refund (PAID), refund is null, no wallet address is exposed', async () => {
      const detail = await admin('GET', `/${order.id}`);
      assert.equal(detail.status, 200);
      assert.ok(detail.body.allowedActions.includes('refund'));
      assert.equal(detail.body.refund, null);
      assert.ok(!JSON.stringify(detail.body).includes(address));
    });
    await step('admin refund request: REQUESTED for the exact paid amount; the order stays PAID', async () => {
      const res = await admin('POST', `/${order.id}/refund`, { reason: 'Live devnet refund proof' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.status, 'PAID');
      assert.equal(res.body.refund.status, 'REQUESTED');
      assert.equal(res.body.refund.amountAtomic, priceAtomic.toString());
    });
    await step('a destination in the request body is refused (the destination is always the customer wallet)', async () => {
      const res = await admin('POST', `/${order.id}/refund`, { reason: 'x', destination: Keypair.generate().publicKey.toBase58() });
      assert.equal(res.status, 400);
    });
    const submitted = await step('admin refund submit: signed by the dev treasury and broadcast to devnet', async () => {
      const res = await admin('POST', `/${order.id}/refund/submit`, {});
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.refund.status, 'SUBMITTED');
      assert.ok(res.body.refund.txSignature);
      return res.body.refund as { id: string; txSignature: string };
    });
    log('   REFUND signature', submitted.txSignature, explorer(submitted.txSignature));
    await step('double click: a second (and third, concurrent) submit returns the same transaction and signs nothing more', async () => {
      const again = await Promise.all([admin('POST', `/${order.id}/refund/submit`, {}), admin('POST', `/${order.id}/refund/submit`, {})]);
      for (const res of again) {
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.refund.txSignature, submitted.txSignature);
      }
      assert.equal(signerCalls, 1, 'the treasury signer was asked exactly once');
    });
    await step('shipping is refused while the refund is in flight', async () => {
      const res = await admin('POST', `/${order.id}/start-packing`, {});
      assert.equal(res.status, 409);
    });
    const done = await step('verify polls devnet until the refund is FINALIZED and the order is REFUNDED', async () =>
      until('the refund to finalize', 300_000, async () => {
        const res = await admin('POST', `/${order.id}/refund/verify`, {});
        if (res.status >= 500) throw new Error(`verify answered ${res.status}: ${JSON.stringify(res.body).slice(0, 120)}`);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        if (res.body.refund.status === 'FAILED') throw new Error(`refund failed: ${res.body.refund.failureReason}`);
        return res.body.refund.status === 'FINALIZED' ? res.body : null;
      }, 5_000),
    );
    assert.equal(done.status, 'REFUNDED');

    // ------------------------------------------------------------------ independent on-chain checks
    await step('ON CHAIN: the customer received exactly the paid amount and the treasury paid exactly that', async () => {
      const customerNow = await until('customer balance', 90_000, async () => {
        const amount = await usdcOf(customer.publicKey);
        return amount === customerAfterPurchase + priceAtomic ? amount : null;
      });
      assert.equal(customerNow - customerAfterPurchase, priceAtomic);
      assert.equal(treasuryAfterPurchase - (await usdcOf(treasury.publicKey)), priceAtomic);
    });
    await step('ON CHAIN: one signature (the treasury, also the fee payer), one transferChecked treasury -> customer, no sponsor involved, customer SOL untouched', async () => {
      const parsed = await until('refund transaction', 90_000, async () => connection.getParsedTransaction(submitted.txSignature, { maxSupportedTransactionVersion: 0, commitment: 'finalized' }));
      assert.equal(parsed.meta?.err, null);
      assert.equal(parsed.transaction.signatures.length, 1);
      const keys = parsed.transaction.message.accountKeys;
      assert.equal(keys[0].pubkey.toBase58(), treasury.publicKey.toBase58());
      assert.equal(keys[0].signer, true);
      assert.ok(!keys.some((k) => k.pubkey.equals(customer.publicKey) && k.signer), 'the customer never signs a refund');
      assert.ok(!keys.some((k) => k.pubkey.equals(sponsor.publicKey)), 'the sponsor is not part of the refund');
      const transfers = parsed.transaction.message.instructions.filter((i) => 'parsed' in i && (i as any).parsed?.type === 'transferChecked') as any[];
      assert.equal(transfers.length, 1);
      assert.equal(transfers[0].parsed.info.mint, MINT.toBase58());
      assert.equal(transfers[0].parsed.info.destination, customerAta.toBase58());
      // The Solana Pay reference account appended to the instruction makes the RPC parser report the owner as `multisigAuthority`.
      assert.equal(transfers[0].parsed.info.authority ?? transfers[0].parsed.info.multisigAuthority, treasury.publicKey.toBase58());
      assert.equal(transfers[0].parsed.info.tokenAmount.amount, priceAtomic.toString());
      assert.equal(await solOf(customer.publicKey), customerSolBefore, 'customer SOL unchanged');
      const feePaid = treasurySolBefore - (await solOf(treasury.publicKey));
      assert.ok(feePaid > 0 && feePaid <= 20_000, `the treasury paid the network fee (${feePaid} lamports)`);
    });
    await step('database: order REFUNDED, REFUNDED event, stock restored exactly once, audit rows for request/submit/verify', async () => {
      const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(row.status, 'REFUNDED');
      assert.ok(row.inventoryReleasedAt, 'inventoryReleasedAt is set');
      assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).inventory, startStock, 'stock is back');
      const events = await prisma.orderEvent.findMany({ where: { orderId: order.id, kind: 'STATUS' } });
      assert.deepEqual(events.map((e) => [e.fromStatus, e.toStatus]), [['PAID', 'REFUNDED']]);
      const audits = await prisma.adminAuditEvent.findMany({ where: { targetId: order.id }, orderBy: { createdAt: 'asc' } });
      assert.deepEqual(audits.map((a) => a.action), ['order.refund.request', 'order.refund.submit', 'order.refund.verify']);
    });
    await step('a second submit, a second request and a second verify after completion pay nothing more', async () => {
      assert.equal((await admin('POST', `/${order.id}/refund/submit`, {})).status, 409);
      assert.equal((await admin('POST', `/${order.id}/refund`, { reason: 'again' })).status, 409);
      const again = await admin('POST', `/${order.id}/refund/verify`, {});
      assert.equal(again.status, 200);
      assert.equal(again.body.status, 'REFUNDED');
      assert.equal(signerCalls, 1, 'the treasury signer was still asked exactly once');
      await sleep(20_000); // longer than a devnet confirmation round: a stray second transfer would have landed by now
      assert.equal((await usdcOf(customer.publicKey)) - customerAfterPurchase, priceAtomic, 'the customer was paid exactly once');
      assert.equal(await prisma.cryptoTransaction.count({ where: { orderId: order.id, type: 'REFUND' } }), 1);
      assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).inventory, startStock, 'stock was released once, not twice');
    });
    console.log('\nTRANSACTIONS');
    console.log(`  purchase: ${purchase.txSignature}\n            ${explorer(purchase.txSignature!)}`);
    console.log(`  refund:   ${submitted.txSignature}\n            ${explorer(submitted.txSignature)}`);
  } finally {
    await app.close();
    await prisma.$disconnect();
  }
}

main()
  .then(() => {
    console.log(`\nLIVE REFUND RUN: ${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
  })
  .catch((error) => {
    console.log(`\nLIVE REFUND RUN: ${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed (${(error as Error).message})`);
    process.exit(1);
  });
