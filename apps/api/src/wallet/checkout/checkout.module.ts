import { DynamicModule, Module, type ModuleMetadata, type Provider } from '@nestjs/common';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { createPreparedMessageStore } from '../stores/prepared-store.factory';
import {
  BALANCE_PORT,
  CHAIN_PORT,
  CHECKOUT_CONFIG,
  FULFILLMENT_PORT,
  PREPARED_MESSAGE_STORE,
  WALLET_FLAGS,
  WALLET_LOOKUP_PORT,
  loadCheckoutConfig,
} from './ports';
import { ReconciliationService } from './reconciliation.service';
import { VerificationService } from './verification.service';

/**
 * CheckoutModule: customer-authorized USDC checkout.
 *
 * PROVIDERS THE IMPORTER (lead / WalletModule) MUST SUPPLY, under these exact tokens (from ./ports):
 *   CHAIN_PORT           -> a SolanaChain implementation (contracts.ts)
 *   BALANCE_PORT         -> { getSpendable(customerId): Promise<SpendableBalance & { stale: boolean }> }
 *   WALLET_LOOKUP_PORT   -> { getWallet(customerId): Promise<{ address: string; network?: string } | null> }
 *   FULFILLMENT_PORT     -> { trigger({orderId, customerId, paymentReference, txSignature}): Promise<void> }
 *   WALLET_FLAGS         -> WalletFeatureFlags (loadFeatureFlags())
 * PrismaService comes from the global PrismaModule.
 *
 * OPTIONAL provider: FEE_PAYER_SIGNER (./fee-payer-signer.port.ts), the platform's network-fee signer. Production/devnet
 * deployments bind a KMS/HSM-backed implementation after `...checkoutPortProviders` (wallet.wiring.ts only binds a
 * sandbox-only in-memory signer, and only for the sandbox chain). With none bound, FEE_SPONSORSHIP has no effect: the
 * customer pays the fee in SOL. CheckoutService injects it with @Optional(), so it is deliberately NOT in
 * CHECKOUT_REQUIRED_TOKENS.
 *
 * Nest only resolves providers visible inside this module, so supply the ports via
 * `CheckoutModule.register({ imports: [...], providers: [{ provide: CHAIN_PORT, useExisting: SOLANA_CHAIN }, ...] })`.
 * (Alternatively import the plain CheckoutModule from a @Global module that exports those tokens.)
 *
 * Provided by this module: PREPARED_MESSAGE_STORE (Redis in production, in-memory in
 * test/development; chosen by WALLET_PREPARED_STORE, see ../stores/prepared-store.factory.ts; production refuses memory) and CHECKOUT_CONFIG (reads env:
 * SOLANA_USDC_TREASURY, optional SOLANA_USDC_MAINNET_MINT, FEE_SPONSORSHIP / FEE_SPONSOR_MIN_LAMPORTS /
 * FEE_SPONSOR_MAX_PER_CUSTOMER_DAY, strictly parsed: a bad value stops the API from starting).
 *
 * Exports CheckoutService, VerificationService and ReconciliationService; the lead schedules
 * ReconciliationService.reconcile() (no queue is created here).
 */
@Module({
  controllers: [CheckoutController],
  providers: [
    CheckoutService,
    VerificationService,
    ReconciliationService,
    { provide: PREPARED_MESSAGE_STORE, useFactory: () => createPreparedMessageStore() },
    { provide: CHECKOUT_CONFIG, useFactory: () => loadCheckoutConfig() },
  ],
  exports: [CheckoutService, VerificationService, ReconciliationService, PREPARED_MESSAGE_STORE],
})
export class CheckoutModule {
  static register(options: { imports?: ModuleMetadata['imports']; providers: Provider[] }): DynamicModule {
    return { module: CheckoutModule, imports: options.imports ?? [], providers: options.providers };
  }
}

export const CHECKOUT_REQUIRED_TOKENS = [CHAIN_PORT, BALANCE_PORT, WALLET_LOOKUP_PORT, FULFILLMENT_PORT, WALLET_FLAGS] as const;
