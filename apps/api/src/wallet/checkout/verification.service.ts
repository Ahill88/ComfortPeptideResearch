import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { ChainUnavailableError, USDC_DEVNET_MINT, centsToAtomic } from '../contracts';
import {
  CHAIN_PORT,
  FULFILLMENT_PORT,
  WALLET_FLAGS,
  type ChainPort,
  type FulfillmentTrigger,
  type WalletFlagsPort,
} from './ports';
import { referenceKeyFor } from './checkout.util';
import type { SettlementRecord, VerifyResult } from './checkout.types';

/**
 * Structural brand check for the chain adapter's "landed but ambiguous/unparseable transfer" error
 * (AmbiguousTransferError in chain/devnet-solana-chain.ts). Checkout never imports adapter files, so the
 * error is recognised by its `ambiguousTransfer` brand. It extends ChainUnavailableError, so an unaware caller
 * still fails closed.
 */
export function isAmbiguousTransferError(error: unknown): error is ChainUnavailableError & { ambiguousTransfer: true } {
  return error instanceof ChainUnavailableError && (error as { ambiguousTransfer?: unknown }).ambiguousTransfer === true;
}

/**
 * Reason carried by a PENDING result when the transaction landed but cannot be read unambiguously. The row stays
 * SUBMITTED (funds stay held, the order cannot be re-prepared and paid twice); ReconciliationService flags it for
 * manual review. It deliberately has no `pendingKind`, so it can never be mistaken for "not_found" and expired.
 */
export const AMBIGUOUS_TRANSFER_REASON = 'ambiguous_transfer_manual_review';

class OrderNotPayableError extends Error {
  constructor(readonly orderStatus: string | null) {
    super(`order_not_payable:${orderStatus ?? 'missing'}`);
  }
}

/**
 * Verifies a customer-signed USDC transfer on chain and settles the order exactly once.
 *
 * Nothing here trusts the client: the transfer is re-read via chain.getTransfer and every field is
 * compared with the values persisted at prepare time (and the order total). Settlement is a single
 * prisma transaction guarded by conditional updateMany calls so duplicates/races settle once.
 * Credits are never debited here: spendable falls only because the finalized chain balance fell.
 */
@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CHAIN_PORT) private readonly chain: ChainPort,
    @Inject(WALLET_FLAGS) private readonly flags: WalletFlagsPort,
    @Inject(FULFILLMENT_PORT) private readonly fulfillment: FulfillmentTrigger,
  ) {}

  async verifyAndSettle(input: { paymentReference?: string; signature?: string }): Promise<VerifyResult> {
    const row = input.paymentReference
      ? await this.prisma.cryptoTransaction.findUnique({ where: { reference: input.paymentReference } })
      : input.signature
        ? await this.prisma.cryptoTransaction.findUnique({ where: { txSignature: input.signature } })
        : null;
    if (!row || row.type !== 'PURCHASE' || !row.orderId) return { outcome: 'UNKNOWN', reason: 'no matching purchase' };

    const base = { paymentReference: row.reference, orderId: row.orderId };
    if (row.status === 'FINALIZED') return { ...base, outcome: 'ALREADY_FINALIZED' };
    if (row.status === 'FAILED' || row.status === 'EXPIRED') return { ...base, outcome: 'TERMINAL', reason: row.failureReason ?? row.status };
    if (!row.txSignature) return { ...base, outcome: 'PENDING', reason: 'not_submitted' };

    let transfer;
    try {
      transfer = await this.chain.getTransfer(row.txSignature);
    } catch (error) {
      // Landed but unreadable: never fail, expire or settle on it. Leave everything untouched; reconcile flags it.
      if (isAmbiguousTransferError(error)) {
        this.logger.error(`Transfer for ${row.reference} is ambiguous and needs manual review: ${error.message}`);
        return { ...base, outcome: 'PENDING', reason: AMBIGUOUS_TRANSFER_REASON };
      }
      // Outage: leave all state untouched.
      if (error instanceof ChainUnavailableError) throw new ServiceUnavailableException('Solana RPC is unavailable');
      throw error;
    }
    if (!transfer) return { ...base, outcome: 'PENDING', pendingKind: 'not_found', reason: 'transaction not found on chain' };

    if (!transfer.succeeded) {
      // A landed failed transaction can never succeed later, so this is terminal.
      return this.markFailed(row, 'transaction failed on chain', false);
    }
    if (!transfer.finalized) {
      // "confirmed" is not enough: wait for finalized.
      await this.prisma.cryptoTransaction.updateMany({ where: { id: row.id, status: 'SUBMITTED' }, data: { status: 'CONFIRMED' } });
      return { ...base, outcome: 'PENDING', pendingKind: 'not_finalized', reason: 'transaction not finalized' };
    }

    const order = await this.prisma.order.findUnique({ where: { id: row.orderId } });
    if (!order) return this.markFailed(row, 'order_missing', true);
    const expectedAmount = centsToAtomic(order.totalCents);

    const reasons: string[] = [];
    if (transfer.network !== row.network || transfer.network !== this.chain.network) reasons.push('network mismatch');
    if (transfer.signature !== row.txSignature) reasons.push('signature mismatch');
    if (transfer.mint !== row.mint || row.mint !== this.expectedMint(row.network)) reasons.push('wrong mint');
    if (transfer.sourceOwner !== row.sourceAddress) reasons.push('wrong source owner');
    if (transfer.destinationOwner !== row.destinationAddress) reasons.push('wrong destination owner');
    if (row.amountAtomic !== expectedAmount) reasons.push('order total changed since prepare');
    if (transfer.amountAtomic < expectedAmount) reasons.push('underpayment');
    else if (transfer.amountAtomic > expectedAmount) reasons.push('overpayment');
    if (!transfer.referenceKeys.includes(referenceKeyFor(row.reference).toBase58())) reasons.push('missing reference');
    if (reasons.length > 0) return this.markFailed(row, reasons.join('; '), true);

    return this.settle(row, expectedAmount);
  }

  private expectedMint(network: string): string | undefined {
    return network === 'solana-devnet' ? USDC_DEVNET_MINT : undefined;
  }

  private async settle(row: PurchaseRow, expectedAmount: bigint): Promise<VerifyResult> {
    const orderId = row.orderId!;
    const base = { paymentReference: row.reference, orderId };
    const fulfillmentLive = this.flags.enableLiveFulfillment === true;
    const now = new Date();

    let settledNow: boolean;
    try {
      settledNow = await this.prisma.$transaction(async (tx) => {
        const finalized = await tx.cryptoTransaction.updateMany({
          where: { id: row.id, status: { in: ['SUBMITTED', 'CONFIRMED'] } },
          data: { status: 'FINALIZED', finalizedAt: now },
        });
        if (finalized.count !== 1) return false; // someone else settled (or it was failed/expired)

        const paid = await tx.order.updateMany({ where: { id: orderId, status: 'PENDING_PAYMENT' }, data: { status: 'PAID' } });
        if (paid.count !== 1) {
          const current = await tx.order.findUnique({ where: { id: orderId } });
          throw new OrderNotPayableError(current?.status ?? null); // rolls back the FINALIZED update
        }
        await tx.creditReservation.updateMany({ where: { orderId, status: { not: 'CONSUMED' } }, data: { status: 'CONSUMED' } });
        await tx.walletAuditEvent.create({
          data: {
            customerId: row.customerId,
            action: 'checkout.settled',
            detail: {
              orderId,
              reference: row.reference,
              txSignature: row.txSignature,
              amountAtomic: expectedAmount.toString(),
              mint: row.mint,
              merchant: row.destinationAddress,
              fulfillment: fulfillmentLive ? 'TRIGGER_REQUESTED' : 'HELD_BY_FLAG',
            },
          },
        });
        return true;
      });
    } catch (error) {
      if (error instanceof OrderNotPayableError) {
        // Funds moved but the order cannot be marked paid: flag for manual refund, never silently settle.
        return this.markFailed(row, `${error.message}; manual refund required`, true);
      }
      throw error;
    }

    if (!settledNow) {
      const latest = await this.prisma.cryptoTransaction.findUnique({ where: { id: row.id } });
      return latest?.status === 'FINALIZED' ? { ...base, outcome: 'ALREADY_FINALIZED' } : { ...base, outcome: 'TERMINAL', reason: latest?.failureReason ?? latest?.status };
    }

    // Fulfillment gate: only the single winning settle reaches here.
    if (fulfillmentLive) {
      try {
        await this.fulfillment.trigger({
          orderId,
          customerId: row.customerId,
          paymentReference: row.reference,
          txSignature: row.txSignature!,
        });
      } catch (error) {
        // Payment is final; never roll it back. Record so operators can retry fulfillment.
        this.logger.error(`Fulfillment trigger failed for order ${orderId}: ${(error as Error).message}`);
        await this.prisma.walletAuditEvent.create({
          data: { customerId: row.customerId, action: 'checkout.fulfillment_trigger_failed', detail: { orderId, message: (error as Error).message } },
        });
      }
    } else {
      this.logger.log(`Order ${orderId} paid; fulfillment held (ENABLE_LIVE_FULFILLMENT is false)`);
    }
    return { ...base, outcome: 'FINALIZED', settledNow: true };
  }

  private async markFailed(row: PurchaseRow, reason: string, manualReview: boolean): Promise<VerifyResult> {
    const orderId = row.orderId!;
    await this.prisma.$transaction(async (tx) => {
      const failed = await tx.cryptoTransaction.updateMany({
        where: { id: row.id, status: { in: ['SUBMITTED', 'CONFIRMED'] } },
        data: { status: 'FAILED', failureReason: reason.slice(0, 500) },
      });
      if (failed.count !== 1) return;
      await tx.creditReservation.updateMany({ where: { orderId, status: 'ACTIVE' }, data: { status: 'RELEASED' } });
      await tx.walletAuditEvent.create({
        data: {
          customerId: row.customerId,
          action: 'checkout.verification_failed',
          detail: { orderId, reference: row.reference, txSignature: row.txSignature, reason, manualReview },
        },
      });
    });
    return { paymentReference: row.reference, orderId, outcome: 'FAILED', reason };
  }

  /** Merchant settlement records, derived from FINALIZED PURCHASE rows (no dedicated table). */
  async listSettlements(options: { customerId?: string; limit?: number } = {}): Promise<SettlementRecord[]> {
    const rows = await this.prisma.cryptoTransaction.findMany({
      where: { type: 'PURCHASE', status: 'FINALIZED', ...(options.customerId ? { customerId: options.customerId } : {}) },
      orderBy: { finalizedAt: 'desc' },
      take: Math.min(Math.max(options.limit ?? 100, 1), 500),
    });
    return rows
      .filter((r) => r.orderId && r.txSignature)
      .map((r) => ({
        orderId: r.orderId!,
        customerId: r.customerId,
        paymentReference: r.reference,
        txSignature: r.txSignature!,
        amountAtomic: r.amountAtomic,
        mint: r.mint,
        network: r.network,
        sourceAddress: r.sourceAddress,
        merchant: r.destinationAddress,
        finalizedAt: r.finalizedAt,
      }));
  }
}

type PurchaseRow = {
  id: string;
  customerId: string;
  orderId: string | null;
  reference: string;
  txSignature: string | null;
  mint: string;
  network: string;
  sourceAddress: string;
  destinationAddress: string;
  amountAtomic: bigint;
};
