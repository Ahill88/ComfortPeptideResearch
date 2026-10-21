import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { PrismaService } from '../../../prisma.service';
import { FakePrisma, Harness, linkCustomer, makeHarness, rejection } from '../../__tests__/helpers';
import { centsToAtomic } from '../../contracts';
import { OrderTopUpConfig, OrderTopUpService, loadOrderTopUpConfig, topUpDollarsFor } from '../order-topup.service';

type Row = Record<string, any>;

/** Minimal keyed table for the two models the shared FakePrisma does not carry (order, customerEligibility). */
class SimpleTable {
  rows: Row[] = [];
  async findUnique({ where }: { where: Row }) {
    return this.rows.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)) ?? null;
  }
}

/** Every key of an on-ramp quote as returned by the API (provider quote + the additive simulationAvailable). */
const QUOTE_KEYS = ['destinationAddress', 'disclosures', 'estimatedFeeUsdCents', 'estimatedUsdcAtomic', 'intendedUsdCents', 'provider', 'sandbox', 'simulationAvailable', 'widgetUrl'];

const NO_BUFFER: OrderTopUpConfig = { feeBufferPercent: 0, minUsd: 1, maxUsd: 10_000 };

function build(config: OrderTopUpConfig = NO_BUFFER) {
  const h = makeHarness();
  const prisma = h.prisma as FakePrisma & { order: SimpleTable; customerEligibility: SimpleTable };
  prisma.order = new SimpleTable();
  prisma.customerEligibility = new SimpleTable();
  const service = new OrderTopUpService(h.db as PrismaService, h.credits, h.onRamp, h.wallets, config);
  return { h, prisma, service };
}

async function customerWith(ctx: ReturnType<typeof build>, email: string, fundCents: number, eligibility: string | null = 'APPROVED') {
  const linked = await linkCustomer(ctx.h, email);
  if (fundCents > 0) ctx.h.chain.creditUsdc(linked.address, centsToAtomic(fundCents));
  if (eligibility) ctx.prisma.customerEligibility.rows.push({ customerId: linked.customer.id, status: eligibility });
  return linked;
}

let orderSeq = 0;
function addOrder(ctx: ReturnType<typeof build>, customerId: string, totalCents: number, extra: Row = {}) {
  const id = `ord_${++orderSeq}`;
  ctx.prisma.order.rows.push({ id, customerId, totalCents, status: 'PENDING_PAYMENT', currency: 'USD', ...extra });
  return id;
}

const intents = (ctx: ReturnType<typeof build>) => ctx.prisma.onRampIntent.rows;

test('enough funds: topUpNeeded false, no intent created', async () => {
  const ctx = build();
  const { customer } = await customerWith(ctx, 'rich@example.com', 1_000);
  const orderId = addOrder(ctx, customer.id, 250);
  const result = await ctx.service.topUpForOrder(customer.id, orderId);
  assert.deepEqual(result, { topUpNeeded: false, orderId, requiredAtomic: 2_500_000n, spendableAtomic: 10_000_000n });
  assert.equal(intents(ctx).length, 0);
});

test('exactly enough funds is not a shortfall', async () => {
  const ctx = build();
  const { customer } = await customerWith(ctx, 'exact@example.com', 250);
  const orderId = addOrder(ctx, customer.id, 250);
  assert.equal((await ctx.service.topUpForOrder(customer.id, orderId)).topUpNeeded, false);
  assert.equal(intents(ctx).length, 0);
});

test('shortfall of 1.50 USDC rounds UP to 2 whole dollars; response carries the contract fields only', async () => {
  const ctx = build();
  const { customer, address } = await customerWith(ctx, 'short@example.com', 100);
  const orderId = addOrder(ctx, customer.id, 250);
  const result = await ctx.service.topUpForOrder(customer.id, orderId);
  assert.ok(result.topUpNeeded);
  assert.deepEqual(Object.keys(result).sort(), ['intentId', 'merchant', 'orderId', 'quote', 'requiredAtomic', 'shortfallAtomic', 'spendableAtomic', 'status', 'topUpNeeded', 'topUpUsdCents']);
  assert.equal(result.merchant, null, 'no treasury configured in this harness');
  assert.equal(result.requiredAtomic, 2_500_000n);
  assert.equal(result.spendableAtomic, 1_000_000n);
  assert.equal(result.shortfallAtomic, 1_500_000n);
  assert.equal(result.topUpUsdCents, 200);
  assert.equal(result.status, 'CREATED');
  assert.equal(result.quote.intendedUsdCents, 200);
  assert.equal(result.quote.destinationAddress, address, 'destination is the customer wallet');
  assert.equal(intents(ctx).length, 1);
  assert.equal(intents(ctx)[0].id, result.intentId);
  assert.equal(intents(ctx)[0].orderId, orderId);
  assert.equal(intents(ctx)[0].destinationAddress, address);
  assert.equal(intents(ctx)[0].intendedUsdCents, 200);
  const audit = ctx.prisma.walletAuditEvent.rows.find((row) => row.action === 'ONRAMP_ORDER_TOPUP_CREATED');
  assert.ok(audit);
  assert.equal(audit.detail.orderId, orderId);
  assert.equal(audit.detail.shortfallAtomic, '1500000');
  assert.equal(audit.detail.topUpUsdCents, 200);
});

test('the quote is exactly what POST /wallet/onramp would return for the same amount', async () => {
  const ctx = build();
  const { customer } = await customerWith(ctx, 'shape@example.com', 0);
  const orderId = addOrder(ctx, customer.id, 300);
  const topUp = await ctx.service.topUpForOrder(customer.id, orderId);
  assert.ok(topUp.topUpNeeded);
  const plain = await ctx.h.onRamp.createIntent(customer.id, { intendedUsdCents: topUp.topUpUsdCents });
  assert.deepEqual(Object.keys(topUp.quote).sort(), QUOTE_KEYS, 'the quote key set is exactly the contract, including the additive simulationAvailable');
  assert.deepEqual(Object.keys(topUp.quote).sort(), Object.keys(plain.quote).sort());
  assert.equal(topUp.quote.simulationAvailable, true, 'sandbox chain: the simulate button works');
  assert.equal(topUp.quote.simulationAvailable, plain.quote.simulationAvailable);
  assert.equal(topUp.quote.provider, plain.quote.provider);
  assert.equal(topUp.quote.destinationAddress, plain.quote.destinationAddress);
});

test('an exact whole-dollar shortfall is not rounded to the next dollar', async () => {
  const ctx = build();
  const { customer } = await customerWith(ctx, 'whole@example.com', 100);
  const orderId = addOrder(ctx, customer.id, 300);
  const result = await ctx.service.topUpForOrder(customer.id, orderId);
  assert.ok(result.topUpNeeded);
  assert.equal(result.topUpUsdCents, 200);
});

test('a sub-cent shortfall (1 base unit) still asks for one whole dollar', async () => {
  const ctx = build();
  const { customer, address } = await customerWith(ctx, 'dust@example.com', 0);
  ctx.h.chain.creditUsdc(address, 2_499_999n);
  const orderId = addOrder(ctx, customer.id, 250);
  const result = await ctx.service.topUpForOrder(customer.id, orderId);
  assert.ok(result.topUpNeeded);
  assert.equal(result.shortfallAtomic, 1n);
  assert.equal(result.topUpUsdCents, 100);
});

test('topUpDollarsFor: rounding, fee buffer, floor (pure)', () => {
  const cfg = (feeBufferPercent: number, minUsd = 1): OrderTopUpConfig => ({ feeBufferPercent, minUsd, maxUsd: 10_000 });
  assert.equal(topUpDollarsFor(1_500_000n, cfg(0)), 2n);
  assert.equal(topUpDollarsFor(2_000_000n, cfg(0)), 2n);
  assert.equal(topUpDollarsFor(2_000_000n, cfg(10)), 3n, '2.00 * 1.10 = 2.20 -> 3');
  assert.equal(topUpDollarsFor(10_000_000n, cfg(10)), 11n, '10.00 * 1.10 = 11.00 -> exactly 11, not 12');
  assert.equal(topUpDollarsFor(10_000_000n, cfg(100)), 20n);
  assert.equal(topUpDollarsFor(1_000_000n, cfg(0, 5)), 5n, 'floor applies');
  assert.equal(topUpDollarsFor(9_000_000n, cfg(0, 5)), 9n, 'floor does not reduce');
  assert.throws(() => topUpDollarsFor(0n, cfg(0)), RangeError);
});

test('fee buffer and minimum are applied to the intent amount', async () => {
  const ctx = build({ feeBufferPercent: 10, minUsd: 5, maxUsd: 10_000 });
  const { customer } = await customerWith(ctx, 'buffer@example.com', 0);
  const small = addOrder(ctx, customer.id, 150); // shortfall 1.50 -> 1.65 -> 2 -> floor 5
  const big = addOrder(ctx, customer.id, 2_000); // shortfall 20.00 -> 22.00 -> 22
  const a = await ctx.service.topUpForOrder(customer.id, small);
  const b = await ctx.service.topUpForOrder(customer.id, big);
  assert.ok(a.topUpNeeded && b.topUpNeeded);
  assert.equal(a.topUpUsdCents, 500);
  assert.equal(b.topUpUsdCents, 2_200);
  assert.equal(b.shortfallAtomic, 20_000_000n, 'shortfallAtomic reports the true shortfall, not the buffered purchase');
});

test('a needed amount above the maximum is a 400 and creates nothing', async () => {
  const ctx = build({ feeBufferPercent: 0, minUsd: 1, maxUsd: 100 });
  const { customer } = await customerWith(ctx, 'max@example.com', 0);
  const atCap = addOrder(ctx, customer.id, 10_000);
  const over = addOrder(ctx, customer.id, 10_001);
  assert.equal(((await ctx.service.topUpForOrder(customer.id, atCap)) as any).topUpUsdCents, 10_000);
  const before = intents(ctx).length;
  assert.equal((await rejection(ctx.service.topUpForOrder(customer.id, over))).status, 400);
  assert.equal(intents(ctx).length, before);
});

test('the fee buffer counts toward the maximum', async () => {
  const ctx = build({ feeBufferPercent: 50, minUsd: 1, maxUsd: 100 });
  const { customer } = await customerWith(ctx, 'bufmax@example.com', 0);
  const orderId = addOrder(ctx, customer.id, 8_000); // 80 * 1.5 = 120 > 100
  assert.equal((await rejection(ctx.service.topUpForOrder(customer.id, orderId))).status, 400);
  assert.equal(intents(ctx).length, 0);
});

test('env parsing: defaults, valid values, and strict rejection of bad values', () => {
  assert.deepEqual(loadOrderTopUpConfig({}), { feeBufferPercent: 0, minUsd: 1, maxUsd: 10_000 });
  assert.deepEqual(loadOrderTopUpConfig({ ONRAMP_FEE_BUFFER_PERCENT: ' 7 ', ONRAMP_MIN_USD: '20', ONRAMP_MAX_USD: '500' }), { feeBufferPercent: 7, minUsd: 20, maxUsd: 500 });
  assert.deepEqual(loadOrderTopUpConfig({ ONRAMP_FEE_BUFFER_PERCENT: '', ONRAMP_MIN_USD: '', ONRAMP_MAX_USD: '' }), { feeBufferPercent: 0, minUsd: 1, maxUsd: 10_000 });
  for (const env of [
    { ONRAMP_FEE_BUFFER_PERCENT: '101' },
    { ONRAMP_FEE_BUFFER_PERCENT: '-1' },
    { ONRAMP_FEE_BUFFER_PERCENT: '2.5' },
    { ONRAMP_FEE_BUFFER_PERCENT: 'ten' },
    { ONRAMP_MIN_USD: '0' },
    { ONRAMP_MIN_USD: '1.5' },
    { ONRAMP_MAX_USD: '0' },
    { ONRAMP_MAX_USD: '1000001' },
    { ONRAMP_MIN_USD: '50', ONRAMP_MAX_USD: '10' },
  ]) {
    assert.throws(() => loadOrderTopUpConfig(env), /ONRAMP_/, JSON.stringify(env));
  }
});

test("another customer's order and an unknown order are both 404 with no intent", async () => {
  const ctx = build();
  const owner = await customerWith(ctx, 'owner@example.com', 0);
  const intruder = await customerWith(ctx, 'intruder@example.com', 0);
  const orderId = addOrder(ctx, owner.customer.id, 500);
  const foreign = await rejection(ctx.service.topUpForOrder(intruder.customer.id, orderId));
  const missing = await rejection(ctx.service.topUpForOrder(intruder.customer.id, 'does-not-exist'));
  assert.equal(foreign.status, 404);
  assert.equal(missing.status, 404);
  assert.equal(foreign.message, missing.message, 'indistinguishable');
  assert.equal(intents(ctx).length, 0);
});

test('order not in PENDING_PAYMENT is 409 and creates no intent', async () => {
  const ctx = build();
  const { customer } = await customerWith(ctx, 'paid@example.com', 0);
  for (const status of ['PAID', 'CANCELLED', 'FULFILLED', 'EXPIRED']) {
    const orderId = addOrder(ctx, customer.id, 500, { status });
    assert.equal((await rejection(ctx.service.topUpForOrder(customer.id, orderId))).status, 409, status);
  }
  assert.equal(intents(ctx).length, 0);
});

test('a payment already in flight for the order is 409 (same guard as prepare)', async () => {
  const ctx = build();
  const { customer, address } = await customerWith(ctx, 'inflight@example.com', 0);
  const orderId = addOrder(ctx, customer.id, 500);
  await ctx.prisma.cryptoTransaction.create({
    data: { customerId: customer.id, type: 'PURCHASE', status: 'SUBMITTED', amountAtomic: 5_000_000n, sourceAddress: address, destinationAddress: 'merchant', mint: 'm', network: 'n', reference: 'r1', orderId, txSignature: 'sig' },
  });
  assert.equal((await rejection(ctx.service.topUpForOrder(customer.id, orderId))).status, 409);
  assert.equal(intents(ctx).length, 0);
});

test('unapproved eligibility (none, PENDING, REJECTED) is 403 and creates no intent', async () => {
  for (const eligibility of [null, 'PENDING', 'REJECTED']) {
    const ctx = build();
    const { customer } = await customerWith(ctx, 'elig@example.com', 0, eligibility);
    const orderId = addOrder(ctx, customer.id, 500);
    assert.equal((await rejection(ctx.service.topUpForOrder(customer.id, orderId))).status, 403, String(eligibility));
    assert.equal(intents(ctx).length, 0);
  }
});

test('a stale chain is 503 (never treated as 0 spendable) and creates no intent', async () => {
  const ctx = build();
  const { customer } = await customerWith(ctx, 'stale@example.com', 10_000);
  const orderId = addOrder(ctx, customer.id, 500);
  ctx.h.chain.setOutage(true);
  assert.equal((await rejection(ctx.service.topUpForOrder(customer.id, orderId))).status, 503);
  assert.equal(intents(ctx).length, 0);
  ctx.h.chain.setOutage(false);
  assert.equal((await ctx.service.topUpForOrder(customer.id, orderId)).topUpNeeded, false, 'recovers once the chain is readable');
});

test('no linked wallet is 409 and creates no intent', async () => {
  const ctx = build();
  const customer = await ctx.h.wallets.resolveCustomer('nowallet@example.com');
  ctx.prisma.customerEligibility.rows.push({ customerId: customer.id, status: 'APPROVED' });
  const orderId = addOrder(ctx, customer.id, 500);
  assert.equal((await rejection(ctx.service.topUpForOrder(customer.id, orderId))).status, 409);
  assert.equal(intents(ctx).length, 0);
});

test('a treasury-owned wallet can never be the destination', async () => {
  const ctx = build();
  const { customer, address } = await customerWith(ctx, 'treasury@example.com', 0);
  (ctx.h.config as { treasuryAddress: string | null }).treasuryAddress = address;
  const orderId = addOrder(ctx, customer.id, 500);
  assert.equal((await rejection(ctx.service.topUpForOrder(customer.id, orderId))).status, 409);
  assert.equal(intents(ctx).length, 0);
});

test('idempotent repeat returns the same intent with a fresh quote and creates no second row', async () => {
  const ctx = build();
  const { customer } = await customerWith(ctx, 'repeat@example.com', 100);
  const orderId = addOrder(ctx, customer.id, 250);
  const first = await ctx.service.topUpForOrder(customer.id, orderId);
  const second = await ctx.service.topUpForOrder(customer.id, orderId);
  assert.ok(first.topUpNeeded && second.topUpNeeded);
  assert.equal(second.intentId, first.intentId);
  assert.equal(second.topUpUsdCents, first.topUpUsdCents);
  assert.equal(second.quote.widgetUrl, first.quote.widgetUrl);
  assert.equal(intents(ctx).length, 1);
  assert.equal(ctx.prisma.walletAuditEvent.rows.filter((row) => row.action === 'ONRAMP_ORDER_TOPUP_CREATED').length, 1);
});

test('a PENDING intent is reused and reported as PENDING', async () => {
  const ctx = build();
  const { customer } = await customerWith(ctx, 'pending@example.com', 100);
  const orderId = addOrder(ctx, customer.id, 250);
  const first = await ctx.service.topUpForOrder(customer.id, orderId);
  assert.ok(first.topUpNeeded);
  intents(ctx)[0].status = 'PENDING';
  const again = await ctx.service.topUpForOrder(customer.id, orderId);
  assert.ok(again.topUpNeeded);
  assert.equal(again.intentId, first.intentId);
  assert.equal(again.status, 'PENDING');
});

test('parallel identical requests create exactly one intent', async () => {
  const ctx = build();
  const { customer } = await customerWith(ctx, 'parallel@example.com', 100);
  const orderId = addOrder(ctx, customer.id, 250);
  const results = await Promise.all(Array.from({ length: 6 }, () => ctx.service.topUpForOrder(customer.id, orderId)));
  assert.equal(new Set(results.map((r) => (r as any).intentId)).size, 1);
  assert.equal(intents(ctx).length, 1);
});

test('a changed amount creates a new intent and expires the old open one', async () => {
  const ctx = build();
  const { customer, address } = await customerWith(ctx, 'changed@example.com', 100);
  const orderId = addOrder(ctx, customer.id, 250); // shortfall 1.50 -> $2
  const first = await ctx.service.topUpForOrder(customer.id, orderId);
  assert.ok(first.topUpNeeded);
  ctx.h.chain.creditUsdc(address, 500_000n); // balance 1.50 -> shortfall 1.00 -> $1
  const second = await ctx.service.topUpForOrder(customer.id, orderId);
  assert.ok(second.topUpNeeded);
  assert.notEqual(second.intentId, first.intentId);
  assert.equal(second.topUpUsdCents, 100);
  assert.equal(intents(ctx).find((row) => row.id === first.intentId)!.status, 'EXPIRED');
  assert.equal(intents(ctx).find((row) => row.id === second.intentId)!.status, 'CREATED');
  assert.equal(intents(ctx).filter((row) => row.status === 'CREATED' || row.status === 'PENDING').length, 1, 'at most one open intent per order');
});

test("expiring is scoped to the order and the customer: other orders' and other customers' intents are untouched", async () => {
  const ctx = build();
  const a = await customerWith(ctx, 'scope-a@example.com', 0);
  const b = await customerWith(ctx, 'scope-b@example.com', 0);
  const orderA1 = addOrder(ctx, a.customer.id, 300);
  const orderA2 = addOrder(ctx, a.customer.id, 400);
  const orderB = addOrder(ctx, b.customer.id, 300);
  const [x, y, z] = [await ctx.service.topUpForOrder(a.customer.id, orderA1), await ctx.service.topUpForOrder(a.customer.id, orderA2), await ctx.service.topUpForOrder(b.customer.id, orderB)];
  assert.ok(x.topUpNeeded && y.topUpNeeded && z.topUpNeeded);
  ctx.h.chain.creditUsdc(a.address, 1_000_000n);
  await ctx.service.topUpForOrder(a.customer.id, orderA1); // amount changes for A1 only
  const status = (id: string) => intents(ctx).find((row) => row.id === id)!.status;
  assert.equal(status(x.intentId), 'EXPIRED');
  assert.equal(status(y.intentId), 'CREATED');
  assert.equal(status(z.intentId), 'CREATED');
});

test("the order's own active reservation is not double counted (mirrors checkout prepare)", async () => {
  const ctx = build();
  const { customer } = await customerWith(ctx, 'own@example.com', 300); // 3.00 USDC, order 2.50
  const orderId = addOrder(ctx, customer.id, 250);
  await ctx.prisma.creditReservation.create({ data: { customerId: customer.id, orderId, amountAtomic: 2_500_000n, expiresAt: new Date(Date.now() + 600_000) } });
  assert.equal((await ctx.h.credits.getBalance(customer.id)).spendableAtomic, 500_000n, 'balance endpoint subtracts the hold');
  const result = await ctx.service.topUpForOrder(customer.id, orderId);
  assert.equal(result.topUpNeeded, false, 'own hold is added back, so 3.00 covers the 2.50 order');
  assert.equal(result.spendableAtomic, 3_000_000n);
});

test("another order's active reservation DOES reduce spendable", async () => {
  const ctx = build();
  const { customer } = await customerWith(ctx, 'other-hold@example.com', 300);
  const other = addOrder(ctx, customer.id, 200);
  const orderId = addOrder(ctx, customer.id, 250);
  await ctx.prisma.creditReservation.create({ data: { customerId: customer.id, orderId: other, amountAtomic: 2_000_000n, expiresAt: new Date(Date.now() + 600_000) } });
  const result = await ctx.service.topUpForOrder(customer.id, orderId);
  assert.ok(result.topUpNeeded);
  assert.equal(result.spendableAtomic, 1_000_000n);
  assert.equal(result.shortfallAtomic, 1_500_000n);
  assert.equal(result.topUpUsdCents, 200);
});

test('an expired reservation for the order is not added back', async () => {
  const ctx = build();
  const { customer } = await customerWith(ctx, 'expired-hold@example.com', 100);
  const orderId = addOrder(ctx, customer.id, 250);
  await ctx.prisma.creditReservation.create({ data: { customerId: customer.id, orderId, amountAtomic: 2_500_000n, expiresAt: new Date(Date.now() - 1_000) } });
  const result = await ctx.service.topUpForOrder(customer.id, orderId);
  assert.ok(result.topUpNeeded);
  assert.equal(result.spendableAtomic, 1_000_000n);
});

test('top-up never credits, never marks anything paid, and never touches the chain balance', async () => {
  const ctx = build();
  const { customer, address } = await customerWith(ctx, 'nocredit@example.com', 100);
  const orderId = addOrder(ctx, customer.id, 250);
  await ctx.service.topUpForOrder(customer.id, orderId);
  assert.equal(await ctx.h.chain.getFinalizedUsdcBalance(address), 1_000_000n);
  assert.equal(ctx.prisma.cryptoTransaction.rows.length, 0);
  assert.equal(ctx.prisma.order.rows.find((row) => row.id === orderId)!.status, 'PENDING_PAYMENT');
  assert.equal(intents(ctx)[0].status, 'CREATED');
});

test('existing createIntent callers are unchanged: no orderId is stored when none is given', async () => {
  const h: Harness = makeHarness();
  const { customer } = await linkCustomer(h);
  const { intentId } = await h.onRamp.createIntent(customer.id, { intendedUsdCents: 5_000 });
  const row = h.prisma.onRampIntent.rows.find((r) => r.id === intentId)!;
  assert.equal(row.orderId, undefined);
});

test('response names the configured merchant treasury so the customer sees who is paid before consenting', async () => {
  const h = makeHarness();
  const prisma = h.prisma as FakePrisma & { order: SimpleTable; customerEligibility: SimpleTable };
  prisma.order = new SimpleTable();
  prisma.customerEligibility = new SimpleTable();
  const treasury = '44qaQ4qxPnuPYhAcrtpSgjuffBQBXGGEXBZB6LV8dGsb';
  const service = new OrderTopUpService(h.db as PrismaService, h.credits, h.onRamp, h.wallets, NO_BUFFER, { treasuryAddress: treasury });
  const ctx = { h, prisma, service };
  const { customer } = await customerWith(ctx, 'merchant@example.com', 100);
  const orderId = addOrder(ctx, customer.id, 250);
  const result = await service.topUpForOrder(customer.id, orderId);
  assert.ok(result.topUpNeeded);
  assert.equal(result.merchant, treasury);
});

test('order-topup quotes carry simulationAvailable: true on the sandbox chain, false in devnet mode (new intent and idempotent re-quote)', async () => {
  for (const [label, chainMode, expected] of [['sandbox', 'sandbox', true], ['devnet', 'devnet', false]] as const) {
    const h = makeHarness({ config: { chainMode } });
    const prisma = h.prisma as FakePrisma & { order: SimpleTable; customerEligibility: SimpleTable };
    prisma.order = new SimpleTable();
    prisma.customerEligibility = new SimpleTable();
    const ctx = { h, prisma, service: new OrderTopUpService(h.db as PrismaService, h.credits, h.onRamp, h.wallets, NO_BUFFER) };
    const { customer } = await customerWith(ctx, `${label}@example.com`, 0);
    const orderId = addOrder(ctx, customer.id, 300);
    const first = await ctx.service.topUpForOrder(customer.id, orderId);
    const again = await ctx.service.topUpForOrder(customer.id, orderId);
    assert.ok(first.topUpNeeded && again.topUpNeeded);
    assert.equal(again.intentId, first.intentId, `${label}: second call re-quotes the same intent`);
    assert.deepEqual(Object.keys(first.quote).sort(), QUOTE_KEYS, label);
    assert.deepEqual(Object.keys(again.quote).sort(), QUOTE_KEYS, label);
    assert.equal(first.quote.simulationAvailable, expected, `${label}: new intent`);
    assert.equal(again.quote.simulationAvailable, expected, `${label}: re-quote`);
    assert.equal(first.quote.provider, 'moonpay-sandbox', `${label}: the provider label itself does not change`);
  }
});
