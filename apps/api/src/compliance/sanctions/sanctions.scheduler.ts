import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { SANCTIONS_CONFIG, type SanctionsConfig } from './sanctions.config';
import { SanctionsService } from './sanctions.service';

const HOUR_MS = 3_600_000;
/** How often the job wakes up to check whether the list is due (the claim decides; most wake-ups do nothing). */
const TICK_MS = 15 * 60_000;
/** After a failed run, wait this long before an automatic retry. */
export const RETRY_GAP_MS = 30 * 60_000;

/**
 * Keeps the list fresh. Never delays boot: the first check runs on the next tick of the event loop, fire-and-forget, and every error is
 * swallowed after being logged (the service already recorded it). Multi-instance safe: the DB claim in SanctionsService decides who
 * downloads; an instance that finds a recent OK run (younger than SANCTIONS_REFRESH_HOURS) does nothing.
 * SANCTIONS_REFRESH_HOURS=0 turns the whole job off (startup run included).
 */
@Injectable()
export class SanctionsScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SanctionsScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sanctions: SanctionsService,
    @Inject(SANCTIONS_CONFIG) private readonly config: SanctionsConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.offIgnored) this.logger.warn('SANCTIONS_SCREENING=off is IGNORED outside development/test: screening stays enforced.');
    if (this.config.invalidMode) this.logger.warn('SANCTIONS_SCREENING has an unknown value; it is treated as "enforce". Use enforce or off.');
    if (this.config.mode === 'off') {
      this.logger.warn('!!! SANCTIONS_SCREENING=off: wallet addresses are NOT screened in this development/test runtime. !!!');
      return;
    }
    if (this.config.refreshHours === 0) {
      this.logger.warn('SANCTIONS_REFRESH_HOURS=0: the sanctions list is not refreshed automatically. Use POST /v1/admin/compliance/sanctions/refresh.');
      return;
    }
    if (!this.config.autoRefreshAllowed) return;
    this.startupTimer = setTimeout(() => void this.tick('startup'), 0);
    this.startupTimer.unref();
    this.timer = setInterval(() => void this.tick('schedule'), Math.min(TICK_MS, this.config.refreshHours * HOUR_MS));
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.timer) clearInterval(this.timer);
    this.startupTimer = null;
    this.timer = null;
  }

  /** One wake-up. Public so tests can drive it. */
  async tick(trigger: 'startup' | 'schedule'): Promise<void> {
    try {
      await this.sanctions.refresh({ trigger, minOkAgeMs: this.config.refreshHours * HOUR_MS, retryGapMs: RETRY_GAP_MS });
    } catch {
      this.logger.warn('Sanctions list refresh tick failed.');
    }
  }
}
