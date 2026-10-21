import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { selectRateLimitBucket } from '../../config/rate-limit';
import { PrismaService } from '../../prisma.service';
import { COMMERCE_CONFIG, INT32_MAX, loadCommerceConfig } from '../commerce.config';
import { CommerceModule } from '../commerce.module';
import { InventoryService } from '../inventory.service';
import { INVENTORY_PORT } from '../inventory.types';
import { OrderSweepScheduler } from '../order-sweep.service';
import { OrderTotalTooLargeError, ShippingTaxCalculator } from '../shipping-tax.calculator';

const calc = (rules: Partial<ConstructorParameters<typeof ShippingTaxCalculator>[0]> = {}) =>
  new ShippingTaxCalculator({ shippingFlatCents: 0, shippingFreeOverCents: null, taxRateBps: 0, ...rules });

test('defaults: no shipping, never free-over, no tax, 60 minute hold, 60s sweep', () => {
  assert.deepEqual(loadCommerceConfig({}), { shippingFlatCents: 0, shippingFreeOverCents: null, taxRateBps: 0, holdMinutes: 60, sweepIntervalMs: 60_000 });
  assert.deepEqual(loadCommerceConfig({ SHIPPING_FLAT_CENTS: ' ', TAX_RATE_BPS: '', SHIPPING_FREE_OVER_CENTS: '  ' }), loadCommerceConfig({}));
  assert.deepEqual(
    loadCommerceConfig({ SHIPPING_FLAT_CENTS: '599', SHIPPING_FREE_OVER_CENTS: '10000', TAX_RATE_BPS: ' 825 ', ORDER_HOLD_MINUTES: '15', ORDER_SWEEP_INTERVAL_MS: '0' }),
    { shippingFlatCents: 599, shippingFreeOverCents: 10_000, taxRateBps: 825, holdMinutes: 15, sweepIntervalMs: 0 },
  );
  assert.equal(loadCommerceConfig({ SHIPPING_FREE_OVER_CENTS: '0' }).shippingFreeOverCents, 0, 'an explicit 0 is a threshold, not "unset"');
});

test('every malformed or out-of-range value is a startup error naming the variable, never a silent default', () => {
  const bad: Array<[string, string]> = [
    ['SHIPPING_FLAT_CENTS', '-1'], ['SHIPPING_FLAT_CENTS', '5.99'], ['SHIPPING_FLAT_CENTS', 'abc'], ['SHIPPING_FLAT_CENTS', '1e3'], ['SHIPPING_FLAT_CENTS', '0x10'],
    ['SHIPPING_FLAT_CENTS', '2147483648'], ['SHIPPING_FLAT_CENTS', '99999999999'], ['SHIPPING_FLAT_CENTS', '1,000'], ['SHIPPING_FLAT_CENTS', '+5'],
    ['SHIPPING_FREE_OVER_CENTS', '-5'], ['SHIPPING_FREE_OVER_CENTS', '1.5'], ['SHIPPING_FREE_OVER_CENTS', 'free'], ['SHIPPING_FREE_OVER_CENTS', '2147483648'],
    ['TAX_RATE_BPS', '10001'], ['TAX_RATE_BPS', '8.25'], ['TAX_RATE_BPS', '8.25%'], ['TAX_RATE_BPS', '-1'], ['TAX_RATE_BPS', 'ten'],
    ['ORDER_HOLD_MINUTES', '0'], ['ORDER_HOLD_MINUTES', '10081'], ['ORDER_HOLD_MINUTES', '1.5'], ['ORDER_HOLD_MINUTES', 'an hour'],
    ['ORDER_SWEEP_INTERVAL_MS', '-1'], ['ORDER_SWEEP_INTERVAL_MS', '86400001'], ['ORDER_SWEEP_INTERVAL_MS', '1s'],
  ];
  for (const [name, value] of bad) assert.throws(() => loadCommerceConfig({ [name]: value }), new RegExp(`${name} must be a whole number`), `${name}=${value}`);
  // Maxima are accepted.
  assert.equal(loadCommerceConfig({ SHIPPING_FLAT_CENTS: String(INT32_MAX) }).shippingFlatCents, INT32_MAX);
  assert.equal(loadCommerceConfig({ TAX_RATE_BPS: '10000' }).taxRateBps, 10_000);
});

test('tax is half-up on the subtotal, in integer cents', () => {
  const at = (subtotal: number, bps: number) => calc({ taxRateBps: bps }).compute(subtotal).taxCents;
  assert.equal(at(1, 5000), 1, '0.5 rounds up');
  assert.equal(at(1, 4999), 0, '0.4999 rounds down');
  assert.equal(at(3, 5000), 2, '1.5 rounds up');
  assert.equal(at(5, 1000), 1, '0.5 rounds up');
  assert.equal(at(4, 1000), 0, '0.4 rounds down');
  assert.equal(at(2000, 825), 165, 'exact');
  assert.equal(at(1999, 825), 165, '164.9175 rounds up');
  assert.equal(at(1234, 825), 102, '101.805 rounds up');
  assert.equal(at(1000, 0), 0);
  assert.equal(at(0, 825), 0);
  assert.equal(at(1_000_000, 10_000), 1_000_000, '100%');
});

test('shipping: flat charge, free only when the subtotal is strictly over the threshold', () => {
  const rules = { shippingFlatCents: 599, shippingFreeOverCents: 5000 };
  assert.equal(calc(rules).compute(4999).shippingCents, 599);
  assert.equal(calc(rules).compute(5000).shippingCents, 599, 'exactly at the threshold is not over it');
  assert.equal(calc(rules).compute(5001).shippingCents, 0);
  assert.equal(calc({ shippingFlatCents: 599 }).compute(1_000_000_000).shippingCents, 599, 'no threshold: never free');
  assert.equal(calc({ shippingFlatCents: 0 }).compute(10).shippingCents, 0);
  assert.equal(calc({ shippingFlatCents: 599, shippingFreeOverCents: 0 }).compute(1).shippingCents, 0);
});

test('total = subtotal + shipping + tax and is deterministic', () => {
  const calculator = calc({ shippingFlatCents: 599, shippingFreeOverCents: 10_000, taxRateBps: 825 });
  const a = calculator.compute(2000);
  assert.deepEqual(a, { subtotalCents: 2000, shippingCents: 599, taxCents: 165, totalCents: 2764 });
  assert.deepEqual(calculator.compute(2000), a);
  for (const subtotal of [0, 1, 99, 4999, 10_001, 123_456]) {
    const t = calculator.compute(subtotal);
    assert.equal(t.totalCents, t.subtotalCents + t.shippingCents + t.taxCents);
  }
});

test('Int32 safety: the maximum fits exactly, one more cent anywhere is OrderTotalTooLargeError', () => {
  assert.equal(calc().compute(INT32_MAX).totalCents, INT32_MAX);
  assert.throws(() => calc({ shippingFlatCents: 1 }).compute(INT32_MAX), OrderTotalTooLargeError);
  assert.equal(calc({ shippingFlatCents: 1 }).compute(INT32_MAX - 1).totalCents, INT32_MAX);
  assert.throws(() => calc({ taxRateBps: 1 }).compute(INT32_MAX), OrderTotalTooLargeError);
  assert.throws(() => calc({ taxRateBps: 10_000 }).compute(INT32_MAX), OrderTotalTooLargeError);
  assert.equal(calc({ taxRateBps: 10_000 }).compute(1_073_741_823).totalCents, 2_147_483_646);
  for (const bad of [-1, 1.5, Number.NaN, Infinity, INT32_MAX + 1]) assert.throws(() => calc().compute(bad), OrderTotalTooLargeError, String(bad));
});

test('POST /orders/quote is in the public rate-limit bucket; the other order routes are not', () => {
  assert.equal(selectRateLimitBucket('/v1/orders/quote'), 'public');
  assert.equal(selectRateLimitBucket('/orders/quote/'), 'public');
  assert.equal(selectRateLimitBucket('/v1/Orders/QUOTE?x=1'), 'public');
  assert.equal(selectRateLimitBucket('/v1/orders'), null);
  assert.equal(selectRateLimitBucket('/v1/orders/abc123'), null);
  assert.equal(selectRateLimitBucket('/v1/orders/quote/extra'), null);
});

const savedEnv = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

@Global()
@Module({ providers: [{ provide: PrismaService, useValue: {} }], exports: [PrismaService] })
class StubPrismaModule {}

test('CommerceModule exports INVENTORY_PORT (the InventoryService), the calculator and the config', async () => {
  const ref = await Test.createTestingModule({ imports: [StubPrismaModule, CommerceModule] }).compile();
  assert.ok(ref.get(INVENTORY_PORT, { strict: false }) instanceof InventoryService);
  assert.equal(ref.get(INVENTORY_PORT, { strict: false }), ref.get(InventoryService, { strict: false }));
  assert.ok(ref.get(ShippingTaxCalculator, { strict: false }));
  assert.equal(ref.get(COMMERCE_CONFIG, { strict: false }).holdMinutes, 60);
  await ref.close();
});

test('CommerceModule refuses to start on a bad value (like the ONRAMP_* settings)', async () => {
  for (const [name, value] of [['TAX_RATE_BPS', 'eight'], ['SHIPPING_FLAT_CENTS', '-3'], ['SHIPPING_FREE_OVER_CENTS', 'x'], ['ORDER_HOLD_MINUTES', '0'], ['ORDER_SWEEP_INTERVAL_MS', 'soon']]) {
    process.env[name] = value;
    await assert.rejects(Test.createTestingModule({ imports: [StubPrismaModule, CommerceModule] }).compile(), new RegExp(name), name);
    delete process.env[name];
  }
});

test('the sweep scheduler does not start a timer when ORDER_SWEEP_INTERVAL_MS=0, and starts (and clears) one otherwise', () => {
  const sweeper = { sweep: async () => ({ examined: 0, cancelled: 0, skipped: 0 }) } as never;
  const off = new OrderSweepScheduler(sweeper, loadCommerceConfig({ ORDER_SWEEP_INTERVAL_MS: '0' }));
  off.onModuleInit();
  assert.equal((off as unknown as { timer?: unknown }).timer, undefined);
  const on = new OrderSweepScheduler(sweeper, loadCommerceConfig({ ORDER_SWEEP_INTERVAL_MS: '5000' }));
  on.onModuleInit();
  assert.ok((on as unknown as { timer?: unknown }).timer);
  on.onModuleDestroy();
});
