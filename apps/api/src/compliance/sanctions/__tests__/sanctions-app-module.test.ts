import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import { configureApp } from '../../../config/configure-app';
import { HEALTH_PREFIX_EXCLUDE } from '../../../health/health.module';
import { SolanaUsdcProcessor } from '../../../payments/solana-usdc.processor';
import { PrismaService } from '../../../prisma.service';
import { CheckoutService } from '../../../wallet/checkout/checkout.service';
import { OnRampService } from '../../../wallet/onramp/onramp.service';
import { TransfersService } from '../../../wallet/transfers/transfers.service';
import { COMPLIANCE_SCREEN } from '../../../wallet/wallet.tokens';
import { WalletService } from '../../../wallet/wallet.service';
import { SanctionsComplianceScreen } from '../sanctions.screen';

/**
 * Boots the REAL AppModule (same doubles as src/__tests__/app-module.test.ts: no Postgres, no Redis) and proves the sanctions screen is
 * what every screened service actually receives, the admin routes are mounted behind the session guard, and boot never touches the network.
 */
const saved: Record<string, string | undefined> = {};
const envOverrides: Record<string, string | undefined> = {
  NODE_ENV: 'test',
  ADMIN_API_TOKEN: 'a'.repeat(40),
  WALLET_RECONCILE_INTERVAL_MS: '0',
  WALLET_CHAIN_MODE: undefined,
  WALLET_PREPARED_STORE: undefined,
  SOLANA_USDC_TREASURY: '11111111111111111111111111111111',
  SANCTIONS_REFRESH_IN_TEST: undefined,
  SANCTIONS_SCREENING: undefined,
  SANCTIONS_REFRESH_HOURS: undefined,
};
let app: INestApplication;
let moduleRef: TestingModule;
let base = '';
const realFetch = globalThis.fetch;
const outbound: string[] = [];

before(async () => {
  for (const [key, value] of Object.entries(envOverrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (!url.startsWith('http://127.0.0.1')) outbound.push(url);
    return realFetch(input, init);
  }) as typeof fetch;
  const { AppModule } = await import('../../../app.module');
  const prisma = { async $queryRaw() { return [{ '?column?': 1 }]; }, cryptoTransaction: { findMany: async () => [] }, async $disconnect() {} };
  moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService).useValue(prisma)
    .overrideProvider(getQueueToken('payment-confirmation')).useValue({ add: async () => undefined, close: async () => undefined })
    .overrideProvider(SolanaUsdcProcessor).useValue({})
    .compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  app.setGlobalPrefix('v1', { exclude: HEALTH_PREFIX_EXCLUDE });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  configureApp(app as NestExpressApplication, process.env);
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
});

after(async () => {
  globalThis.fetch = realFetch;
  await app?.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('real AppModule: all four screened services hold the one sanctions screen bound to COMPLIANCE_SCREEN', () => {
  const bound = moduleRef.get(COMPLIANCE_SCREEN, { strict: false });
  assert.ok(bound instanceof SanctionsComplianceScreen);
  const held = (service: unknown) => (service as { screen?: unknown; compliance?: unknown }).screen ?? (service as { compliance?: unknown }).compliance;
  assert.equal(held(moduleRef.get(WalletService, { strict: false })), bound);
  assert.equal(held(moduleRef.get(OnRampService, { strict: false })), bound);
  assert.equal(held(moduleRef.get(TransfersService, { strict: false })), bound);
  assert.equal(held(moduleRef.get(CheckoutService, { strict: false })), bound);
});

test('real AppModule: boot made no outbound request (automatic refresh stays off in NODE_ENV=test)', () => {
  assert.deepEqual(outbound, []);
});

test('real AppModule: the admin routes exist and require an admin session', async () => {
  const get = await realFetch(`${base}/v1/admin/compliance/sanctions`);
  assert.equal(get.status, 401);
  const post = await realFetch(`${base}/v1/admin/compliance/sanctions/refresh`, { method: 'POST' });
  assert.equal(post.status, 401);
});
