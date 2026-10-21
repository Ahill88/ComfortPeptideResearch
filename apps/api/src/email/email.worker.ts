import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { EMAIL_CONFIG, type EmailConfig } from './email.config';
import { EMAIL_PROVIDER, type EmailProvider, type SendResult } from './email.provider';
import { redactText } from './email.redact';
import { renderEmail } from './email.templates';
import { EmailValidationError } from './email.errors';

export const EMAIL_CLOCK = Symbol('EMAIL_CLOCK');
export type EmailClock = () => Date;

export const MAX_ATTEMPTS = 8;
/** Delay after failed attempt 1, 2, 3, 4, 5+ (the last step repeats). */
export const BACKOFF_MS: readonly number[] = [30_000, 120_000, 600_000, 3_600_000, 21_600_000];
/** A SENDING row whose lease ran out (worker crashed or hung) may be claimed again. */
export const LEASE_MS = 5 * 60_000;
export const RETENTION_MS = 90 * 24 * 3_600_000;
const SWEEP_EVERY_MS = 3_600_000;
const CANDIDATES_PER_PASS = 5;
const MAX_ROWS_PER_TICK = 25;
const TICK_BUDGET_MS = 120_000;
/** Templates whose data holds a one-time credential link: scrubbed from the row once the message is sent. */
const LINK_TEMPLATES = new Set(['email_verification', 'password_reset']);

export function backoffMs(attempts: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1];
}

interface ClaimedRow {
  id: string;
  toEmail: string;
  template: string;
  data: unknown;
  attempts: number;
  leaseUntil: Date;
}

export interface TickSummary {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  skipped: 'no-provider' | 'busy' | null;
}

/**
 * Sends PENDING EmailOutbox rows. No schema change is needed for leases: a claim is a compare-and-set
 * `UPDATE ... WHERE id AND status AND attempts AND nextAttemptAt` that moves the row to SENDING, bumps `attempts` and stores the
 * lease expiry in `nextAttemptAt` (now + 5 min). Of two instances racing for a row exactly one update matches; completion is a
 * second compare-and-set on the same fingerprint, so a worker that lost its lease can never overwrite a newer owner's result.
 * A SENDING row whose lease expired is claimable again (attempts keeps counting). The timer only runs when
 * EMAIL_WORKER_INTERVAL_MS > 0; tick() can also be driven by tests or an external scheduler.
 */
@Injectable()
export class EmailWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('EmailWorker');
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private warnedNoProvider = false;
  private lastSweepAt = 0;
  private readonly now: EmailClock;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMAIL_CONFIG) private readonly config: EmailConfig,
    @Optional() @Inject(EMAIL_PROVIDER) private readonly provider: EmailProvider | null = null,
    @Optional() @Inject(EMAIL_CLOCK) clock?: EmailClock,
  ) {
    this.now = clock ?? (() => new Date());
  }

  onModuleInit(): void {
    if (this.config.workerIntervalMs <= 0) return;
    this.warnIfNoProvider();
    this.timer = setInterval(() => void this.tick(), this.config.workerIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private warnIfNoProvider(): void {
    if (this.provider || this.warnedNoProvider) return;
    this.warnedNoProvider = true;
    this.logger.warn('EMAIL_PROVIDER is "none": NO EMAIL WILL BE SENT. Messages are stored in the outbox and stay PENDING. Set EMAIL_PROVIDER=resend with EMAIL_API_KEY and EMAIL_FROM.');
  }

  async tick(): Promise<TickSummary> {
    const summary: TickSummary = { claimed: 0, sent: 0, retried: 0, failed: 0, skipped: null };
    if (this.running) return { ...summary, skipped: 'busy' };
    this.running = true;
    try {
      await this.sweepRetention().catch((error) => this.logger.warn(`email retention sweep failed: ${redactText(error)}`));
      if (!this.provider) {
        this.warnIfNoProvider();
        return { ...summary, skipped: 'no-provider' };
      }
      const startedAt = this.now().getTime();
      while (summary.claimed < MAX_ROWS_PER_TICK && this.now().getTime() - startedAt < TICK_BUDGET_MS) {
        const row = await this.claimNext(summary);
        if (!row) break;
        summary.claimed += 1;
        await this.process(row, this.provider, summary);
      }
      if (summary.claimed > 0) this.logger.log(`email worker: claimed=${summary.claimed} sent=${summary.sent} retried=${summary.retried} failed=${summary.failed}`);
    } catch (error) {
      this.logger.warn(`email worker pass failed: ${redactText(error)}`);
    } finally {
      this.running = false;
    }
    return summary;
  }

  /** Deletes SENT rows older than 90 days. Runs at most once an hour (the first call always runs). */
  async sweepRetention(force = false): Promise<number> {
    const now = this.now().getTime();
    if (!force && this.lastSweepAt !== 0 && now - this.lastSweepAt < SWEEP_EVERY_MS) return 0;
    this.lastSweepAt = now;
    const { count } = await this.prisma.emailOutbox.deleteMany({ where: { status: 'SENT', sentAt: { lt: new Date(now - RETENTION_MS) } } });
    if (count > 0) this.logger.log(`email retention: removed ${count} sent row(s) older than 90 days`);
    return count;
  }

  /** Claims one due row (PENDING due, or SENDING with an expired lease) with a compare-and-set; null when nothing is claimable. */
  private async claimNext(summary: TickSummary): Promise<ClaimedRow | null> {
    for (let pass = 0; pass < 3; pass += 1) {
      const now = this.now();
      const candidates = await this.prisma.emailOutbox.findMany({
        where: { OR: [{ status: 'PENDING', nextAttemptAt: { lte: now } }, { status: 'SENDING', nextAttemptAt: { lte: now } }] },
        orderBy: { nextAttemptAt: 'asc' },
        take: CANDIDATES_PER_PASS,
      });
      if (candidates.length === 0) return null;
      for (const row of candidates) {
        const fingerprint = { id: row.id, status: row.status, attempts: row.attempts, nextAttemptAt: row.nextAttemptAt };
        if (row.attempts >= MAX_ATTEMPTS) {
          // A lease expired on the last allowed attempt: do not send a ninth time.
          const done = await this.prisma.emailOutbox.updateMany({ where: fingerprint, data: { status: 'FAILED', lastError: 'Worker stopped before the final attempt finished; attempt limit reached.' } });
          if (done.count === 1) summary.failed += 1;
          continue;
        }
        const leaseUntil = new Date(now.getTime() + LEASE_MS);
        const claimed = await this.prisma.emailOutbox.updateMany({ where: fingerprint, data: { status: 'SENDING', attempts: row.attempts + 1, nextAttemptAt: leaseUntil } });
        if (claimed.count === 1) return { id: row.id, toEmail: row.toEmail, template: row.template, data: row.data, attempts: row.attempts + 1, leaseUntil };
      }
    }
    return null;
  }

  private async process(row: ClaimedRow, provider: EmailProvider, summary: TickSummary): Promise<void> {
    let result: SendResult;
    try {
      const rendered = renderEmail(row.template, row.data);
      result = await provider.send({ id: row.id, to: row.toEmail, template: row.template, ...rendered });
    } catch (error) {
      result = error instanceof EmailValidationError
        ? { ok: false, retryable: false, error: `Stored message is not valid: ${error.reason}` }
        : { ok: false, retryable: true, error: redactText(error) };
    }
    const owned = { id: row.id, status: 'SENDING' as const, attempts: row.attempts, nextAttemptAt: row.leaseUntil };
    const knownValues = knownSensitiveValues(row);
    if (result.ok) {
      const done = await this.prisma.emailOutbox.updateMany({
        where: owned,
        data: {
          status: 'SENT',
          sentAt: this.now(),
          lastError: null,
          providerMessageId: result.providerMessageId,
          ...(LINK_TEMPLATES.has(row.template) ? { data: { removedAfterSend: true } } : {}),
        },
      });
      if (done.count === 1) summary.sent += 1;
      else this.logger.warn(`email id=${row.id} was sent but its lease had expired; another worker owns the row now`);
      return;
    }
    const lastError = redactText(result.error, [...knownValues, this.config.apiKey]);
    const permanent = !result.retryable || row.attempts >= MAX_ATTEMPTS;
    const now = this.now();
    const done = await this.prisma.emailOutbox.updateMany({
      where: owned,
      data: permanent
        ? { status: 'FAILED', lastError }
        : { status: 'PENDING', lastError, nextAttemptAt: new Date(now.getTime() + Math.max(backoffMs(row.attempts), result.retryAfterMs ?? 0)) },
    });
    if (done.count !== 1) return;
    if (permanent) {
      summary.failed += 1;
      this.logger.warn(`email id=${row.id} template=${row.template} failed permanently after ${row.attempts} attempt(s): ${lastError}`);
    } else {
      summary.retried += 1;
      this.logger.warn(`email id=${row.id} template=${row.template} attempt ${row.attempts} failed, will retry: ${lastError}`);
    }
  }
}

/** Values from the stored message that must never appear in a log line or lastError (links hold one-time tokens). */
function knownSensitiveValues(row: ClaimedRow): string[] {
  const out: string[] = [row.toEmail];
  const data = row.data as Record<string, unknown> | null;
  for (const key of ['link', 'trackingUrl']) {
    const value = data?.[key];
    if (typeof value !== 'string') continue;
    out.push(value);
    try {
      const url = new URL(value);
      for (const param of url.searchParams.values()) out.push(param);
    } catch {
      /* not a URL */
    }
  }
  return out;
}
