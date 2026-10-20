import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { BALANCE_PORT, CHAIN_PORT, FULFILLMENT_PORT, WALLET_FLAGS, WALLET_LOOKUP_PORT } from './checkout/ports';
import type { BalancePort, FulfillmentTrigger, WalletLookupPort } from './checkout/ports';
import { ReconciliationService } from './checkout/reconciliation.service';
import { CreditsService } from './credits.service';
import { SOLANA_CHAIN, WALLET_FEATURE_FLAGS } from './wallet.tokens';

/**
 * Providers that satisfy the checkout module's ports using the wallet module.
 * Pass to `CheckoutModule.register({ imports: [WalletModule], providers: checkoutPortProviders })`.
 */
export const checkoutPortProviders = [
  { provide: CHAIN_PORT, useExisting: SOLANA_CHAIN },
  { provide: WALLET_FLAGS, useExisting: WALLET_FEATURE_FLAGS },
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
