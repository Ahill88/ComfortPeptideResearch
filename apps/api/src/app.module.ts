import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { LoggerModule } from 'nestjs-pino';
import { CatalogModule } from './catalog/catalog.module';
import { OrdersModule } from './orders/orders.module';
import { PaymentsModule } from './payments/payments.module';
import { PrismaModule } from './prisma.module';
import { AuthModule } from './auth/auth.module';
import { ComplianceModule } from './compliance/compliance.module';
import { WalletModule } from './wallet/wallet.module';
import { CheckoutModule } from './wallet/checkout/checkout.module';
import { checkoutPortProviders, ReconciliationScheduler } from './wallet/wallet.wiring';
import { CHAIN_PORT } from './wallet/checkout/ports';
import { RefundsModule } from './wallet/refunds/refunds.module';
import { SOLANA_CHAIN } from './wallet/wallet.tokens';
import { CoaAnchorModule } from './coa/anchor/anchor.module';
import { AdminCoreModule } from './admin/admin-core.module';
import { AdminAuthModule } from './admin/auth/admin-auth.module';
import { AdminOrdersModule } from './admin/orders/admin-orders.module';
import { CoaModule } from './coa/coa.module';
import { HealthModule } from './health/health.module';
import { WalletAdminModule } from './wallet-admin/wallet-admin.module';
import { assertValidEnv } from './config/env.validation';
import { buildThrottlerModuleOptions, RouteAwareThrottlerGuard } from './config/rate-limit';
import { isNonProductionRuntime } from './config/runtime';

@Module({
  imports: [
    // Must stay first: it loads .env into process.env before the factories below read it. Warnings are logged once by main.ts.
    ConfigModule.forRoot({
      isGlobal: true,
      // `pnpm dev:api` runs with apps/api as the working directory, while the example env lives at the repo root.
      envFilePath: ['.env', '../../.env'],
      validate: (config: Record<string, unknown>) => {
        assertValidEnv(config as Record<string, string | undefined>);
        return config;
      },
    }),
    ThrottlerModule.forRoot(buildThrottlerModuleOptions(process.env)),
    LoggerModule.forRoot({
      pinoHttp: {
        // Never log credentials. Pretty transport only on exact development/test runtimes.
        redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-admin-token"]', 'req.headers["x-customer-email"]', 'req.headers["moonpay-signature-v2"]', 'req.headers["moonpay-signature"]'], censor: '[redacted]' },
        ...(isNonProductionRuntime(process.env) ? { transport: { target: 'pino-pretty' } } : {}),
      },
    }),
    BullModule.forRoot({ connection: { host: process.env.REDIS_HOST ?? 'localhost', port: Number(process.env.REDIS_PORT ?? 6379) } }),
    PrismaModule,
    CatalogModule,
    OrdersModule,
    PaymentsModule,
    AuthModule,
    ComplianceModule,
    WalletModule,
    CheckoutModule.register({ imports: [WalletModule], providers: checkoutPortProviders }),
    WalletAdminModule,
    // Admin-only (AdminTokenGuard). MERCHANT_SIGNER is intentionally NOT bound: no signer implementation ships in
    // this repo, so POST /admin/refunds/:id/submit fails closed with 503. Bind a KMS/HSM-backed signer here later.
    RefundsModule.register({ imports: [WalletModule], providers: [{ provide: CHAIN_PORT, useExisting: SOLANA_CHAIN }] }),
    AdminCoreModule,
    AdminAuthModule,
    AdminOrdersModule,
    // COA core + public verification API. Anchoring (COA_ANCHOR_PORT / COA_ANCHOR_INFO) is injected optionally from the global CoaAnchorModule.
    CoaModule,
    // On-chain COA anchoring (global; strict COA_ANCHOR_* config; the publisher signer is NOT bound here, see anchor.module.ts).
    CoaAnchorModule,
    HealthModule,
  ],
  providers: [ReconciliationScheduler, { provide: APP_GUARD, useClass: RouteAwareThrottlerGuard }],
})
export class AppModule {}
