import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SANDBOX_SPONSOR_LAMPORTS, SandboxFeePayerSigner } from './chain/sandbox-fee-payer-signer';
import { SandboxSolanaChain } from './chain/sandbox-solana-chain';
import { BALANCE_PORT, CHAIN_PORT, FEE_PAYER_SIGNER, FULFILLMENT_PORT, WALLET_FLAGS, WALLET_LOOKUP_PORT } from './checkout/ports';
import type { BalancePort, FeePayerSigner, FulfillmentTrigger, WalletLookupPort } from './checkout/ports';
import { ReconciliationService } from './checkout/reconciliation.service';
import { CreditsService } from './credits.service';
import { isSandboxAllowed, type WalletRuntimeConfig } from './wallet.config';
import { SOLANA_CHAIN, WALLET_FEATURE_FLAGS, WALLET_RUNTIME_CONFIG } from './wallet.tokens';

/**
 * FEE_PAYER_SIGNER for the SANDBOX chain only. Returns undefined (sponsorship unavailable) for every real chain:
 * production/devnet deployments bind their own KMS/HSM-backed signer under the FEE_PAYER_SIGNER token by listing
 * their provider AFTER `...checkoutPortProviders` (Nest keeps the last provider registered for a token), e.g.
 *   CheckoutModule.register({ imports: [WalletModule], providers: [...checkoutPortProviders, { provide: FEE_PAYER_SIGNER, useClass: KmsFeePayerSigner }] })
 * The sandbox signer's account is credited with sandbox SOL so it can pay (fake) fees.
 */
export function createSandboxFeePayerSigner(chain: unknown, config: WalletRuntimeConfig): FeePayerSigner | undefined {
  if (!(chain instanceof SandboxSolanaChain) || config.chainMode !== 'sandbox' || !isSandboxAllowed(config)) return undefined;
  const signer = new SandboxFeePayerSigner(config);
  chain.setSolBalance(signer.publicKey, SANDBOX_SPONSOR_LAMPORTS);
  return signer;
}

/**
 * Providers that satisfy the checkout module's ports using the wallet module.
 * Pass to `CheckoutModule.register({ imports: [WalletModule], providers: checkoutPortProviders })`.
 */
export const checkoutPortProviders = [
  { provide: CHAIN_PORT, useExisting: SOLANA_CHAIN },
  { provide: WALLET_FLAGS, useExisting: WALLET_FEATURE_FLAGS },
  {
    provide: FEE_PAYER_SIGNER,
    inject: [SOLANA_CHAIN, WALLET_RUNTIME_CONFIG],
    useFactory: (chain: unknown, config: WalletRuntimeConfig): FeePayerSigner | undefined => createSandboxFeePayerSigner(chain, config),
  },
  {
    provide: BALANCE_PORT,
    inject: [CreditsService],
    useFactory: (credits: CreditsService): BalancePort => ({
      async getSpendable(customerId) {
        const balance = await credits.getBalance(customerId);
        return {
          finalizedAtomic: balance.finalizedAtomic,
          spendableAtomic: balance.spendableAtomic,
          researchCredits: balance.researchCredits,
          stale: balance.stale,
        };
      },
    }),
  },
  {
    provide: WALLET_LOOKUP_PORT,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): WalletLookupPort => ({
      getWallet: (customerId) => prisma.customerWallet.findUnique({ where: { customerId }, select: { address: true, network: true } }),
    }),
  },
  {
    // Placeholder: there is no fulfillment integration yet. The checkout service only invokes this when
    // ENABLE_LIVE_FULFILLMENT=true (default false), so today a paid order is recorded as "held by flag".
    provide: FULFILLMENT_PORT,
    useFactory: (): FulfillmentTrigger => ({
      async trigger({ orderId }) {
        new Logger('Fulfillment').warn(`Fulfillment requested for order ${orderId} but no fulfillment provider is wired`);
      },
    }),
  },
];

/**
 * Runs checkout reconciliation on an interval. Disabled when WALLET_RECONCILE_INTERVAL_MS=0.
 * Single-process timer: with more than one API instance, move this to a BullMQ repeatable job.
 */
@Injectable()
export class ReconciliationScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconciliationScheduler.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly reconciliation: ReconciliationService) {}

  onModuleInit() {
    const interval = Number(process.env.WALLET_RECONCILE_INTERVAL_MS ?? 60_000);
    if (!Number.isFinite(interval) || interval <= 0) return;
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.running) return; // never overlap runs
    this.running = true;
    try {
      const summary = await this.reconciliation.reconcile();
      if (summary.checked || summary.expired) this.logger.log(`reconcile ${JSON.stringify(summary)}`);
    } catch (error) {
      this.logger.warn(`reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }
}
