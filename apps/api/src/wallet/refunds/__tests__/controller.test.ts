import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { AdminTokenGuard } from '../../../wallet-admin/admin-token.guard';
import { PrismaService } from '../../../prisma.service';
import { CHAIN_PORT } from '../../checkout/ports';
import { MERCHANT_SIGNER } from '../merchant-signer.port';
import { RefundsController } from '../refunds.controller';
import { RefundsModule } from '../refunds.module';
import { RefundsService } from '../refunds.service';
import { ORDER_ID, makeHarness } from './harness';

function controllerFor(h = makeHarness()) {
  return { h, controller: new RefundsController(h.service) };
}

function guardContext(token?: string) {
  return { switchToHttp: () => ({ getRequest: () => ({ headers: token === undefined ? {} : { 'x-admin-token': token } }) }) } as any;
}

const badRequest = (fn: () => unknown) =>
  assert.rejects(async () => fn(), (e: any) => {
    assert.equal(e.getStatus?.(), 400, `expected 400, got ${e.getStatus?.()} (${e.message})`);
    return true;
  });

test('controller is mounted at admin/refunds behind AdminTokenGuard with POST request/submit/verify and GET list', () => {
  assert.equal(Reflect.getMetadata(PATH_METADATA, RefundsController), 'admin/refunds');
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, RefundsController), [AdminTokenGuard]);
  const proto = RefundsController.prototype as any;
  const routes = Object.getOwnPropertyNames(proto)
    .filter((n) => n !== 'constructor')
    .map((n) => `${RequestMethod[Reflect.getMetadata(METHOD_METADATA, proto[n])]} ${Reflect.getMetadata(PATH_METADATA, proto[n])}`)
    .sort();
  assert.deepEqual(routes, ['GET /', 'POST :refundId/submit', 'POST :refundId/verify', 'POST request']);
});

test('admin guard still requires the token when NODE_ENV=production (and when unset, empty or wrong)', () => {
  const previousEnv = process.env.NODE_ENV;
  const previousToken = process.env.ADMIN_API_TOKEN;
  try {
    const guard = new AdminTokenGuard();
    process.env.NODE_ENV = 'production';
    delete process.env.ADMIN_API_TOKEN;
    assert.throws(() => guard.canActivate(guardContext('anything')));
    process.env.ADMIN_API_TOKEN = 'correct-horse';
    assert.throws(() => guard.canActivate(guardContext()));
    assert.throws(() => guard.canActivate(guardContext('wrong')));
    assert.equal(guard.canActivate(guardContext('correct-horse')), true);
    process.env.NODE_ENV = 'development';
    assert.throws(() => guard.canActivate(guardContext('wrong')));
  } finally {
    if (previousEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnv;
    if (previousToken === undefined) delete process.env.ADMIN_API_TOKEN; else process.env.ADMIN_API_TOKEN = previousToken;
  }
});

test('request rejects any destination-like or unknown property, and malformed fields', async () => {
  const { h, controller } = controllerFor();
  for (const extra of ['destination', 'destinationAddress', 'wallet', 'address', 'to', 'source', 'mint']) {
    await badRequest(() => controller.request({ orderId: ORDER_ID, reason: 'customer request', [extra]: h.stranger.publicKey.toBase58() }));
  }
  await badRequest(() => controller.request(null));
  await badRequest(() => controller.request([]));
  await badRequest(() => controller.request({ reason: 'customer request' }));
  await badRequest(() => controller.request({ orderId: ORDER_ID }));
  await badRequest(() => controller.request({ orderId: ORDER_ID, reason: 'customer request', amountAtomic: 5 }));
  await badRequest(() => controller.request({ orderId: ORDER_ID, reason: 'customer request', amountAtomic: '1.5' }));
  await badRequest(() => controller.request({ orderId: ORDER_ID, reason: 'customer request', amountAtomic: '0' }));
  await badRequest(() => controller.request({ orderId: ORDER_ID, reason: 'customer request', amountAtomic: '-1' }));
  assert.equal(h.prisma.refunds.length, 0);
});

test('request creates a refund whose destination is the customer wallet and parses amountAtomic as bigint', async () => {
  const { h, controller } = controllerFor();
  const full = await controller.request({ orderId: ORDER_ID, reason: 'customer request', amountAtomic: '100000000' });
  assert.equal(full.amountAtomic, '100000000');
  assert.equal(full.destination, h.customer.publicKey.toBase58());
  const rest = await controller.request({ orderId: ORDER_ID, reason: 'customer request' });
  assert.equal(rest.amountAtomic, '150000000');
  assert.equal(h.prisma.audits.find((a) => a.action === 'refund.requested')!.detail.actorId, 'admin-token');
});

test('submit/verify take no body and validate the id; list validates filters', async () => {
  const { h, controller } = controllerFor();
  const created = await controller.request({ orderId: ORDER_ID, reason: 'customer request' });
  await badRequest(() => controller.submit(created.refundId, { destination: h.stranger.publicKey.toBase58() }));
  await badRequest(() => controller.verify(created.refundId, { destination: h.stranger.publicKey.toBase58() }));
  await badRequest(() => controller.submit('bad id!'));
  await badRequest(() => controller.list(undefined, 'NOPE'));
  await badRequest(() => controller.list(undefined, undefined, '0'));
  await badRequest(() => controller.list('a b'));
  const submitted = await controller.submit(created.refundId, {});
  assert.equal(submitted.status, 'SUBMITTED');
  h.land(submitted);
  const verified = await controller.verify(created.refundId);
  assert.equal(verified.outcome, 'FINALIZED');
  const listed = await controller.list(ORDER_ID, 'FINALIZED', '10');
  assert.equal(listed.length, 1);
});

test('controller without a bound signer: submit answers 503 and nothing changes', async () => {
  const h = makeHarness();
  const controller = new RefundsController(h.serviceWithoutSigner);
  const created = await controller.request({ orderId: ORDER_ID, reason: 'customer request' });
  await assert.rejects(controller.submit(created.refundId), (e: any) => e.getStatus() === 503);
  assert.equal(h.prisma.txs.find((t) => t.id === created.refundId)!.status, 'PREPARED');
});

test('Nest DI: RefundsModule resolves with only PrismaService + CHAIN_PORT (MERCHANT_SIGNER is optional), and picks up a bound signer', async () => {
  const h = makeHarness();
  const base = [
    { provide: PrismaService, useValue: h.prisma },
    { provide: CHAIN_PORT, useValue: h.chain },
  ];
  const without = await Test.createTestingModule({ imports: [RefundsModule.register({ providers: base })] }).compile();
  const withoutService = without.get(RefundsService);
  const created = await withoutService.requestRefund(ORDER_ID, undefined, 'customer request', 'admin-1');
  await assert.rejects(withoutService.prepareAndSubmit(created.refundId), (e: any) => e.getStatus() === 503);

  const withSigner = await Test.createTestingModule({
    imports: [RefundsModule.register({ providers: [...base, { provide: MERCHANT_SIGNER, useValue: h.signer }] })],
  }).compile();
  const submitted = await withSigner.get(RefundsService).prepareAndSubmit(created.refundId);
  assert.equal(submitted.status, 'SUBMITTED');
});
