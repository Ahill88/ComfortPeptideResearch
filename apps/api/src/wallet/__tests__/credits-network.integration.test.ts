/**
 * Network-scoped balances against REAL Postgres (the in-memory double cannot prove the where-clauses). Needs TEST_DATABASE_URL pointing at a
 * scratch schema (never `public`/`dev`): tests/run-all.mjs reports this file as SKIPPED without it.
 *
 *   TEST_DATABASE_URL="postgresql://helix@127.0.0.1:54329/helix_field?schema=agent_<name>" NODE_ENV=test \
 *     pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only src/wallet/__tests__/credits-network.integration.test.ts
 */
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { PrismaService } from '../../prisma.service';
import { SandboxSolanaChain } from '../chain/sandbox-solana-chain';
import { CreditsService } from '../credits.service';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for this integration suite (run tests/run-all.mjs to see it reported as SKIPPED).');
const parsed = new URL(url);
const schema = parsed.searchParams.get('schema') ?? 'public';
if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || !/helix|test/i.test(parsed.pathname) || ['public', 'dev'].includes(schema)) {
  throw new Error(`Refusing to run against ${parsed.hostname}${parsed.pathname}?schema=${schema}: use a local helix/test database and your own scratch schema.`);
}
process.env.DATABASE_URL = url;

const USDC = (n: number) => BigInt(n) * 1_000_000n;
const tag = `netscope-${Date.now()}`;
let prisma: PrismaService;
const customerIds: string[] = [];

before(async () => {
  prisma = new PrismaService();
  await prisma.$connect();
});
after(async () => {
  // Also sweeps rows a previously crashed run of this file left behind (same email prefix).
  const stale = await prisma.customer.findMany({ where: { email: { startsWith: 'netscope-' } }, select: { id: true } });
  for (const { id } of stale) if (!customerIds.includes(id)) customerIds.push(id);
  for (const customerId of customerIds) {
    await prisma.balanceSnapshot.deleteMany({ where: { wallet: { customerId } } });
    await prisma.creditReservation.deleteMany({ where: { customerId } });
    await prisma.cryptoTransaction.deleteMany({ where: { customerId } });
    await prisma.customerWallet.deleteMany({ where: { customerId } });
    await prisma.order.deleteMany({ where: { customerId } });
    await prisma.customer.deleteMany({ where: { id: customerId } });
  }
  await prisma.$disconnect();
});

function asMainnet(chain: SandboxSolanaChain, mint: string): SandboxSolanaChain {
  return Object.create(chain, { network: { value: 'solana-mainnet' }, usdcMint: { value: mint } });
}

test('real Postgres: pending rows and reservations of the other network never change spendable', async () => {
  const customer = await prisma.customer.create({ data: { email: `${tag}@example.com` } });
  customerIds.push(customer.id);
  const address = Keypair.generate().publicKey.toBase58();
  const chain = new SandboxSolanaChain();
  chain.creditUsdc(address, USDC(1000));
  await prisma.customerWallet.create({ data: { customerId: customer.id, address, provider: 'privy', network: 'solana-devnet' } });

  const order = (suffix: string) => prisma.order.create({ data: { customerId: customer.id, totalCents: 1000, researchAcknowledgedAt: new Date(), idempotencyKey: `${tag}-${suffix}` } });
  const row = (reference: string, network: string, over: Record<string, unknown> = {}) =>
    prisma.cryptoTransaction.create({ data: { customerId: customer.id, type: 'PURCHASE', status: 'SUBMITTED', amountAtomic: USDC(5), sourceAddress: address, destinationAddress: Keypair.generate().publicKey.toBase58(), mint: 'm', network, reference: `${tag}-${reference}`, ...over } as never });
  const soon = new Date(Date.now() + 10 * 60_000);
  const reserve = (orderId: string, amountAtomic: bigint) => prisma.creditReservation.create({ data: { customerId: customer.id, orderId, amountAtomic, expiresAt: soon } });

  await row('pend-dev', 'solana-devnet', { amountAtomic: USDC(5) });
  await row('pend-main', 'solana-mainnet', { amountAtomic: USDC(40) });
  await row('wd-main', 'solana-mainnet', { type: 'WITHDRAWAL', amountAtomic: USDC(30) });
  const oA = await order('A'); await reserve(oA.id, USDC(10)); await row('rA', 'solana-devnet', { status: 'PREPARED', orderId: oA.id });
  const oB = await order('B'); await reserve(oB.id, USDC(20)); await row('rB', 'solana-mainnet', { status: 'PREPARED', orderId: oB.id });
  const oC = await order('C'); await reserve(oC.id, USDC(4));
  await row('rC1', 'solana-mainnet', { status: 'EXPIRED', orderId: oC.id, createdAt: new Date(Date.now() - 60_000) });
  await row('rC2', 'solana-devnet', { status: 'PREPARED', orderId: oC.id, createdAt: new Date(Date.now() - 30_000) });
  const oE = await order('E'); await reserve(oE.id, USDC(8)); // unattributed: kept

  const devnet = await new CreditsService(prisma, chain).getBalance(customer.id);
  assert.equal(devnet.pendingOutgoingAtomic, USDC(5));
  assert.equal(devnet.activeReservationsAtomic, USDC(10) + USDC(4) + USDC(8));
  assert.equal(devnet.spendableAtomic, USDC(1000) - USDC(5) - USDC(22));

  // The same database seen by a mainnet deployment: its wallet row says mainnet.
  await prisma.customerWallet.update({ where: { customerId: customer.id }, data: { network: 'solana-mainnet' } });
  const mainnet = await new CreditsService(prisma, asMainnet(chain, Keypair.generate().publicKey.toBase58())).getBalance(customer.id);
  assert.equal(mainnet.pendingOutgoingAtomic, USDC(40) + USDC(30));
  assert.equal(mainnet.activeReservationsAtomic, USDC(20) + USDC(8));
  assert.equal(mainnet.spendableAtomic, USDC(1000) - USDC(70) - USDC(28));
});
