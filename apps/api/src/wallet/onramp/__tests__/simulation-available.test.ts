import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DevnetSolanaChain } from '../../chain/devnet-solana-chain';
import { FLAGS, Harness, linkCustomer, makeConfig, makeHarness, rejection } from '../../__tests__/helpers';
import { centsToAtomic } from '../../contracts';
import { MOCK_COMPLETE_REFUSED_MESSAGE, OnRampService, canSimulateDeposits, mockCompleteRefusalMessage } from '../onramp.service';
import { MoonPayOnRampProvider } from '../moonpay-onramp.provider';

const DEVNET_TEXT = 'Simulated deposits only work on the in-memory sandbox chain. This API is on Solana devnet: send devnet USDC to your wallet address instead.';

/** The same service wired to a REAL DevnetSolanaChain (no RPC call is made unless something reads the chain). */
function devnetService(h: Harness) {
  const config = makeConfig({ chainMode: 'devnet' });
  const chain = new DevnetSolanaChain(FLAGS, { rpcUrl: 'https://api.devnet.solana.com' });
  return { chain, config, service: new OnRampService(h.db, h.wallets, h.provider, chain, config) };
}

test('simulationAvailable is true for a sandbox quote on the in-memory sandbox chain (createIntent and requote)', async () => {
  const h = makeHarness();
  const { customer } = await linkCustomer(h);
  const { intentId, quote } = await h.onRamp.createIntent(customer.id, { intendedUsdCents: 2_500 });
  assert.equal(quote.provider, 'moonpay-sandbox');
  assert.equal(quote.sandbox, true);
  assert.equal(quote.simulationAvailable, true);
  const intent = h.prisma.onRampIntent.rows.find((row) => row.id === intentId)!;
  const requote = await h.onRamp.requoteIntent(customer.id, intent as any);
  assert.equal(requote?.simulationAvailable, true);
  // And the advertised capability is real: mockComplete accepts it.
  assert.equal((await h.onRamp.mockComplete(customer.id, intentId)).credited, true);
});

test('simulationAvailable is false on a devnet-mode config, and mockComplete still refuses with the actionable message', async () => {
  const h = makeHarness({ config: { chainMode: 'devnet' } });
  const { customer } = await linkCustomer(h);
  const { intentId, quote } = await h.onRamp.createIntent(customer.id, { intendedUsdCents: 2_500 });
  // The honest-label fields are unchanged: this is exactly the case the storefront could not distinguish before.
  assert.equal(quote.provider, 'moonpay-sandbox');
  assert.equal(quote.sandbox, true);
  assert.ok(quote.widgetUrl.startsWith('/wallet/sandbox-onramp'));
  assert.equal(quote.simulationAvailable, false);
  const intent = h.prisma.onRampIntent.rows.find((row) => row.id === intentId)!;
  assert.equal((await h.onRamp.requoteIntent(customer.id, intent as any))?.simulationAvailable, false);
  const refused = await rejection(h.onRamp.mockComplete(customer.id, intentId));
  assert.equal(refused.status, 403);
  assert.equal(refused.message, DEVNET_TEXT);
  assert.equal(h.prisma.cryptoTransaction.rows.length, 0, 'a refused simulation writes no deposit');
  assert.equal(h.prisma.onRampIntent.rows.find((row) => row.id === intentId)!.status, 'CREATED');
});

test('with a REAL devnet chain: simulationAvailable false, mockComplete 403 with the devnet message, nothing credited', async () => {
  const h = makeHarness();
  const { customer } = await linkCustomer(h);
  const { service, chain, config } = devnetService(h);
  assert.equal(canSimulateDeposits(config, chain), false);
  const { intentId, quote } = await service.createIntent(customer.id, { intendedUsdCents: 1_000 });
  assert.equal(quote.provider, 'moonpay-sandbox');
  assert.equal(quote.simulationAvailable, false);
  const refused = await rejection(service.mockComplete(customer.id, intentId));
  assert.equal(refused.status, 403);
  assert.equal(refused.message, MOCK_COMPLETE_REFUSED_MESSAGE);
  assert.equal(refused.message, DEVNET_TEXT);
});

test('a production-like runtime never advertises simulation, even on a sandbox-class chain object', async () => {
  const h = makeHarness({ config: { isProductionLike: true, isProduction: true } });
  const { customer } = await linkCustomer(h);
  const { intentId, quote } = await h.onRamp.createIntent(customer.id, { intendedUsdCents: 100 });
  assert.equal(quote.simulationAvailable, false);
  assert.equal((await rejection(h.onRamp.mockComplete(customer.id, intentId))).status, 403);
});

test('a real MoonPay quote is never simulatable, even where mockComplete\'s environment gate would pass', async () => {
  const config = makeConfig({ moonpayPublishableKey: 'pk_test_abc123', moonpaySigningSecret: 'sk_test_secret' });
  const base = makeHarness({ config });
  const real = new MoonPayOnRampProvider({ ...FLAGS, enableRealMoonpay: true }, config);
  const service = new OnRampService(base.db, base.wallets, real, base.chain, config);
  assert.equal(canSimulateDeposits(config, base.chain), true, 'the environment gate itself is open');
  const { customer } = await linkCustomer(base);
  const { intentId, quote } = await service.createIntent(customer.id, { intendedUsdCents: 5_000 });
  assert.equal(quote.provider, 'moonpay');
  assert.equal(quote.simulationAvailable, false);
  const intent = base.prisma.onRampIntent.rows.find((row) => row.id === intentId)!;
  assert.equal((await service.requoteIntent(customer.id, intent as any))?.simulationAvailable, false);
  assert.equal((await rejection(service.mockComplete(customer.id, intentId))).status, 409, 'mockComplete refuses real-provider intents (unchanged)');
});

test('canSimulateDeposits and mockComplete use one rule: the quote flag equals "mockComplete would pass the environment gate"', async () => {
  for (const config of [{}, { chainMode: 'devnet' as const }, { isProductionLike: true, isProduction: true }, { isProductionLike: true, isProduction: false }]) {
    const h = makeHarness({ config });
    const { customer } = await linkCustomer(h);
    const { intentId, quote } = await h.onRamp.createIntent(customer.id, { intendedUsdCents: 100 });
    let accepted = true;
    try { await h.onRamp.mockComplete(customer.id, intentId); } catch (error: any) { accepted = error.getStatus?.() !== 403; }
    assert.equal(quote.simulationAvailable, accepted, JSON.stringify(config));
    assert.equal(canSimulateDeposits(h.config, h.chain), accepted, JSON.stringify(config));
  }
  // Sanity: the sandbox deposit still credits exactly the intended amount.
  const h = makeHarness();
  const { customer, address } = await linkCustomer(h);
  const { intentId } = await h.onRamp.createIntent(customer.id, { intendedUsdCents: 700 });
  await h.onRamp.mockComplete(customer.id, intentId);
  assert.equal(await h.chain.getFinalizedUsdcBalance(address), centsToAtomic(700));
});

test('the refusal message makes no devnet claim when the wired chain is not on devnet', () => {
  assert.equal(mockCompleteRefusalMessage({ network: 'solana-devnet' }), DEVNET_TEXT);
  assert.ok(!/devnet/i.test(mockCompleteRefusalMessage({ network: 'solana-mainnet' })));
});
