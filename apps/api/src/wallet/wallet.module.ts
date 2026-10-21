import { Module } from '@nestjs/common';
import { createSolanaChain } from './chain/chain.factory';
import { ChainPreflight } from './chain/chain-preflight';
import { CHAIN_READINESS_PORT } from './checkout/ports';
import { NetworkInfoController } from './network-info.controller';
import { CreditsService } from './credits.service';
import { loadFeatureFlags, WalletFeatureFlags } from './contracts';
import { MoonPayOnRampProvider } from './onramp/moonpay-onramp.provider';
import { loadMoonPayWebhookConfig, MOONPAY_WEBHOOK_CONFIG } from './onramp/moonpay-webhook.config';
import { MoonPayWebhookController } from './onramp/moonpay-webhook.controller';
import { MoonPayWebhookService } from './onramp/moonpay-webhook.service';
import { OnRampService } from './onramp/onramp.service';
import { OrderTopUpService } from './onramp/order-topup.service';
import { PrismaService } from '../prisma.service';
import { createPreparedTransactionStore } from './stores/prepared-store.factory';
import { TransfersService } from './transfers/transfers.service';
import { WalletController } from './wallet.controller';
import { loadRuntimeConfig, WalletRuntimeConfig } from './wallet.config';
import { WalletService } from './wallet.service';
import {
  COMPLIANCE_SCREEN,
  ONRAMP_PROVIDER,
  PREPARED_TX_STORE,
  SOLANA_CHAIN,
  WALLET_FEATURE_FLAGS,
  WALLET_RUNTIME_CONFIG,
} from './wallet.tokens';

export { SOLANA_CHAIN, WALLET_FEATURE_FLAGS, WALLET_RUNTIME_CONFIG, ONRAMP_PROVIDER, PREPARED_TX_STORE, COMPLIANCE_SCREEN };

/**
 * User-owned wallet and Research Credits. PrismaService comes from the global PrismaModule.
 * PREPARED_TX_STORE is Postgres-backed whenever a database is configured (WALLET_PREPARED_STORE=postgres|redis|memory;
 * memory is refused in production-like runtimes and is the default only in test/development without a database). COMPLIANCE_SCREEN is the sanctions screen from
 * the global SanctionsModule.
 */
@Module({
  controllers: [WalletController, MoonPayWebhookController, NetworkInfoController],
  providers: [
    { provide: WALLET_FEATURE_FLAGS, useFactory: () => loadFeatureFlags() },
    { provide: WALLET_RUNTIME_CONFIG, useFactory: () => loadRuntimeConfig() },
    {
      provide: SOLANA_CHAIN,
      inject: [WALLET_FEATURE_FLAGS, WALLET_RUNTIME_CONFIG],
      useFactory: (flags: WalletFeatureFlags, config: WalletRuntimeConfig) => createSolanaChain(flags, config),
    },
    // Boot-time chain preflight (genesis hash + USDC mint checks): refuses to start on a definitive failure, degraded while the RPC is unreachable.
    {
      provide: ChainPreflight,
      inject: [WALLET_RUNTIME_CONFIG],
      useFactory: (config: WalletRuntimeConfig) => new ChainPreflight(config),
    },
    { provide: CHAIN_READINESS_PORT, useExisting: ChainPreflight },
    {
      provide: ONRAMP_PROVIDER,
      inject: [WALLET_FEATURE_FLAGS, WALLET_RUNTIME_CONFIG],
      useFactory: (flags: WalletFeatureFlags, config: WalletRuntimeConfig) => new MoonPayOnRampProvider(flags, config),
    },
    // MoonPay buy webhook receiver (POST /v1/webhooks/moonpay): signature-authenticated, updates intent status + audit only.
    { provide: MOONPAY_WEBHOOK_CONFIG, useFactory: () => loadMoonPayWebhookConfig() },
    MoonPayWebhookService,
    {
      provide: PREPARED_TX_STORE,
      inject: [{ token: PrismaService, optional: true }],
      useFactory: (prisma?: PrismaService) => createPreparedTransactionStore({ prisma }),
    },
    // COMPLIANCE_SCREEN comes from the global SanctionsModule (compliance/sanctions): no local allow-all default.
    WalletService,
    CreditsService,
    OnRampService,
    OrderTopUpService,
    TransfersService,
  ],
  exports: [WalletService, CreditsService, SOLANA_CHAIN, WALLET_FEATURE_FLAGS, WALLET_RUNTIME_CONFIG, ChainPreflight],
})
export class WalletModule {}
