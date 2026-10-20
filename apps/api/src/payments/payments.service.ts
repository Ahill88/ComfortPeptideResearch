import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma.service';

const PAYMENT_INTENT_TTL_MS = 15 * 60_000;
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOLANA_DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('payment-confirmation') private readonly queue: Queue,
  ) {}

  async createIntent(orderId: string, method: 'solana-usdc') {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    if (!order.researchAcknowledgedAt) {
      throw new BadRequestException('Research-use acknowledgement is required');
    }
    if (order.status !== 'PENDING_PAYMENT') {
      throw new ConflictException('Order is not awaiting payment');
    }
    const destination = this.solanaDestination();

    const existing = await this.prisma.payment.findUnique({ where: { orderId } });
    if (existing) {
      if (existing.provider !== method) {
        throw new ConflictException('Order already has a payment intent for another provider');
      }
      return this.existingIntentResponse(existing);
    }

    const amountAtomic = BigInt(order.totalCents) * 10_000n;
    const expiresAt = new Date(Date.now() + PAYMENT_INTENT_TTL_MS);
    try {
      const payment = await this.prisma.payment.create({
        data: {
          orderId,
          provider: method,
          status: 'PENDING',
          currency: 'USDC',
          amountAtomic: amountAtomic.toString(),
          walletAddress: destination,
          expiresAt,
        },
      });
      return this.intentResponse(payment);
    } catch (error) {
      // The orderId unique constraint makes concurrent intent creation idempotent.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const payment = await this.prisma.payment.findUniqueOrThrow({ where: { orderId } });
        return this.existingIntentResponse(payment);
      }
      throw error;
    }
  }

  async submitConfirmation(id: string, signature: string) {
    if (!SOLANA_SIGNATURE.test(signature)) {
      throw new BadRequestException('Invalid Solana transaction signature format');
    }
    const payment = await this.prisma.payment.findUnique({ where: { id } });
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.status !== 'PENDING') throw new ConflictException('Payment cannot accept a transaction reference');
    if (payment.expiresAt <= new Date()) {
      await this.prisma.payment.updateMany({ where: { id, status: 'PENDING', txSignature: null }, data: { status: 'EXPIRED' } });
      throw new BadRequestException('Payment intent expired');
    }
    if (payment.txSignature && payment.txSignature !== signature) {
      throw new ConflictException('A different transaction reference was already submitted');
    }

    if (!payment.txSignature) {
      try {
        const result = await this.prisma.payment.updateMany({
          where: { id, status: 'PENDING', txSignature: null },
          data: { txSignature: signature },
        });
        if (result.count === 0) throw new ConflictException('Payment confirmation changed concurrently');
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ConflictException('Transaction reference is already associated with another payment');
        }
        throw error;
      }
    }

    await this.queue.add('verify-solana-usdc', { paymentId: id, signature }, {
      // BullMQ reserves ':' in job IDs. Hashing keeps retries deterministic and valid.
      jobId: `verify-${createHash('sha256').update(`${id}:${signature}`).digest('hex')}`,
      removeOnComplete: true,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2_000 },
    });
    return { status: 'verification_pending' };
  }

  /** Disabled until an RPC verifier has checked the exact transfer attributes. */
  async recordConfirmedPayment(_: string): Promise<never> {
    throw new ServiceUnavailableException(
      'Live Solana settlement is disabled until RPC transaction verification is implemented',
    );
  }

  private intentResponse(payment: { id: string; amountAtomic: string; walletAddress: string | null; expiresAt: Date }) {
    if (!payment.walletAddress) {
      throw new ServiceUnavailableException('Payment intent has no immutable Solana destination');
    }
    return {
      paymentId: payment.id,
      network: 'solana-devnet',
      asset: 'USDC',
      mint: SOLANA_DEVNET_USDC_MINT,
      amountAtomic: payment.amountAtomic,
      recipient: payment.walletAddress,
      reference: payment.id,
      expiresAt: payment.expiresAt,
    };
  }

  private async existingIntentResponse(payment: {
    id: string;
    status: string;
    amountAtomic: string;
    walletAddress: string | null;
    expiresAt: Date;
  }) {
    if (payment.status === 'PENDING' && payment.expiresAt <= new Date()) {
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });
      throw new BadRequestException('Payment intent expired');
    }
    if (payment.status === 'EXPIRED') {
      throw new BadRequestException('Payment intent expired');
    }
    if (payment.status !== 'PENDING') {
      throw new ConflictException('Payment intent is no longer payable');
    }
    return this.intentResponse(payment);
  }

  private solanaDestination(): string {
    const destination = process.env.SOLANA_USDC_TREASURY;
    if (!destination || !SOLANA_ADDRESS.test(destination)) {
      throw new ServiceUnavailableException('A valid Solana devnet USDC destination must be configured');
    }
    return destination;
  }
}
