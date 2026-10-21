import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Global, INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { selectRateLimitBucket } from '../../config/rate-limit';
import { PrismaService } from '../../prisma.service';
import { ChainPreflight } from '../chain/chain-preflight';
import { SandboxSolanaChain } from '../chain/sandbox-solana-chain';
import { USDC_DEVNET_MINT } from '../contracts';
import { COMPLIANCE_SCREEN, SOLANA_CHAIN, WalletModule } from '../wallet.module';
import { FakePrisma } from './helpers';

/** GET /v1/public/network-info through Nest DI and real HTTP: no identity, no database, cached, rate-limited as `public`. */
test('GET /v1/public/network-info: public, devnet body, 60 s cache header, and the public rate-limit bucket', async () => {
  const prisma = new FakePrisma();
  @Global()
  @Module({
    providers: [
      { provide: PrismaService, useValue: prisma },
      { provide: COMPLIANCE_SCREEN, useValue: { screen: async () => ({ allowed: true }) } },
    ],
    exports: [PrismaService, COMPLIANCE_SCREEN],
  })
  class TestGlobalModule {}
  delete process.env.WALLET_CHAIN_MODE;
  delete process.env.SOLANA_NETWORK;
  const moduleRef = await Test.createTestingModule({ imports: [TestGlobalModule, WalletModule] })
    .overrideProvider(SOLANA_CHAIN)
    .useValue(new SandboxSolanaChain())
    .compile();
  const app: INestApplication = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  await app.listen(0, '127.0.0.1');
  try {
    const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    const res = await fetch(`${base}/v1/public/network-info`); // no identity header, no cookie
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
    assert.deepEqual(await res.json(), {
      network: 'solana-devnet',
      usdcMint: USDC_DEVNET_MINT,
      explorerTxBase: 'https://explorer.solana.com/tx/',
      explorerClusterQuery: '?cluster=devnet',
      livePayments: false,
    });
    // the sandbox chain has no cluster to check, so the preflight is skipped and ready (the module hook ran)
    const preflight = moduleRef.get(ChainPreflight);
    assert.equal(preflight.getState(), 'skipped');
    assert.equal(preflight.isReady(), true);
    // the existing public bucket covers the route (the global throttler selects the bucket from the path alone)
    assert.equal(selectRateLimitBucket('/v1/public/network-info'), 'public');
    assert.equal(selectRateLimitBucket('/public/network-info?x=1'), 'public');
  } finally {
    await app.close();
  }
});
