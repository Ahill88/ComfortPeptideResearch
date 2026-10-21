/** CoaModule wiring without a database: optional ports, register() overrides, and the public-service default. */
import { AnchorService, CoaAnchorRefusedError } from '../anchor/anchor.service';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminAuditService } from '../../admin/admin-audit.service';
import { AdminCoreModule } from '../../admin/admin-core.module';
import { PrismaService } from '../../prisma.service';
import { COA_ANCHOR_INFO } from '../coa-anchor-info';
import { CoaAdminService } from '../coa-admin.service';
import { CoaPublicService } from '../coa-public.service';
import { CoaModule } from '../coa.module';
import { COA_ANCHOR_PORT } from '../coa.types';

const prismaDouble = {
  coa: { findUnique: async () => ({ id: 'c1', status: 'PUBLISHED', publishedAt: new Date() }) },
};
@Global()
@Module({ providers: [{ provide: PrismaService, useValue: prismaDouble }], exports: [PrismaService] })
class FakePrismaModule {}

const actor = { id: 'a1', role: 'OWNER' as const, ip: null };

test('the plain module boots with no anchor port and no anchor info: public info reports anchoring off; retry answers 503', async () => {
  const moduleRef = await Test.createTestingModule({ imports: [FakePrismaModule, AdminCoreModule, CoaModule] }).compile();
  assert.equal(moduleRef.get(CoaPublicService).info().anchoringEnabled, false);
  assert.equal(moduleRef.get(CoaPublicService).info().network, null);
  await assert.rejects(() => moduleRef.get(CoaAdminService).retryAnchor('c1', 'PUBLISH', actor), (error: any) => error.getStatus() === 503);
  await moduleRef.close();
});

test('register() supplies the anchor port and info; the port is what retry (and publish/revoke) call', async () => {
  const calls: unknown[] = [];
  const port = { requestAnchor: async (input: unknown) => void calls.push(input) };
  const info = { network: 'solana-devnet', publisher: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', anchoringEnabled: true };
  const moduleRef = await Test.createTestingModule({
    imports: [FakePrismaModule, AdminCoreModule, CoaModule.register({ providers: [{ provide: COA_ANCHOR_PORT, useValue: port }, { provide: COA_ANCHOR_INFO, useValue: info }] })],
  })
    .overrideProvider(AdminAuditService)
    .useValue({ record: async () => undefined })
    .compile();
  assert.deepEqual(moduleRef.get(CoaPublicService).info().network, 'solana-devnet');
  assert.equal(moduleRef.get(CoaPublicService).info().anchoringEnabled, true);
  const coaPrisma = prismaDouble.coa as any;
  coaPrisma.findUnique = async (args: any) => (args.include ? null : { id: 'c1', status: 'PUBLISHED', publishedAt: new Date() });
  await assert.rejects(() => moduleRef.get(CoaAdminService).retryAnchor('c1', 'PUBLISH', actor), /not found/i, 'reloading the missing double row 404s after the port was called');
  assert.deepEqual(calls, [{ coaId: 'c1', kind: 'PUBLISH' }]);
  await moduleRef.close();
});

test('admin retry uses the real AnchorService.retry (not the no-op port) and maps its refusals to HTTP statuses', async () => {
  const retried: unknown[] = [];
  let outcome: 'ok' | CoaAnchorRefusedError['reason'] = 'ok';
  const anchors = {
    retry: async (coaId: string, kind: string) => {
      retried.push({ coaId, kind });
      if (outcome !== 'ok') throw new CoaAnchorRefusedError(outcome, `refused: ${outcome}`);
      return {};
    },
  };
  const portCalls: unknown[] = [];
  const port = { requestAnchor: async (input: unknown) => void portCalls.push(input) };
  const moduleRef = await Test.createTestingModule({
    imports: [FakePrismaModule, AdminCoreModule, CoaModule.register({ providers: [{ provide: COA_ANCHOR_PORT, useValue: port }, { provide: AnchorService, useValue: anchors }] })],
  })
    .overrideProvider(AdminAuditService)
    .useValue({ record: async () => undefined })
    .compile();
  const coaPrisma = prismaDouble.coa as any;
  coaPrisma.findUnique = async (args: any) => (args.include ? null : { id: 'c1', status: 'PUBLISHED', publishedAt: new Date() });
  const service = moduleRef.get(CoaAdminService);
  const statusOf = async () => { try { await service.retryAnchor('c1', 'PUBLISH', actor); return 200; } catch (error: any) { return error.getStatus?.() ?? 500; } };

  // Success path calls retry (then the reload of the double row 404s, which proves the call happened before it).
  assert.equal(await statusOf(), 404);
  assert.deepEqual(retried, [{ coaId: 'c1', kind: 'PUBLISH' }]);
  assert.deepEqual(portCalls, [], 'the no-op port is NOT used when the real anchor service is present');
  for (const [reason, status] of [['NOT_FOUND', 404], ['ALREADY_CONFIRMED', 409], ['IN_FLIGHT', 409], ['NOT_ELIGIBLE', 409], ['DISABLED', 503], ['NO_SIGNER', 503], ['CHAIN_UNAVAILABLE', 503]] as const) {
    outcome = reason;
    assert.equal(await statusOf(), status, reason);
  }
  await moduleRef.close();
});
