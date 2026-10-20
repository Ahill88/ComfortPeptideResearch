import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { CHECKOUT_CONFIG, type CheckoutConfig } from './ports';
import { AMBIGUOUS_TRANSFER_REASON, VerificationService } from './verification.service';
import type { ReconcileSummary } from './checkout.types';

const MIN_AGE_MS = 60_000;

/**
 * Scheduler-agnostic reconciliation. The lead wires `reconcile()` into whatever scheduler is used
 * (BullMQ repeatable job, cron, ...). It is safe to run concurrently and repeatedly: every state
 * change is a conditional update and settlement itself is idempotent.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly verification: VerificationService,
    @Inject(CHECKOUT_CONFIG) private readonly config: CheckoutConfig,
  ) {}

  async reconcile(now: Date = new Date()): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = { checked: 0, finalized: 0, failed: 0, expired: 0, unavailable: 0 };

    // 1. In-flight purchases older than 1 minute: verify and settle.
    const inflight = await this.prisma.cryptoTransaction.findMany({
      where: {
        type: 'PURCHASE',
        status: { in: ['SUBMITTED', 'CONFIRMED'] },
        createdAt: { lt: new Date(now.getTime() - MIN_AGE_MS) },
      },
      orderBy: { createdAt: 'asc' },
    });
    for (const row of inflight) {
      summary.checked++;
      try {
        const result = await this.verification.verifyAndSettle({ paymentReference: row.reference });
        if (result.outcome === 'FINALIZED') summary.finalized++;
        else if (result.outcome === 'FAILED') summary.failed++;
        else if (result.outcome === 'PENDING' && result.reason === AMBIGUOUS_TRANSFER_REASON) {
          // The transaction LANDED but its transfer cannot be read unambiguously. It must never be expired (that would
          // release the reservation and let the customer pay a second time) nor failed or settled: it stays SUBMITTED
          // and holds the funds until an operator resolves it. Flag it once.
          await this.flagManualReview(row);
        } else if (
          result.outcome === 'PENDING' &&
          result.pendingKind === 'not_found' &&
          row.createdAt.getTime() < now.getTime() - this.config.reservationTtlMs
        ) {
          // The blockhash of a never-landed transaction expires within ~2 minutes; after the full
          // reservation TTL it can no longer land, so release it.
          if (await this.expireNeverLanded(row)) summary.expired++;
        }
      } catch (error) {
        if (error instanceof ServiceUnavailableException) summary.unavailable++;
        else this.logger.error(`Reconcile failed for ${row.reference}: ${(error as Error).message}`);
      }
    }

    // 2. ACTIVE reservations past expiry (unless a submitted payment is still in flight).
    const stale = await this.prisma.creditReservation.findMany({ where: { status: 'ACTIVE', expiresAt: { lt: now } } });
    for (const reservation of stale) {
      const pending = await this.prisma.cryptoTransaction.findFirst({
        where: { orderId: reservation.orderId, type: 'PURCHASE', status: { in: ['SUBMITTED', 'CONFIRMED'] } },
      });
      if (pending) continue;
      summary.expired += await this.prisma.$transaction(async (tx) => {
        const released = await tx.creditReservation.updateMany({ where: { id: reservation.id, status: 'ACTIVE' }, data: { status: 'EXPIRED' } });
        if (released.count !== 1) return 0;
        const rows = await tx.cryptoTransaction.updateMany({
          where: { orderId: reservation.orderId, type: 'PURCHASE', status: 'PREPARED' },
          data: { status: 'EXPIRED', failureReason: 'reservation expired' },
        });
        await tx.walletAuditEvent.create({
          data: { customerId: reservation.customerId, action: 'checkout.reservation_expired', detail: { orderId: reservation.orderId } },
        });
        return 1 + rows.count;
      });
    }

    // 3. Orphaned unsubmitted PREPARED purchase rows (no live reservation).
    const prepared = await this.prisma.cryptoTransaction.findMany({
      where: { type: 'PURCHASE', status: 'PREPARED', createdAt: { lt: new Date(now.getTime() - this.config.reservationTtlMs) } },
    });
    for (const row of prepared) {
      if (!row.orderId) continue;
      const live = await this.prisma.creditReservation.findUnique({ where: { orderId: row.orderId } });
      if (live && live.status === 'ACTIVE' && live.expiresAt >= now) continue;
      const done = await this.prisma.cryptoTransaction.updateMany({
        where: { id: row.id, status: 'PREPARED' },
        data: { status: 'EXPIRED', failureReason: 'never submitted' },
      });
      summary.expired += done.count;
    }
    return summary;
  }

  /** Records ONE manual-review audit event per payment (idempotent across reconcile runs). State is not changed. */
  private async flagManualReview(row: { customerId: string; orderId: string | null; reference: string; txSignature: string | null }): Promise<void> {
    const events = await this.prisma.walletAuditEvent.findMany({ where: { customerId: row.customerId, action: 'checkout.manual_review' } });
    const already = events.some((event) => (event.detail as { reference?: string } | null)?.reference === row.reference);
    if (already) return;
    this.logger.error(`Payment ${row.reference} landed on chain but could not be parsed unambiguously; flagged for manual review`);
    await this.prisma.walletAuditEvent.create({
      data: {
        customerId: row.customerId,
        action: 'checkout.manual_review',
        detail: {
          orderId: row.orderId,
          reference: row.reference,
          txSignature: row.txSignature,
          reason: 'transaction landed but its transfer is unparseable or ambiguous; not expired, not settled',
          manualReview: true,
        },
      },
    });
  }

  private async expireNeverLanded(row: { id: string; customerId: string; orderId: string | null; reference: string }): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const done = await tx.cryptoTransaction.updateMany({
        where: { id: row.id, status: { in: ['SUBMITTED', 'CONFIRMED'] } },
        data: { status: 'EXPIRED', failureReason: 'transaction never landed before expiry' },
      });
      if (done.count !== 1) return false;
      if (row.orderId) await tx.creditReservation.updateMany({ where: { orderId: row.orderId, status: 'ACTIVE' }, data: { status: 'EXPIRED' } });
      await tx.walletAuditEvent.create({
        data: { customerId: row.customerId, action: 'checkout.submission_expired', detail: { orderId: row.orderId, reference: row.reference } },
      });
      return true;
    });
  }
}
