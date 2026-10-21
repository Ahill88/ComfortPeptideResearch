/** Nest wiring of the anchoring module: tokens, strict startup config, optional signer, scheduler. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Global, Logger, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CoaAnchorModule } from '../../apps/api/src/coa/anchor/anchor.module';
import { CoaAnchorScheduler } from '../../apps/api/src/coa/anchor/anchor.scheduler';
import { AnchorService } from '../../apps/api/src/coa/anchor/anchor.service';
import { COA_PUBLISHER_SIGNER } from '../../apps/api/src/coa/anchor/coa-publisher-signer.port';
import { COA_ANCHOR_INFO } from '../../apps/api/src/coa/coa-anchor-info';
import { COA_ANCHOR_PORT } from '../../apps/api/src/coa/coa.types';
import { PrismaService } from '../../apps/api/src/prisma.service';
import { FakePrisma, InMemoryPublisherSigner } from './_anchor-helpers';

Logger.overrideLogger(false);

@Global()
@Module({ providers: [{ provide: PrismaService, useValue: new FakePrisma() }], exports: [PrismaService] })
class FakePrismaModule {}

async function compile(env: Record<string, string | undefined>, signer?: InMemoryPublisherSigner) {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) saved.set(key, process.env[key]);
  for (const [key, value] of Object.entries(env)) (value === undefined ? delete process.env[key] : (process.env[key] = value));
  try {
    const builder = Test.createTestingModule({ imports: [FakePrismaModule, CoaAnchorModule] });
    if (signer) builder.overrideProvider(COA_PUBLISHER_SIGNER).useValue(signer);
    return await builder.compile();
  } finally {
    for (const [key, value] of saved) (value === undefined ? delete process.env[key] : (process.env[key] = value));
  }
}

const OFF = { COA_ANCHOR_ENABLED: undefined, COA_ANCHOR_NETWORK: undefined, COA_ANCHOR_RPC_URL: undefined, COA_ANCHOR_RECONCILE_INTERVAL_MS: undefined };

test('default wiring: port is the service, anchor info says off, no signer bound, scheduler idle', async () => {
  const module = await compile(OFF);
  assert.ok(module.get(COA_ANCHOR_PORT) instanceof AnchorService);
  assert.deepEqual(module.get(COA_ANCHOR_INFO), { network: null, publisher: null, anchoringEnabled: false });
  assert.equal(module.get(COA_PUBLISHER_SIGNER), undefined);
  const scheduler = module.get(CoaAnchorScheduler);
  scheduler.onModuleInit();
  assert.equal((scheduler as unknown as { timer?: unknown }).timer, undefined);
  await module.close();
});

test('enabled without a signer: anchoring is unavailable (info says off) and requests leave PENDING rows', async () => {
  const module = await compile({ ...OFF, COA_ANCHOR_ENABLED: 'true' });
  assert.deepEqual(module.get(COA_ANCHOR_INFO), { network: null, publisher: null, anchoringEnabled: false });
  const prisma = module.get(PrismaService) as unknown as FakePrisma;
  const lot = prisma.addLot('LOT-9');
  const coa = prisma.addCoa(lot.id);
  await module.get<AnchorService>(COA_ANCHOR_PORT).requestAnchor({ coaId: coa.id, kind: 'PUBLISH' });
  assert.equal(prisma.anchors().length, 1);
  assert.match(prisma.anchors()[0].error, /no publisher signer/);
  await module.close();
});

test('enabled with a bound signer: anchor info names network and publisher; the scheduler runs only when enabled and the interval is > 0', async () => {
  const signer = new InMemoryPublisherSigner();
  const module = await compile({ ...OFF, COA_ANCHOR_ENABLED: 'true', COA_ANCHOR_RECONCILE_INTERVAL_MS: '3600000' }, signer);
  assert.deepEqual(module.get(COA_ANCHOR_INFO), { network: 'solana-devnet', publisher: signer.publicKey, anchoringEnabled: true });
  const scheduler = module.get(CoaAnchorScheduler);
  scheduler.onModuleInit();
  assert.ok((scheduler as unknown as { timer?: { hasRef(): boolean } }).timer);
  assert.equal((scheduler as unknown as { timer: { hasRef(): boolean } }).timer.hasRef(), false, 'the timer must not keep the process alive');
  scheduler.onModuleDestroy();
  await module.close();
  const zero = await compile({ ...OFF, COA_ANCHOR_ENABLED: 'true', COA_ANCHOR_RECONCILE_INTERVAL_MS: '0' }, signer);
  const idle = zero.get(CoaAnchorScheduler);
  idle.onModuleInit();
  assert.equal((idle as unknown as { timer?: unknown }).timer, undefined);
  await zero.close();
});

test('bad configuration stops startup', async () => {
  await assert.rejects(compile({ ...OFF, COA_ANCHOR_ENABLED: 'yes' }), /COA_ANCHOR_ENABLED/);
  await assert.rejects(compile({ ...OFF, COA_ANCHOR_NETWORK: 'solana-mainnet' }), /COA_ANCHOR_RPC_URL is required/);
  await assert.rejects(compile({ ...OFF, COA_ANCHOR_NETWORK: 'solana-testnet' }), /COA_ANCHOR_NETWORK/);
});
