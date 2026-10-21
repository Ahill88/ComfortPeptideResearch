import { Module } from '@nestjs/common';
import { createSolanaChain } from './chain/chain.factory';
import { CreditsService } from './credits.service';
import { loadFeatureFlags, WalletFeatureFlags } from './contracts';
import { MoonPayOnRampProvider } from './onramp/moonpay-onramp.provider';
import { loadMoonPayWebhookConfig, MOONPAY_WEBHOOK_CONFIG } from './onramp/moonpay-webhook.config';
import { MoonPayWebhookController } from './onramp/moonpay-webhook.controller';
import { MoonPayWebhookService } from './onramp/moonpay-webhook.service';
import { OnRampService } from './onramp/onramp.service';
import { OrderTopUpService } from './onramp/order-topup.service';
import { AllowAllComplianceScreen } from './transfers/compliance-screen';
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
 * PREPARED_TX_STORE is Redis-backed in production (WALLET_PREPARED_STORE; memory is refused
 * there and is the default only in test/development). COMPLIANCE_SCREEN still allows everything and
 * must be replaced for production.
 */
@Module({
  controllers: [WalletController, MoonPayWebhookController],
  providers: [
    { provide: WALLET_FEATURE_FLAGS, useFactory: () => loadFeatureFlags() },
    { provide: WALLET_RUNTIME_CONFIG, useFactory: () => loadRuntimeConfig() },
    {
      provide: SOLANA_CHAIN,
      inject: [WALLET_FEATURE_FLAGS, WALLET_RUNTIME_CONFIG],
      useFactory: (flags: WalletFeatureFlags, config: WalletRuntimeConfig) => createSolanaChain(flags, config),
    },
    {
      provide: ONRAMP_PROVIDER,
      inject: [WALLET_FEATURE_FLAGS, WALLET_RUNTIME_CONFIG],
      useFactory: (flags: WalletFeatureFlags, config: WalletRuntimeConfig) => new MoonPayOnRampProvider(flags, config),
    },
    // MoonPay buy webhook receiver (POST /v1/webhooks/moonpay): signature-authenticated, updates intent status + audit only.
    { provide: MOONPAY_WEBHOOK_CONFIG, useFactory: () => loadMoonPayWebhookConfig() },
    MoonPayWebhookService,
    { provide: PREPARED_TX_STORE, useFactory: () => createPreparedTransactionStore() },
    { provide: COMPLIANCE_SCREEN, useFactory: () => new AllowAllComplianceScreen() },
    WalletService,
    CreditsService,
    OnRampService,
    OrderTopUpService,
    TransfersService,
  ],
  exports: [WalletService, CreditsService, SOLANA_CHAIN, WALLET_FEATURE_FLAGS, WALLET_RUNTIME_CONFIG],
})
export class WalletModule {}
