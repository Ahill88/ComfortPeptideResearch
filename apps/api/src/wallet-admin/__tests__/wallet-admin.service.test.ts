import 'reflect-metadata';
import * as assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { serialize, formatUsdcExact, floorResearchCredits } from '../serialize';
import { BALANCE_LABEL, WalletAdminService, clampTake } from '../wallet-admin.service';

/** Prisma double exposing ONLY read operations. Any write call throws TypeError (not a function). */
function prismaDouble(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ model: string; op: string; args: any }> = [];
  const model = (name: string, rows: unknown[] = [], extra: Record<string, unknown> = {}) => ({
    findMany: async (args: unknown) => (calls.push({ model: name, op: 'findMany', args }), rows),
    findFirst: async (args: unknown) => (calls.push({ model: name, op: 'findFirst', args }), rows[0] ?? null),
    groupBy: async (args: unknown) => (calls.push({ model: name, op: 'groupBy', args }), rows),
    aggregate: async (args: unknown) => (calls.push({ model: name, op: 'aggregate', args }), extra.aggregate),
  });
  const rows = (overrides.rows ?? {}) as Record<string, unknown[]>;
  const prisma = {
    customerWallet: model('customerWallet', rows.customerWallet),
    onRampIntent: model('onRampIntent', rows.onRampIntent),
    payment: model('payment', rows.payment),
    cryptoTransaction: model('cryptoTransaction', rows.cryptoTransaction, { aggregate: overrides.aggregate }),
    order: model('order', rows.order),
    $queryRaw: async (...args: unknown[]) => (calls.push({ model: 'raw', op: 'queryRaw', args: args as never }), overrides.raw ?? []),
  };
  return { prisma: prisma as never, calls };
}

const tx = (id: string, extra: Record<string, unknown> = {}) => ({
  id, customerId: 'c1', type: 'PURCHASE', status: 'FINALIZED', amountAtomic: 12_500_000n, feeLamports: 5000n,
  sourceAddress: 'src', destinationAddress: 'dst', mint: 'mint', network: 'solana-devnet', reference: `ref-${id}`,
  orderId: 'o1', txSignature: `sig-${id}`, failureReason: null, createdAt: new Date('2026-10-20T00:00:00Z'), finalizedAt: null, ...extra,
});

describe('serialization', () => {
  it('converts bigint (nested) and Date values to strings without precision loss', () => {
    const big = 9_007_199_254_740_993n; // > Number.MAX_SAFE_INTEGER
    const out = serialize({ a: big, nested: [{ b: 1n }], when: new Date('2026-01-02T03:04:05.000Z'), n: 3, s: 'x', nil: null }) as any;
    assert.equal(out.a, '9007199254740993');
    assert.equal(out.nested[0].b, '1');
    assert.equal(out.when, '2026-01-02T03:04:05.000Z');
    assert.equal(out.n, 3);
    assert.equal(out.nil, null);
    assert.doesNotThrow(() => JSON.stringify(out));
  });

  it('formats exact USDC strings and floors Research Credits', () => {
    assert.equal(formatUsdcExact(12_500_000n), '12.500000');
    assert.equal(formatUsdcExact(1n), '0.000001');
    assert.equal(formatUsdcExact(0n), '0.000000');
    assert.equal(floorResearchCredits(12_999_999n), '12');
    assert.equal(floorResearchCredits(999_999n), '0');
    assert.equal(floorResearchCredits(-5n), '0');
  });

  it('clamps page size to 1..100', () => {
    assert.equal(clampTake(undefined), 25);
    assert.equal(clampTake(1000), 100);
    assert.equal(clampTake(0), 1);
    assert.equal(clampTake(NaN), 25);
  });
});

describe('WalletAdminService (read-only)', () => {
  it('balances: latest snapshot, exact USDC, floor credits, label, bigint as strings', async () => {
    const { prisma, calls } = prismaDouble({
      rows: {
        customerWallet: [
          { id: 'w1', customerId: 'c1', address: 'A', network: 'solana-devnet', customer: { email: 'a@example.com' },
            snapshots: [{ mint: 'm', amountAtomic: 12_999_999n, slot: 123n, observedAt: new Date('2026-10-20T00:00:00Z') }] },
          { id: 'w2', customerId: 'c2', address: 'B', network: 'solana-devnet', customer: { email: 'b@example.com' }, snapshots: [] },
        ],
      },
    });
    const result: any = await new WalletAdminService(prisma).balances();
    assert.equal(result.label, BALANCE_LABEL);
    assert.equal(result.items[0].snapshot.amountAtomic, '12999999');
    assert.equal(result.items[0].snapshot.usdcExact, '12.999999');
    assert.equal(result.items[0].snapshot.researchCreditsFloor, '12');
    assert.equal(result.items[0].snapshot.slot, '123');
    assert.equal(result.items[1].snapshot, null);
    assert.doesNotThrow(() => JSON.stringify(result));
    const args = calls[0].args;
    assert.equal(args.select.snapshots.take, 1);
    assert.deepEqual(args.select.snapshots.orderBy[0], { observedAt: 'desc' });
  });

  it('pagination: take capped at 100, fetches one extra row, returns nextCursor', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => tx(`t${i}`));
    const { prisma, calls } = prismaDouble({ rows: { cryptoTransaction: rows } });
    const service = new WalletAdminService(prisma);
    const capped: any = await service.transactions(5000);
    assert.equal(calls[0].args.take, 101);
    assert.equal(capped.nextCursor, null);
    const paged: any = await service.transactions(2, 'cursorid');
    assert.equal(calls[1].args.take, 3);
    assert.deepEqual(calls[1].args.cursor, { id: 'cursorid' });
    assert.equal(calls[1].args.skip, 1);
    assert.equal(paged.items.length, 2);
    assert.equal(paged.nextCursor, 't1');
    assert.equal(paged.items[0].amountAtomic, '12500000');
    assert.equal(paged.items[0].feeLamports, '5000');
    assert.equal(paged.items[0].usdcExact, '12.500000');
  });

  it('transactions: filters by status; failed: FAILED/EXPIRED with failureReason', async () => {
    const { prisma, calls } = prismaDouble({ rows: { cryptoTransaction: [tx('f1', { status: 'FAILED', failureReason: 'blockhash expired' })] } });
    const service = new WalletAdminService(prisma);
    await service.transactions(10, undefined, 'SUBMITTED');
    assert.deepEqual(calls[0].args.where, { status: 'SUBMITTED' });
    const failed: any = await service.failed(10);
    assert.deepEqual(calls[1].args.where, { status: { in: ['FAILED', 'EXPIRED'] } });
    assert.equal(failed.items[0].failureReason, 'blockhash expired');
  });

  it('payment-intents: Payment rows and PURCHASE transactions; pending-orders: PENDING_PAYMENT', async () => {
    const { prisma, calls } = prismaDouble({
      rows: {
        payment: [{ id: 'p1', orderId: 'o1', provider: 'solana-usdc', status: 'PENDING', amountAtomic: '12500000', currency: 'USDC', walletAddress: null, txSignature: null, expiresAt: new Date(), createdAt: new Date() }],
        cryptoTransaction: [tx('t1')],
        order: [{ id: 'o1', customerId: 'c1', status: 'PENDING_PAYMENT', totalCents: 1250, currency: 'USD', createdAt: new Date(), customer: { email: 'a@example.com' }, payment: null, creditReservation: { status: 'ACTIVE', amountAtomic: 12_500_000n, expiresAt: new Date() } }],
      },
    });
    const service = new WalletAdminService(prisma);
    const intents: any = await service.paymentIntents();
    assert.equal(intents.payments.items[0].amountAtomic, '12500000');
    assert.equal(intents.cryptoPurchases.items[0].amountAtomic, '12500000');
    assert.deepEqual(calls.find((c) => c.model === 'cryptoTransaction')!.args.where, { type: 'PURCHASE' });
    const pending: any = await service.pendingOrders();
    assert.deepEqual(calls.find((c) => c.model === 'order')!.args.where, { status: 'PENDING_PAYMENT' });
    assert.equal(pending.items[0].creditReservation.amountAtomic, '12500000');
    assert.equal(pending.items[0].email, 'a@example.com');
  });

  it('settlements: aggregates by day with count and total atomic as strings', async () => {
    const { prisma } = prismaDouble({
      raw: [{ day: '2026-10-20', count: '3', total_atomic: '37500000' }, { day: '2026-10-19', count: '1', total_atomic: '1' }],
      aggregate: { _count: { _all: 4 }, _sum: { amountAtomic: 37_500_001n } },
    });
    const result: any = await new WalletAdminService(prisma).settlements(10);
    assert.deepEqual(result.items[0], { day: '2026-10-20', count: '3', totalAtomic: '37500000', totalUsdcExact: '37.500000' });
    assert.equal(result.allTime.count, '4');
    assert.equal(result.allTime.totalAtomic, '37500001');
    assert.equal(result.nextCursor, null);
  });

  it('reconciliation: zero-filled counts per status and oldest SUBMITTED age', async () => {
    const { prisma } = prismaDouble({ rows: { cryptoTransaction: [{ id: 't1', createdAt: new Date('2026-10-20T00:00:00Z'), txSignature: 'sig', type: 'PURCHASE', status: 'SUBMITTED', _count: { _all: 2 } }] } });
    class Fixed extends WalletAdminService { protected now() { return new Date('2026-10-20T00:10:00Z'); } }
    const result: any = await new Fixed(prisma).reconciliation();
    assert.equal(result.counts.SUBMITTED, 2);
    assert.equal(result.counts.FINALIZED, 0);
    assert.deepEqual(Object.keys(result.counts).sort(), ['CONFIRMED', 'EXPIRED', 'FAILED', 'FINALIZED', 'PREPARED', 'SUBMITTED']);
    assert.equal(result.oldestSubmitted.ageSeconds, 600);
  });

  it('write operations are not available on the prisma double used (service never calls them)', async () => {
    const { prisma } = prismaDouble({ rows: { customerWallet: [], onRampIntent: [], payment: [], cryptoTransaction: [], order: [] }, aggregate: { _count: { _all: 0 }, _sum: { amountAtomic: null } } });
    const service = new WalletAdminService(prisma);
    await service.directory(); await service.balances(); await service.funding(); await service.paymentIntents();
    await service.transactions(); await service.failed(); await service.pendingOrders(); await service.settlements(); await service.reconciliation();
    service.providers();
  });
});

describe('providers endpoint never leaks secrets', () => {
  const keys = ['ENABLE_REAL_MOONPAY', 'ENABLE_SOLANA_MAINNET', 'ENABLE_LIVE_CRYPTO_PAYMENTS', 'ENABLE_DELEGATED_PAYMENTS', 'ENABLE_LIVE_FULFILLMENT', 'MOONPAY_PUBLISHABLE_KEY', 'MOONPAY_SECRET_KEY', 'PRIVY_APP_SECRET', 'ADMIN_API_TOKEN', 'WALLET_CHAIN_MODE'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  afterEach(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  const service = () => new WalletAdminService(prismaDouble().prisma);

  it('defaults: sandbox, devnet, Privy not configured, all flags false', () => {
    for (const k of keys) delete process.env[k];
    const result: any = service().providers();
    assert.equal(result.privy.status, 'not configured');
    assert.equal(result.moonpay.mode, 'sandbox');
    assert.equal(result.moonpay.publishableKeyConfigured, false);
    assert.equal(result.solana.network, 'solana-devnet');
    assert.equal(result.solana.walletChainMode, 'unset');
    assert.deepEqual(Object.values(result.featureFlags), [false, false, false, false, false]);
    assert.equal(Object.keys(result.featureFlags).length, 5);
  });

  it('real MoonPay requires both the flag and a publishable key', () => {
    process.env.ENABLE_REAL_MOONPAY = 'true';
    delete process.env.MOONPAY_PUBLISHABLE_KEY;
    assert.equal((service().providers() as any).moonpay.mode, 'sandbox');
    process.env.MOONPAY_PUBLISHABLE_KEY = 'pk_live_SUPERSECRETVALUE';
    assert.equal((service().providers() as any).moonpay.mode, 'real');
  });

  it('response contains no secret values', () => {
    process.env.ENABLE_REAL_MOONPAY = 'true';
    process.env.MOONPAY_PUBLISHABLE_KEY = 'pk_live_SUPERSECRETVALUE';
    process.env.MOONPAY_SECRET_KEY = 'sk_live_TOPSECRET';
    process.env.PRIVY_APP_SECRET = 'privy_TOPSECRET';
    process.env.ADMIN_API_TOKEN = 'admin_TOPSECRET';
    process.env.WALLET_CHAIN_MODE = 'devnet';
    const json = JSON.stringify(service().providers());
    for (const secret of ['SUPERSECRETVALUE', 'TOPSECRET', 'pk_live', 'sk_live', 'admin_']) assert.ok(!json.includes(secret), `leaked ${secret}`);
    assert.ok(json.includes('"walletChainMode":"devnet"'));
  });

  it('does not echo arbitrary WALLET_CHAIN_MODE content', () => {
    process.env.WALLET_CHAIN_MODE = 'sk_live_not a mode value with spaces';
    const result: any = service().providers();
    assert.equal(result.solana.walletChainMode, 'invalid');
    assert.ok(!JSON.stringify(result).includes('sk_live'));
  });
});
