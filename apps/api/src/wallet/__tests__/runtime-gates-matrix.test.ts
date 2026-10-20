import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { NODE_ENV_MATRIX, envOf, isAllowed, label } from '../../config/__tests__/node-env-matrix';
import { createSolanaChain } from '../chain/chain.factory';
import { DevnetSolanaChain } from '../chain/devnet-solana-chain';
import { SandboxSolanaChain } from '../chain/sandbox-solana-chain';
import { centsToAtomic } from '../contracts';
import { isSandboxAllowed, loadRuntimeConfig } from '../wallet.config';
import { FLAGS, linkCustomer, makeConfig, makeHarness, rejection } from './helpers';

describe('wallet runtime gates: NODE_ENV matrix', () => {
  for (const value of NODE_ENV_MATRIX) {
    test(`NODE_ENV=${label(value)}: runtime config, sandbox chain and mock-complete ${isAllowed(value) ? 'honored' : 'refused'}`, async () => {
      const env = envOf(value);
      const config = loadRuntimeConfig(env); // WALLET_CHAIN_MODE unset => sandbox default
      assert.equal(config.chainMode, 'sandbox');
      assert.equal(config.isProductionLike, !isAllowed(value));
      assert.equal(config.isProduction, config.isProductionLike, 'deprecated alias stays in sync');
      assert.equal(isSandboxAllowed(config), isAllowed(value));

      // sandbox chain
      const treasury = Keypair.generate().publicKey.toBase58();
      if (isAllowed(value)) assert.ok(createSolanaChain(FLAGS, { ...config, treasuryAddress: treasury }) instanceof SandboxSolanaChain);
      else assert.throws(() => createSolanaChain(FLAGS, { ...config, treasuryAddress: treasury }), /only allowed when NODE_ENV is exactly "development" or "test"/);

      // devnet mode is never the sandbox, in any runtime
      assert.ok(createSolanaChain(FLAGS, { ...loadRuntimeConfig(envOf(value, { WALLET_CHAIN_MODE: 'devnet' })) }) instanceof DevnetSolanaChain);

      // mock-complete, driven by the config derived from this exact NODE_ENV
      const h = makeHarness({ config: { isProductionLike: config.isProductionLike, isProduction: config.isProduction } });
      const { customer, address } = await linkCustomer(h);
      const { intentId } = await h.onRamp.createIntent(customer.id, { intendedUsdCents: 500 });
      if (isAllowed(value)) {
        assert.equal((await h.onRamp.mockComplete(customer.id, intentId)).credited, true);
        assert.equal(await h.chain.getFinalizedUsdcBalance(address), centsToAtomic(500));
      } else {
        assert.equal((await rejection(h.onRamp.mockComplete(customer.id, intentId))).status, 403);
        assert.equal(await h.chain.getFinalizedUsdcBalance(address), 0n, 'nothing credited');
        assert.equal(h.prisma.onRampIntent.rows.find((r) => r.id === intentId)!.status, 'CREATED');
      }
    });
  }

  test('fail closed on stale fixtures: a config that omits isProductionLike, or sets the deprecated alias, is refused', async () => {
    const stale = { ...makeConfig(), isProductionLike: undefined } as unknown as ReturnType<typeof makeConfig>;
    assert.equal(isSandboxAllowed(stale), false);
    assert.throws(() => createSolanaChain(FLAGS, stale), /sandbox/);
    assert.equal(isSandboxAllowed(makeConfig({ isProduction: true })), false);
    assert.equal(isSandboxAllowed(makeConfig()), true);

    const h = makeHarness({ config: { isProductionLike: undefined as unknown as boolean } });
    const { customer } = await linkCustomer(h);
    const { intentId } = await h.onRamp.createIntent(customer.id, { intendedUsdCents: 100 });
    assert.equal((await rejection(h.onRamp.mockComplete(customer.id, intentId))).status, 403);
  });
});
