/**
 * MANUAL LIVE DEVNET RUN (not part of tests/run-all.mjs: the file name does not end in .test.ts).
 *
 * Drives the real Nest wallet + checkout + orders modules (real Prisma, DevnetSolanaChain against a real Solana
 * devnet RPC) ONLY through the real storefront client, then re-checks every result directly on chain.
 *
 *   DEVNET_KEYPAIR_FILE=/path/to/keypair.json \          # JSON array of the 64 secret-key bytes; a throwaway devnet key
 *   DEVNET_TREASURY=<devnet merchant address> \
 *   TEST_DATABASE_URL=postgresql://helix@127.0.0.1:54329/helix_field?schema=public \
 *   pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only ../../tests/wallet/live-devnet.run.ts
 *
 * The wallet must hold devnet SOL (fees) and devnet USDC (mint 4zMMC9sr...). Nothing is truncated: all rows created
 * here carry a unique email. Refuses non-devnet RPC URLs and non-local databases. The key is read from the file and is
 * never printed, logged, or sent anywhere: only signatures leave this process.
 */
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const apiRequire = createRequire(path.join(__dirname, '../../apps/api/package.json'));
const web3 = apiRequire('@solana/web3.js') as typeof import('@solana/web3.js');
const spl = apiRequire('@solana/spl-token') as typeof import('@solana/spl-token');
const { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } = web3;

const keypairFile = process.env.DEVNET_KEYPAIR_FILE;
const treasury = process.env.DEVNET_TREASURY;
const dbUrl = process.env.TEST_DATABASE_URL;
const rpcUrl = process.env.SOLANA_RPC_URL?.trim() || 'https://api.devnet.solana.com';
if (!keypairFile || !treasury || !dbUrl) throw new Error('DEVNET_KEYPAIR_FILE, DEVNET_TREASURY and TEST_DATABASE_URL are required.');
if (!/devnet/i.test(rpcUrl)) throw new Error(`Refusing to run: ${rpcUrl} does not look like a devnet RPC URL.`);
const db = new URL(dbUrl);
if (!['127.0.0.1', 'localhost'].includes(db.hostname)) throw new Error('Refusing to run: database is not local.');

process.env.DATABASE_URL = dbUrl;
process.env.NODE_ENV = 'test'; // enables the header identity used by the storefront client (never production-like)
process.env.WALLET_CHAIN_MODE = 'devnet';
process.env.SOLANA_NETWORK = 'solana-devnet';
process.env.SOLANA_RPC_URL = rpcUrl;
process.env.SOLANA_USDC_TREASURY = treasury;

const MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const customer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairFile, 'utf8')) as number[]));
const connection = new Connection(rpcUrl, 'finalized');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...parts: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...parts);

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
/** Retries through transient public-RPC failures (429 / 503) for up to `ms`. */
async function until<T>(what: string, ms: number, fn: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + ms;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value !== null) return value;
    } catch (error) {
      last = (error as Error).message;
    }
    await sleep(3_000);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${last})` : ''}`);
}
function sign(unsignedBase64: string): string {
  const tx = Transaction.from(Buffer.from(unsignedBase64, 'base64'));
  tx.partialSign(customer);
  return tx.serialize().toString('base64');
}
function walletSigner() {
  const { createPrivateKey, sign: edSign } = require('node:crypto') as typeof import('node:crypto');
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(customer.secretKey.slice(0, 32))]);
  return async (message: string) => edSign(null, Buffer.from(message, 'utf8'), createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })).toString('base64');
}
async function usdcOf(owner: web3.PublicKey): Promise<bigint> {
  try {
    const account = await spl.getAccount(connection, spl.getAssociatedTokenAddressSync(MINT, owner, true), 'finalized');
    return account.amount;
  } catch {
    return 0n;
  }
}

async function main() {
  const { Global, Module, ValidationPipe } = await import('@nestjs/common');
  const { Test } = await import('@nestjs/testing');
  const { PrismaService } = await import('../../apps/api/src/prisma.service');
  const { WalletModule } = await import('../../apps/api/src/wallet/wallet.module');
  const { CheckoutModule } = await import('../../apps/api/src/wallet/checkout/checkout.module');
  const { checkoutPortProviders } = await import('../../apps/api/src/wallet/wallet.wiring');
  const { OrdersModule } = await import('../../apps/api/src/orders/orders.module');

  const treasuryKey = new PublicKey(treasury!);
  const treasuryAta = spl.getAssociatedTokenAddressSync(MINT, treasuryKey, true);

  log('customer wallet', customer.publicKey.toBase58());
  log('treasury', treasury, 'treasury USDC account', treasuryAta.toBase58());

  const startSol = await step('preflight: wallet has devnet SOL for fees', async () => {
    const lamports = await connection.getBalance(customer.publicKey, 'finalized');
    assert.ok(lamports >= 10_000_000, `need >= 0.01 devnet SOL, have ${lamports / 1e9}`);
    return lamports;
  });
  const startUsdc = await step('preflight: wallet has devnet USDC', async () => {
    const amount = await usdcOf(customer.publicKey);
    assert.ok(amount >= 2_000_000n, `need >= 2 USDC, have ${Number(amount) / 1e6}`);
    return amount;
  });

  await step('preflight: treasury USDC account exists (creating it, paid by the test wallet, if not)', async () => {
    if (await connection.getAccountInfo(treasuryAta, 'finalized')) return;
    const ix = spl.createAssociatedTokenAccountIdempotentInstruction(customer.publicKey, treasuryAta, treasuryKey, MINT);
    const signature = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [customer], { commitment: 'finalized' });
    log('   created treasury token account', signature);
  });
  const treasuryBefore = await usdcOf(treasuryKey);

  const prisma = new PrismaService();
  await prisma.$connect();
  @Global()
  @Module({ providers: [{ provide: PrismaService, useValue: prisma }], exports: [PrismaService] })
  class RealPrismaModule {}
  const moduleRef = await Test.createTestingModule({
    imports: [RealPrismaModule, WalletModule, OrdersModule, CheckoutModule.register({ imports: [WalletModule], providers: checkoutPortProviders })],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  process.env.NEXT_PUBLIC_API_URL = `${base}/v1`;
  const client = await import('../../apps/storefront/lib/wallet/api');

  const address = customer.publicKey.toBase58();
  // Deterministic per wallet: an address can belong to only one account, so reruns must reuse the same account (idempotent re-link).
  const email = process.env.LIVE_DEVNET_EMAIL?.trim().toLowerCase() || `live-devnet-${address.slice(0, 10).toLowerCase()}@example.test`;
  try {
    await step('link wallet with proof of key control (challenge -> sign -> register)', async () => {
      await client.registerWallet(email, address, 'sandbox', walletSigner());
      const wallet = await client.fetchWallet(email);
      assert.equal(wallet?.address, address);
    });
    await step('a different account cannot link the same address (no signature from that account)', async () => {
      const other = `attacker-${Date.now().toString(36)}@example.test`;
      const attackerSigner = async () => Buffer.alloc(64, 1).toString('base64');
      await assert.rejects(client.registerWallet(other, address, 'sandbox', attackerSigner), /./);
    });
    const customerRow = await prisma.customer.findUniqueOrThrow({ where: { email } });
    await prisma.customerEligibility.upsert({
      where: { customerId: customerRow.id },
      create: { customerId: customerRow.id, status: 'APPROVED', reviewedAt: new Date(), reviewedBy: 'live-devnet-run' },
      update: { status: 'APPROVED' },
    });

    const balance = await step('API balance equals the real on-chain USDC balance (read at finalized)', async () => {
      const api = await client.fetchBalance(email);
      assert.equal(api.stale, false, 'balance must not be stale');
      assert.equal(api.finalizedAtomic, startUsdc);
      assert.equal(api.spendableAtomic, startUsdc);
      return api;
    });
    log('   API says finalized', balance.finalizedAtomic, 'spendable', balance.spendableAtomic, 'credits', balance.researchCredits);

    // ---------------- purchase ($1.25 = 1,250,000 atomic USDC) ----------------
    const price = 125;
    const priceAtomic = 1_250_000n;
    const sku = `LIVE-${Date.now().toString(36)}`;
    const product = await prisma.product.create({ data: { sku, slug: sku.toLowerCase(), name: 'Live devnet test item', active: true, priceCents: price, inventory: 1 } });
    await prisma.lot.create({ data: { code: `LOT-${sku}`, productId: product.id, coaKey: 'coa/none.pdf', purity: 0 } });
    const orderRes = await fetch(`${base}/v1/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `order-${sku}` },
      body: JSON.stringify({ email, shippingAddress: '1 Lab Way, Boston, MA', researchUseAcknowledged: true, items: [{ productId: product.id, lotCode: `LOT-${sku}`, quantity: 1 }] }),
    });
    const order = (await orderRes.json()) as { id: string; totalCents: number };
    assert.equal(orderRes.status, 201, JSON.stringify(order));

    const prepared = await step('checkout prepare: exact amount, treasury, devnet', async () => {
      const p = await client.prepareCheckout(email, order.id);
      assert.equal(p.amountAtomic, priceAtomic);
      assert.equal(p.merchant, treasury);
      assert.equal(p.network, 'solana-devnet');
      return p;
    });
    await step('checkout submit rejects an unsigned transaction', async () => {
      await assert.rejects(client.submitCheckout(email, order.id, prepared.unsignedTransactionBase64), /./);
    });
    await step('checkout submit: customer-signed transaction is broadcast to devnet', async () => {
      await client.submitCheckout(email, order.id, sign(prepared.unsignedTransactionBase64));
    });
    const final = await step('checkout reaches FINALIZED on devnet (polls the real chain)', async () =>
      until('checkout to finalize', 240_000, async () => {
        const status = await client.fetchCheckoutStatus(email, order.id);
        if (status.phase === 'failed') throw new Error(`checkout failed: ${status.rawStatus}`);
        return status.phase === 'finalized' ? status : null;
      }),
    );
    log('   checkout phase', final.phase, 'raw', final.rawStatus);
    await step('order is PAID in the database', async () => {
      assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status, 'PAID');
    });
    const purchaseTx = await prisma.cryptoTransaction.findFirstOrThrow({ where: { orderId: order.id } });
    log('   purchase signature', purchaseTx.txSignature, `https://explorer.solana.com/tx/${purchaseTx.txSignature}?cluster=devnet`);

    await step('independent on-chain check: wallet USDC fell by exactly the price, treasury rose by exactly the price', async () => {
      const wallet = await until('wallet balance to reflect the purchase', 90_000, async () => {
        const amount = await usdcOf(customer.publicKey);
        return amount === startUsdc - priceAtomic ? amount : null;
      });
      assert.equal(wallet, startUsdc - priceAtomic);
      assert.equal((await usdcOf(treasuryKey)) - treasuryBefore, priceAtomic);
    });
    await step('API balance falls by exactly the price (no separate credit deduction)', async () => {
      const after = await until('API balance', 60_000, async () => {
        const api = await client.fetchBalance(email);
        return api.finalizedAtomic === startUsdc - priceAtomic ? api : null;
      });
      assert.equal(after.spendableAtomic, startUsdc - priceAtomic);
    });
    await step('resubmitting the same signed payload after settlement never pays twice (idempotent or rejected)', async () => {
      await client.submitCheckout(email, order.id, sign(prepared.unsignedTransactionBase64)).catch(() => undefined);
      await sleep(20_000); // longer than a devnet confirmation round, so a second broadcast would have landed
      assert.equal(await usdcOf(treasuryKey), treasuryBefore + priceAtomic, 'treasury must have received exactly one payment');
      assert.equal(await prisma.cryptoTransaction.count({ where: { orderId: order.id, txSignature: { not: null } } }), 1, 'exactly one broadcast row');
    });

    // ---------------- external transfer (0.25 USDC to a fresh address) ----------------
    const destination = Keypair.generate().publicKey;
    const sendAtomic = 250_000n;
    const transfer = await step('transfer prepare: validates destination, fee and rent disclosure', async () => {
      const p = await client.prepareTransfer(email, { destination: destination.toBase58(), amountAtomic: sendAtomic });
      assert.equal(p.amountAtomic, sendAtomic);
      assert.ok(p.feeLamports !== null && p.feeLamports > 0n);
      return p;
    });
    await step('transfer to the customer\'s own wallet is refused', async () => {
      await assert.rejects(client.prepareTransfer(email, { destination: address, amountAtomic: sendAtomic }), /./);
    });
    const sent = await step('transfer submit: customer-signed withdrawal broadcast to devnet', async () => client.submitTransfer(email, transfer.id, sign(transfer.unsignedTransactionBase64)));
    log('   transfer signature', sent.signature, `https://explorer.solana.com/tx/${sent.signature}?cluster=devnet`);
    await step('transfer finalizes and the destination really received it', async () => {
      await until('withdrawal to finalize', 240_000, async () => {
        const history = await client.fetchTransactions(email);
        const withdrawal = history.find((t) => t.type === 'WITHDRAWAL');
        if (withdrawal?.status === 'failed') throw new Error('withdrawal failed');
        return withdrawal?.status === 'finalized' ? withdrawal : null;
      });
      assert.equal(await usdcOf(destination), sendAtomic);
    });
    await step('final API balance equals on-chain balance and equals start - price - sent', async () => {
      const expected = startUsdc - priceAtomic - sendAtomic;
      const api = await until('final balance', 90_000, async () => {
        const b = await client.fetchBalance(email);
        return b.finalizedAtomic === expected ? b : null;
      });
      assert.equal(api.spendableAtomic, expected);
      assert.equal(await usdcOf(customer.publicKey), expected);
    });
    const endSol = await connection.getBalance(customer.publicKey, 'finalized');
    log('   SOL spent on fees/rent', (startSol - endSol) / 1e9);
  } finally {
    await app.close();
    await prisma.$disconnect();
  }
}

main()
  .then(() => {
    console.log(`\nLIVE DEVNET RUN: ${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
  })
  .catch((error) => {
    console.log(`\nLIVE DEVNET RUN: ${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed (${(error as Error).message})`);
    process.exit(1);
  });
