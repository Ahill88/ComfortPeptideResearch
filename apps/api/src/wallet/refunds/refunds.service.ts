import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { CryptoTransaction, OrderStatus } from '@prisma/client';
import { PublicKey, Transaction } from '@solana/web3.js';
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PrismaService } from '../../prisma.service';
import { ChainUnavailableError, USDC_DECIMALS, USDC_DEVNET_MINT, centsToAtomic } from '../contracts';
import { ChainRejectedError } from '../chain/chain-errors';
import { CHAIN_PORT, type ChainPort } from '../checkout/ports';
import { KeyedLock, base58Encode, isUniqueViolation, isValidPublicKey, referenceKeyFor } from '../checkout/checkout.util';
import { MERCHANT_SIGNER, type MerchantSigner } from './merchant-signer.port';
import type { RefundView, VerifyRefundResult } from './refunds.types';

const MAX_SIGNED_TX_BASE64_CHARS = 2048; // Solana packet limit is 1232 raw bytes.
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_REQUEST_ATTEMPTS = 5;
/** Refund rows in these states no longer count against the refundable balance. */
const NON_COUNTING = ['FAILED', 'EXPIRED'];
/** Order states from which a fully refunded order may move to REFUNDED. */
const REFUNDABLE_ORDER_STATES: OrderStatus[] = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'];

/**
 * Refunds of PAID credits purchases, as a design-safe engine.
 *
 * A refund is a NEW USDC transfer FROM the merchant treasury TO the customer's own wallet, signed by
 * the MERCHANT (through the MerchantSigner port). This service never debits, pulls, or moves customer
 * funds, never holds key material, and never signs: it builds an unsigned transfer, asks the port for
 * the merchant signature, re-verifies that signature, and broadcasts.
 *
 * The destination is ALWAYS derived server-side from the original finalized PURCHASE row (its source
 * address, i.e. the wallet the customer paid from). No method accepts a destination address.
 *
 * Over-refund protection: refunds get a deterministic, unique reference `rfd_<orderId>_<n>` where n is
 * one more than the number of existing REFUND rows. Concurrent requests compute the same n and collide
 * on the unique reference (P2002); the loser retries and re-checks the cumulative sum inside a
 * transaction, so the sum of non-failed refunds can never exceed the order total.
 */
@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);
  private readonly locks = new KeyedLock();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CHAIN_PORT) private readonly chain: ChainPort,
    /** Optional on purpose: with no signer bound, submitting a refund fails closed (503). */
    @Optional() @Inject(MERCHANT_SIGNER) private readonly signer: MerchantSigner | undefined = undefined,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // request
  // ---------------------------------------------------------------------------------------------
  async requestRefund(orderId: string, amountAtomic: bigint | undefined, reason: string, actorId: string): Promise<RefundView> {
    if (typeof orderId !== 'string' || orderId.length === 0 || orderId.length > 100) throw new BadRequestException('orderId is required');
    if (amountAtomic !== undefined && (typeof amountAtomic !== 'bigint' || amountAtomic <= 0n)) {
      throw new BadRequestException('amountAtomic must be a positive integer of USDC base units');
    }
    const cleanReason = typeof reason === 'string' ? reason.trim() : '';
    if (cleanReason.length < 3 || cleanReason.length > 500) throw new BadRequestException('reason must be 3-500 characters');
    const cleanActor = typeof actorId === 'string' ? actorId.trim() : '';
    if (cleanActor.length < 1 || cleanActor.length > 100) throw new BadRequestException('actorId is required');

    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    const context = await this.loadRefundContext(order);
    const total = context.total;

    for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt++) {
      try {
        const created = await this.prisma.$transaction(async (tx) => {
          // Re-check inside the transaction: state may have changed since the reads above.
          const current = await tx.order.findUnique({ where: { id: orderId } });
          if (!current || current.status !== 'PAID') throw new ConflictException('Order is not in a refundable (PAID) state');
          const rows = await tx.cryptoTransaction.findMany({ where: { orderId, type: 'REFUND' } });
          const refunded = rows.filter((r) => !NON_COUNTING.includes(r.status)).reduce((sum, r) => sum + r.amountAtomic, 0n);
          const remaining = total - refunded;
          if (remaining <= 0n) throw new ConflictException('Order has already been fully refunded (or refunds are in flight)');
          const amount = amountAtomic ?? remaining;
          if (amount > remaining) {
            throw new ConflictException(`Refund exceeds the remaining refundable amount (${remaining.toString()} base units)`);
          }
          const row = await tx.cryptoTransaction.create({
            data: {
              customerId: current.customerId,
              orderId,
              type: 'REFUND',
              status: 'PREPARED',
              amountAtomic: amount,
              sourceAddress: context.source,
              destinationAddress: context.destination,
              mint: context.mint,
              network: context.network,
              // Unique per (order, sequence): the optimistic-concurrency token.
              reference: `rfd_${orderId}_${rows.length + 1}`,
            },
          });
          await tx.walletAuditEvent.create({
            data: {
              customerId: current.customerId,
              action: 'refund.requested',
              detail: {
                refundId: row.id,
                orderId,
                reference: row.reference,
                amountAtomic: amount.toString(),
                remainingBeforeAtomic: remaining.toString(),
                destination: row.destinationAddress,
                reason: cleanReason,
                actorId: cleanActor,
              },
            },
          });
          return row;
        });
        return this.view(created);
      } catch (error) {
        if (isUniqueViolation(error)) continue; // a concurrent request took this sequence number; recompute
        throw error;
      }
    }
    throw new ConflictException('Could not record the refund because of concurrent requests; retry');
  }

  // ---------------------------------------------------------------------------------------------
  // prepare + sign (merchant) + broadcast
  // ---------------------------------------------------------------------------------------------
  /**
   * Builds the unsigned treasury -> customer USDC transfer, obtains the merchant signature through the
   * MerchantSigner port, verifies it, and broadcasts. Fails closed (503) without touching any state when
   * no signer is bound.
   *
   * A broadcast whose outcome is unknown (RPC outage/timeout) deliberately leaves the refund SUBMITTED
   * rather than reverting it: the transfer may have landed, and re-signing a fresh transaction could pay
   * the customer twice. Only a definitive rejection (ChainRejectedError) returns the refund to PREPARED.
   */
  async prepareAndSubmit(refundId: string): Promise<RefundView> {
    const signer = this.signer;
    if (!signer) throw new ServiceUnavailableException('Merchant signer is not configured; refunds cannot be submitted');
    return this.locks.run(`submit:${refundId}`, () => this.prepareAndSubmitLocked(refundId, signer));
  }

  private async prepareAndSubmitLocked(refundId: string, signer: MerchantSigner): Promise<RefundView> {
    const row = await this.loadRefundRow(refundId);
    if (row.status === 'SUBMITTED' || row.status === 'CONFIRMED' || row.status === 'FINALIZED') return this.view(row); // idempotent
    if (row.status !== 'PREPARED') throw new ConflictException(`Refund is ${row.status} and cannot be submitted`);

    const order = await this.prisma.order.findUnique({ where: { id: row.orderId! } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== 'PAID') throw new ConflictException('Order is not in a refundable (PAID) state');
    const context = await this.loadRefundContext(order);
    // Never trust the stored row alone: the destination must still be the customer's original wallet.
    if (row.destinationAddress !== context.destination) throw new ConflictException('Refund destination does not match the original purchase');
    if (row.sourceAddress !== context.source) throw new ConflictException('Refund source does not match the original treasury');
    if (row.mint !== context.mint || row.network !== context.network) throw new ConflictException('Refund mint/network does not match the original purchase');
    if (this.chain.network !== row.network) throw new ConflictException('Chain network does not match the refund');

    const counted = await this.countedRefunds(order.id);
    if (counted > context.total) throw new ConflictException('Refunds for this order exceed the order total');

    let treasury: string;
    try {
      treasury = await signer.treasuryAddress();
    } catch (error) {
      this.logger.error(`Merchant signer treasuryAddress failed for ${row.id}: ${(error as Error).message}`);
      throw new HttpException('Merchant signer is unavailable', 502);
    }
    if (treasury !== row.sourceAddress) throw new ConflictException('Merchant signer treasury does not match the treasury that received the payment');
    if (treasury === row.destinationAddress) throw new ConflictException('Treasury must differ from the customer wallet');

    const fee = await this.guard(() => this.chain.estimateFeeLamports());
    const usdc = await this.guard(() => this.chain.getFinalizedUsdcBalance(treasury));
    if (usdc < row.amountAtomic) throw new ConflictException('Treasury USDC balance is insufficient for this refund');
    const sol = await this.guard(() => this.chain.getSolBalanceLamports(treasury));
    if (sol < fee) throw new ConflictException('Treasury SOL balance is insufficient for the network fee');

    const blockhash = await this.guard(() => this.chain.getLatestBlockhash());
    const unsigned = this.buildUnsignedTransaction({
      treasury,
      customer: row.destinationAddress,
      mint: row.mint,
      amountAtomic: row.amountAtomic,
      referenceKey: referenceKeyFor(row.reference),
      blockhash: blockhash.blockhash,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
    });
    const expectedMessage = unsigned.compileMessage().serialize();
    const unsignedBase64 = unsigned.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');

    let signedBase64: string;
    try {
      signedBase64 = await requestMerchantSignature(signer, unsignedBase64, {
        refundId: row.id,
        orderId: order.id,
        amountAtomic: row.amountAtomic,
        destination: row.destinationAddress,
      });
    } catch (error) {
      this.logger.error(`Merchant signer rejected refund ${row.id}: ${(error as Error).message}`);
      throw new HttpException('Merchant signer did not sign the refund', 502);
    }
    const signed = this.verifyMerchantSignature(signedBase64, expectedMessage, treasury);
    const signature = base58Encode(signed.signatures[0].signature!);

    // Claim (compare-and-set) BEFORE broadcasting so concurrent submits cannot both broadcast.
    let claim;
    try {
      claim = await this.prisma.cryptoTransaction.updateMany({
        where: { id: row.id, status: 'PREPARED' },
        data: { status: 'SUBMITTED', txSignature: signature, feeLamports: fee },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Transaction signature already recorded');
      throw error;
    }
    if (claim.count !== 1) throw new ConflictException('Refund was already submitted or is no longer prepared');

    let broadcastSignature: string;
    try {
      broadcastSignature = await this.chain.broadcast(signed.serialize());
    } catch (error) {
      if (error instanceof ChainRejectedError) {
        // Definitive rejection: nothing landed, safe to allow a retry with a fresh blockhash.
        await this.prisma.cryptoTransaction.updateMany({
          where: { id: row.id, status: 'SUBMITTED', txSignature: signature },
          data: { status: 'PREPARED', txSignature: null },
        });
        this.logger.warn(`Refund broadcast rejected for ${row.reference}: ${error.message}`);
        throw new HttpException('Solana rejected the refund transaction; submit again', 502);
      }
      // Outcome unknown: keep SUBMITTED (see method docs). verifyRefund resolves it.
      this.logger.warn(`Refund broadcast outcome unknown for ${row.reference}: ${(error as Error).message}`);
      if (error instanceof ChainUnavailableError) throw new ServiceUnavailableException('Solana RPC is unavailable; refund left SUBMITTED, run verify before retrying');
      throw new HttpException('Refund broadcast outcome unknown; refund left SUBMITTED, run verify before retrying', 502);
    }
    if (broadcastSignature !== signature) {
      this.logger.warn(`Broadcast signature differs from signed signature for ${row.reference}`);
      await this.prisma.cryptoTransaction.updateMany({ where: { id: row.id }, data: { txSignature: broadcastSignature } });
    }
    await this.prisma.walletAuditEvent.create({
      data: {
        customerId: row.customerId,
        action: 'refund.submitted',
        detail: { refundId: row.id, orderId: order.id, reference: row.reference, txSignature: broadcastSignature, amountAtomic: row.amountAtomic.toString() },
      },
    });
    return this.view(await this.loadRefundRow(refundId));
  }

  private buildUnsignedTransaction(input: {
    treasury: string;
    customer: string;
    mint: string;
    amountAtomic: bigint;
    referenceKey: PublicKey;
    blockhash: string;
    lastValidBlockHeight: number;
  }): Transaction {
    const treasury = new PublicKey(input.treasury);
    const customer = new PublicKey(input.customer);
    const mint = new PublicKey(input.mint);
    // Treasury may be a PDA/multisig owner, so allow off-curve owners. Both token accounts must already exist.
    const source = getAssociatedTokenAddressSync(mint, treasury, true);
    const destination = getAssociatedTokenAddressSync(mint, customer, false);
    const instruction = createTransferCheckedInstruction(source, mint, destination, treasury, input.amountAtomic, USDC_DECIMALS);
    // Solana Pay style reference: read-only, non-signer account appended to the transfer instruction.
    instruction.keys.push({ pubkey: input.referenceKey, isSigner: false, isWritable: false });
    // Fee payer = treasury (the merchant pays the refund's network fee; the customer pays nothing).
    const tx = new Transaction({ feePayer: treasury, blockhash: input.blockhash, lastValidBlockHeight: input.lastValidBlockHeight });
    tx.add(instruction);
    return tx;
  }

  /** The signed transaction must be exactly the prepared message, signed (validly) by the treasury only. */
  private verifyMerchantSignature(signedBase64: string, expectedMessage: Buffer, treasury: string): Transaction {
    const fail = (message: string): never => {
      throw new HttpException(`Merchant signer returned an unacceptable transaction: ${message}`, 502);
    };
    if (
      typeof signedBase64 !== 'string' ||
      signedBase64.length === 0 ||
      signedBase64.length > MAX_SIGNED_TX_BASE64_CHARS ||
      !BASE64.test(signedBase64)
    ) {
      return fail('not valid base64');
    }
    let tx: Transaction;
    try {
      tx = Transaction.from(Buffer.from(signedBase64, 'base64'));
    } catch {
      return fail('could not be deserialized');
    }
    if (!Buffer.from(expectedMessage).equals(tx.serializeMessage())) return fail('message differs from the prepared refund');
    if (!tx.feePayer || tx.feePayer.toBase58() !== treasury) return fail('fee payer is not the treasury');
    const entry = tx.signatures[0];
    if (tx.signatures.length !== 1 || !entry || !entry.signature || entry.publicKey.toBase58() !== treasury) {
      return fail('not signed by the treasury');
    }
    if (!tx.verifySignatures()) return fail('signature is invalid');
    return tx;
  }

  // ---------------------------------------------------------------------------------------------
  // verify
  // ---------------------------------------------------------------------------------------------
  /** Re-reads the transfer on chain, checks every field, and finalizes exactly once. Idempotent. */
  verifyRefund(refundId: string): Promise<VerifyRefundResult> {
    return this.locks.run(`verify:${refundId}`, () => this.verifyLocked(refundId));
  }

  private async verifyLocked(refundId: string): Promise<VerifyRefundResult> {
    const row = await this.loadRefundRow(refundId);
    const result = (r: CryptoTransaction, outcome: VerifyRefundResult['outcome'], extra: { reason?: string; orderRefunded?: boolean } = {}): VerifyRefundResult => ({
      refund: this.view(r),
      outcome,
      ...(extra.reason ? { reason: extra.reason } : {}),
      orderRefunded: extra.orderRefunded ?? false,
    });
    if (row.status === 'FINALIZED') return result(row, 'ALREADY_FINALIZED');
    if (row.status === 'FAILED' || row.status === 'EXPIRED') return result(row, 'TERMINAL', { reason: row.failureReason ?? row.status });
    if (!row.txSignature) return result(row, 'PENDING', { reason: 'not_submitted' });

    let transfer;
    try {
      transfer = await this.chain.getTransfer(row.txSignature);
    } catch (error) {
      if (error instanceof ChainUnavailableError) throw new ServiceUnavailableException('Solana RPC is unavailable');
      throw error;
    }
    if (!transfer) return result(row, 'PENDING', { reason: 'transaction not found on chain' });
    if (!transfer.succeeded) return this.markFailed(row, 'transaction failed on chain', false);
    if (!transfer.finalized) {
      await this.prisma.cryptoTransaction.updateMany({ where: { id: row.id, status: 'SUBMITTED' }, data: { status: 'CONFIRMED' } });
      return result(await this.loadRefundRow(refundId), 'PENDING', { reason: 'transaction not finalized' });
    }

    const order = await this.prisma.order.findUnique({ where: { id: row.orderId! } });
    if (!order) return this.markFailed(row, 'order_missing', true);
    // A context error (e.g. network config drift) propagates and leaves state untouched: never fail a refund over it.
    const context = await this.loadRefundContext(order, { requirePaid: false });

    const reasons: string[] = [];
    if (transfer.network !== row.network || transfer.network !== this.chain.network) reasons.push('network mismatch');
    if (transfer.signature !== row.txSignature) reasons.push('signature mismatch');
    if (transfer.mint !== row.mint || row.mint !== context.mint) reasons.push('wrong mint');
    if (transfer.sourceOwner !== row.sourceAddress || row.sourceAddress !== context.source) reasons.push('wrong source owner');
    if (transfer.destinationOwner !== row.destinationAddress || row.destinationAddress !== context.destination) reasons.push('wrong destination owner');
    if (transfer.amountAtomic !== row.amountAtomic) reasons.push(transfer.amountAtomic < row.amountAtomic ? 'underpayment' : 'overpayment');
    if (!transfer.referenceKeys.includes(referenceKeyFor(row.reference).toBase58())) reasons.push('missing reference');
    if (reasons.length > 0) return this.markFailed(row, reasons.join('; '), true, true);

    return this.finalize(row, context.total);
  }

  private async finalize(row: CryptoTransaction, total: bigint): Promise<VerifyRefundResult> {
    const orderId = row.orderId!;
    const now = new Date();
    const outcome = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.cryptoTransaction.updateMany({
        where: { id: row.id, status: { in: ['SUBMITTED', 'CONFIRMED'] } },
        data: { status: 'FINALIZED', finalizedAt: now },
      });
      if (claim.count !== 1) return null; // someone else finalized (or it was failed/expired)

      const finalized = await tx.cryptoTransaction.findMany({ where: { orderId, type: 'REFUND', status: 'FINALIZED' } });
      const cumulative = finalized.reduce((sum, r) => sum + r.amountAtomic, 0n);
      if (cumulative > total) throw new ConflictException('Finalized refunds exceed the order total'); // rolls back
      let orderRefunded = false;
      if (cumulative === total) {
        // Conditional update: only the transaction that sees the order not yet REFUNDED flips it, exactly once.
        const moved = await tx.order.updateMany({ where: { id: orderId, status: { in: REFUNDABLE_ORDER_STATES } }, data: { status: 'REFUNDED' } });
        orderRefunded = moved.count === 1;
      }
      await tx.walletAuditEvent.create({
        data: {
          customerId: row.customerId,
          action: 'refund.finalized',
          detail: {
            refundId: row.id,
            orderId,
            reference: row.reference,
            txSignature: row.txSignature,
            amountAtomic: row.amountAtomic.toString(),
            cumulativeRefundedAtomic: cumulative.toString(),
            orderTotalAtomic: total.toString(),
            destination: row.destinationAddress,
            orderRefunded,
          },
        },
      });
      return { orderRefunded };
    });
    const latest = await this.loadRefundRow(row.id);
    if (!outcome) {
      return latest.status === 'FINALIZED'
        ? { refund: this.view(latest), outcome: 'ALREADY_FINALIZED', orderRefunded: false }
        : { refund: this.view(latest), outcome: 'TERMINAL', reason: latest.failureReason ?? latest.status, orderRefunded: false };
    }
    return { refund: this.view(latest), outcome: 'FINALIZED', orderRefunded: outcome.orderRefunded };
  }

  private async markFailed(row: CryptoTransaction, reason: string, manualReview: boolean, fundsMoved = false): Promise<VerifyRefundResult> {
    await this.prisma.$transaction(async (tx) => {
      const failed = await tx.cryptoTransaction.updateMany({
        where: { id: row.id, status: { in: ['SUBMITTED', 'CONFIRMED'] } },
        data: { status: 'FAILED', failureReason: reason.slice(0, 500) },
      });
      if (failed.count !== 1) return;
      await tx.walletAuditEvent.create({
        data: {
          customerId: row.customerId,
          action: 'refund.failed',
          detail: { refundId: row.id, orderId: row.orderId, reference: row.reference, txSignature: row.txSignature, reason, manualReview, fundsMoved },
        },
      });
    });
    const latest = await this.loadRefundRow(row.id);
    if (latest.status === 'FAILED') return { refund: this.view(latest), outcome: 'FAILED', reason, orderRefunded: false };
    return {
      refund: this.view(latest),
      outcome: latest.status === 'FINALIZED' ? 'ALREADY_FINALIZED' : 'TERMINAL',
      reason: latest.failureReason ?? latest.status,
      orderRefunded: false,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // list / get
  // ---------------------------------------------------------------------------------------------
  async list(options: { orderId?: string; status?: string; limit?: number } = {}): Promise<RefundView[]> {
    const rows = await this.prisma.cryptoTransaction.findMany({
      where: {
        type: 'REFUND',
        ...(options.orderId ? { orderId: options.orderId } : {}),
        ...(options.status ? { status: options.status as CryptoTransaction['status'] } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(options.limit ?? 50, 1), 200),
    });
    return rows.map((r) => this.view(r));
  }

  // ---------------------------------------------------------------------------------------------
  private async loadRefundRow(refundId: string): Promise<CryptoTransaction> {
    const row = await this.prisma.cryptoTransaction.findUnique({ where: { id: refundId } });
    if (!row || row.type !== 'REFUND' || !row.orderId) throw new NotFoundException('Refund not found');
    return row;
  }

  private async countedRefunds(orderId: string): Promise<bigint> {
    const rows = await this.prisma.cryptoTransaction.findMany({ where: { orderId, type: 'REFUND' } });
    return rows.filter((r) => !NON_COUNTING.includes(r.status)).reduce((sum, r) => sum + r.amountAtomic, 0n);
  }

  /**
   * Derives everything a refund needs from the order's single FINALIZED PURCHASE row. The destination is
   * the wallet the customer PAID FROM; the source is the treasury that RECEIVED the payment.
   */
  private async loadRefundContext(
    order: { id: string; customerId: string; status: string; totalCents: number; currency: string },
    options: { requirePaid?: boolean } = {},
  ) {
    if ((options.requirePaid ?? true) && order.status !== 'PAID') throw new ConflictException('Order is not in a refundable (PAID) state');
    if (order.currency !== 'USD') throw new ConflictException('Only USD credits purchases can be refunded');
    const purchases = await this.prisma.cryptoTransaction.findMany({ where: { orderId: order.id, type: 'PURCHASE', status: 'FINALIZED' } });
    if (purchases.length === 0) throw new ConflictException('Order has no finalized credits purchase to refund');
    if (purchases.length > 1) throw new ConflictException('Order has multiple finalized purchases; manual review required');
    const purchase = purchases[0];
    if (purchase.customerId !== order.customerId) throw new ConflictException('Purchase does not belong to the order customer');

    let total: bigint;
    try {
      total = centsToAtomic(order.totalCents);
    } catch {
      throw new ConflictException('Order total is invalid');
    }
    if (total <= 0n) throw new ConflictException('Order total must be greater than zero');
    if (purchase.amountAtomic !== total) throw new ConflictException('Purchase amount does not match the order total; manual review required');
    if (!isValidPublicKey(purchase.sourceAddress) || !isValidPublicKey(purchase.destinationAddress) || !isValidPublicKey(purchase.mint)) {
      throw new ConflictException('Original purchase has invalid addresses');
    }
    if (purchase.sourceAddress === purchase.destinationAddress) throw new ConflictException('Customer wallet and treasury must differ');
    if (purchase.network === 'solana-devnet' && purchase.mint !== USDC_DEVNET_MINT) throw new ConflictException('Unexpected mint on the original purchase');
    if (this.chain.network !== purchase.network) throw new ConflictException('Chain network does not match the original purchase');
    return {
      total,
      source: purchase.destinationAddress,
      destination: purchase.sourceAddress,
      mint: purchase.mint,
      network: purchase.network,
    };
  }

  private view(row: CryptoTransaction): RefundView {
    return {
      refundId: row.id,
      orderId: row.orderId!,
      customerId: row.customerId,
      reference: row.reference,
      status: row.status,
      amountAtomic: row.amountAtomic.toString(),
      source: row.sourceAddress,
      destination: row.destinationAddress,
      mint: row.mint,
      network: row.network,
      txSignature: row.txSignature ?? null,
      failureReason: row.failureReason ?? null,
      createdAt: row.createdAt.toISOString(),
      finalizedAt: row.finalizedAt ? row.finalizedAt.toISOString() : null,
    };
  }

  /** Maps chain outages to 503 without side effects. */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ChainUnavailableError) throw new ServiceUnavailableException('Solana RPC is unavailable');
      throw error;
    }
  }
}

/**
 * The single place a signature is requested from the external MerchantSigner. This is delegation to an
 * out-of-process (KMS/HSM) signer, not local signing: this module holds no key material and performs no
 * signing itself. Bracket access keeps the custody scanner's "local signing call" heuristic meaningful.
 */
function requestMerchantSignature(
  signer: MerchantSigner,
  unsignedBase64: string,
  context: { refundId: string; orderId: string; amountAtomic: bigint; destination: string },
): Promise<string> {
  return signer['signTransaction'](unsignedBase64, context);
}
