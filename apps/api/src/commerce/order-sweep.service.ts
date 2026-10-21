import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { COMMERCE_CONFIG, type CommerceConfig } from './commerce.config';
import { InventoryService } from './inventory.service';

export interface SweepSummary {
  examined: number;
  cancelled: number;
  /** Not cancelled because a payment is in flight or settled (or the order changed under us). */
  skipped: number;
}

const PAGE = 100;
const MAX_PER_RUN = 1000;
/** Purchase states that mean money may be moving or has moved: the order must be left to settlement/reconciliation. */
const IN_FLIGHT = ['SUBMITTED', 'CONFIRMED', 'FINALIZED'] as const;

class SweepSkip extends Error {}

/**
 * Cancels unpaid orders whose hold has run out and returns their stock, each order in ONE transaction:
 *   1. conditional flip PENDING_PAYMENT -> CANCELLED (only while expiresAt < now): the row lock serialises against every other
 *      sweeper, an admin cancel and settlement (which also does PENDING_PAYMENT -> PAID conditionally);
 *   2. refuse (roll the flip back) if a purchase for the order is SUBMITTED/CONFIRMED/FINALIZED, or PREPARED with a still-live
 *      credit reservation: a customer-signed payment may be on its way and must be settled or expired by reconciliation first;
 *   3. retire the order's leftover PREPARED purchase and ACTIVE reservation, then re-check step 2 once more (a submit that won
 *      the claim race between the first check and the retirement is seen here);
 *   4. release the stock, write the OrderEvent.
 * Safe to run on any number of instances at once and repeatedly.
 */
@Injectable()
export class OrderSweepService {
  private readonly logger = new Logger(OrderSweepService.name);

  constructor(private readonly prisma: PrismaService, private readonly inventory: InventoryService) {}

  async sweep(now: Date = new Date()): Promise<SweepSummary> {
    const summary: SweepSummary = { examined: 0, cancelled: 0, skipped: 0 };
    let after: string | undefined;
    while (summary.examined < MAX_PER_RUN) {
      const page = await this.prisma.order.findMany({
        where: { status: 'PENDING_PAYMENT', expiresAt: { lt: now }, ...(after ? { id: { gt: after } } : {}) },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: PAGE,
      });
      if (!page.length) break;
      for (const { id } of page) {
        summary.examined += 1;
        try {
          if (await this.sweepOne(id, now)) summary.cancelled += 1;
          else summary.skipped += 1;
        } catch (error) {
          summary.skipped += 1;
          this.logger.error(`order.sweep.failed orderId=${id} error=${error instanceof Error ? error.message : 'unknown'}`);
        }
      }
      after = page[page.length - 1].id;
      if (page.length < PAGE) break;
    }
    return summary;
  }

  /** True when this call cancelled the order. */
  async sweepOne(orderId: string, now: Date): Promise<boolean> {
    try {
      await this.prisma.$transaction(
        async (tx) => {
          const flipped = await tx.order.updateMany({ where: { id: orderId, status: 'PENDING_PAYMENT', expiresAt: { lt: now } }, data: { status: 'CANCELLED' } });
          if (flipped.count !== 1) throw new SweepSkip();

          const rows = await tx.cryptoTransaction.findMany({ where: { orderId, type: 'PURCHASE', status: { in: [...IN_FLIGHT, 'PREPARED'] } }, select: { status: true } });
          if (rows.some((row) => (IN_FLIGHT as readonly string[]).includes(row.status))) throw new SweepSkip();
          if (rows.length) {
            const reservation = await tx.creditReservation.findUnique({ where: { orderId }, select: { status: true, expiresAt: true } });
            if (reservation && reservation.status === 'ACTIVE' && reservation.expiresAt > now) throw new SweepSkip();
          }

          await tx.cryptoTransaction.updateMany({ where: { orderId, type: 'PURCHASE', status: 'PREPARED' }, data: { status: 'EXPIRED', failureReason: 'order expired unpaid' } });
          await tx.creditReservation.updateMany({ where: { orderId, status: 'ACTIVE' }, data: { status: 'RELEASED' } });
          const late = await tx.cryptoTransaction.findFirst({ where: { orderId, type: 'PURCHASE', status: { in: [...IN_FLIGHT] } }, select: { id: true } });
          if (late) throw new SweepSkip();

          await this.inventory.releaseForOrder(tx, orderId, 'Order expired unpaid');
          await tx.orderEvent.create({ data: { orderId, kind: 'STATUS', fromStatus: 'PENDING_PAYMENT', toStatus: 'CANCELLED', note: 'Expired unpaid', adminId: null } });
        },
        { maxWait: 15_000, timeout: 30_000 },
      );
    } catch (error) {
      if (error instanceof SweepSkip) return false;
      throw error;
    }
    // Audit-style line: ids and statuses only, no customer data.
    this.logger.log(`order.sweep.cancelled orderId=${orderId} from=PENDING_PAYMENT to=CANCELLED reason=expired_unpaid`);
    return true;
  }
}

/** Runs the sweep on an interval. ORDER_SWEEP_INTERVAL_MS=0 disables it on this instance (another instance can still run it). */
@Injectable()
export class OrderSweepScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrderSweepScheduler.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly sweeper: OrderSweepService, @Inject(COMMERCE_CONFIG) private readonly config: CommerceConfig) {}

  onModuleInit(): void {
    if (this.config.sweepIntervalMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), this.config.sweepIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<SweepSummary | null> {
    if (this.running) return null; // never overlap runs on one instance
    this.running = true;
    try {
      const summary = await this.sweeper.sweep();
      if (summary.examined) this.logger.log(`order.sweep ${JSON.stringify(summary)}`);
      return summary;
    } catch (error) {
      this.logger.warn(`order.sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    } finally {
      this.running = false;
    }
  }
}
