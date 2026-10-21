import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AnchorService } from './anchor.service';
import { COA_ANCHOR_CONFIG, type CoaAnchorConfig } from './coa-anchor.config';

/**
 * Runs AnchorService.reconcile() on an interval (COA_ANCHOR_RECONCILE_INTERVAL_MS, default 60000, 0 disables). Only scheduled when
 * COA_ANCHOR_ENABLED=true. Single-process timer (same pattern as the wallet ReconciliationScheduler): with several API instances
 * the sweep is still safe, because every state change is a compare-and-set and a duplicate memo is harmless.
 */
@Injectable()
export class CoaAnchorScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CoaAnchorScheduler.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly anchors: AnchorService, @Inject(COA_ANCHOR_CONFIG) private readonly config: CoaAnchorConfig) {}

  onModuleInit() {
    if (!this.config.enabled || this.config.reconcileIntervalMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), this.config.reconcileIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.running) return; // never overlap runs
    this.running = true;
    try {
      const summary = await this.anchors.reconcile();
      if (summary.checked) this.logger.log(`anchor sweep ${JSON.stringify(summary)}`);
    } catch (error) {
      this.logger.warn(`anchor sweep failed: ${error instanceof Error ? error.message.split('\n')[0] : 'unknown error'}`);
    } finally {
      this.running = false;
    }
  }
}
