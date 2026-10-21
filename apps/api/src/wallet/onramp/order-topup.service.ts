import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { requireApprovedEligibility } from '../../compliance/eligibility.gate';
import { OnRampQuote, centsToAtomic } from '../contracts';
import { resolveEligibilityRequired } from '../checkout/checkout.service';
import { KeyedLock } from '../checkout/checkout.util';
import { CreditsService } from '../credits.service';
import { WalletService } from '../wallet.service';
import type { WalletRuntimeConfig } from '../wallet.config';
import { WALLET_RUNTIME_CONFIG } from '../wallet.tokens';
import { OnRampService } from './onramp.service';

/** Optional injection token so tests and operators can supply a config object instead of reading process.env. */
export const ONRAMP_TOPUP_CONFIG = Symbol('ONRAMP_TOPUP_CONFIG');

export interface OrderTopUpConfig {
  /** Integer percent (0-100) added on top of the shortfall to absorb provider fees. */
  feeBufferPercent: number;
  /** Smallest purchase, in whole US dollars, that will be requested. */
  minUsd: number;
  /** Largest purchase, in whole US dollars. A shortfall above this is refused with 400. */
  maxUsd: number;
}

/** Upper bound for ONRAMP_MAX_USD so the cents amount always fits the OnRampIntent.intendedUsdCents Int column. */
export const ONRAMP_MAX_USD_CEILING = 1_000_000;

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d{1,9}$/.test(raw)) throw new Error(`${name} must be a whole number between ${min} and ${max} (got "${raw}")`);
  const value = Number(raw);
  if (value < min || value > max) throw new Error(`${name} must be a whole number between ${min} and ${max} (got "${raw}")`);
  return value;
}

/**
 * Strict parser for the top-up environment. Invalid values throw (the app refuses to boot) instead of being
 * silently replaced, so an operator typo can never quietly change how much a customer is asked to buy.
 */
export function loadOrderTopUpConfig(env: NodeJS.ProcessEnv = process.env): OrderTopUpConfig {
  const feeBufferPercent = readInt(env, 'ONRAMP_FEE_BUFFER_PERCENT', 0, 0, 100);
  const minUsd = readInt(env, 'ONRAMP_MIN_USD', 1, 1, ONRAMP_MAX_USD_CEILING);
  const maxUsd = readInt(env, 'ONRAMP_MAX_USD', 10_000, 1, ONRAMP_MAX_USD_CEILING);
  if (maxUsd < minUsd) throw new Error(`ONRAMP_MAX_USD (${maxUsd}) must not be below ONRAMP_MIN_USD (${minUsd})`);
  return { feeBufferPercent, minUsd, maxUsd };
}

const ATOMIC_PER_USD = 1_000_000n;

/**
 * Whole US dollars to buy for a shortfall: ceil(shortfall x (100 + buffer) / 100 / 1 USD), at least minUsd.
 * Computed once, in bigint base units, so there is no float and no double rounding. Returns a bigint so the
 * caller can compare with the cap before any narrowing to Number.
 */
export function topUpDollarsFor(shortfallAtomic: bigint, config: OrderTopUpConfig): bigint {
  if (shortfallAtomic <= 0n) throw new RangeError('shortfall must be positive');
  const buffered = shortfallAtomic * BigInt(100 + config.feeBufferPercent);
  const unit = 100n * ATOMIC_PER_USD;
  const dollars = (buffered + unit - 1n) / unit;
  const floor = BigInt(config.minUsd);
  return dollars > floor ? dollars : floor;
}

export type OrderTopUpResult =
  | { topUpNeeded: false; orderId: string; requiredAtomic: bigint; spendableAtomic: bigint }
  | {
      topUpNeeded: true;
      orderId: string;
      intentId: string;
      requiredAtomic: bigint;
      spendableAtomic: bigint;
      shortfallAtomic: bigint;
      topUpUsdCents: number;
      quote: OnRampQuote;
      status: 'CREATED' | 'PENDING';
      /** The merchant address checkout will pay (the configured treasury), so the customer sees who is paid BEFORE consenting. null when not configured. Informational: prepare is still the authority. */
      merchant: string | null;
    };

/**
 * Order-linked on-ramp: works out how much USDC a customer is missing for a pending order and opens (or re-uses)
 * an on-ramp intent for at least that amount. This service NEVER pays an order, never credits a balance and never
 * signs: funds arrive in the customer's own wallet and spendable is always read from the chain afterwards.
 */
@Injectable()
export class OrderTopUpService {
  private readonly config: OrderTopUpConfig;
  private readonly eligibilityRequired: boolean;
  private readonly locks = new KeyedLock();

  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: CreditsService,
    private readonly onRamp: OnRampService,
    private readonly wallets: WalletService,
    @Optional() @Inject(ONRAMP_TOPUP_CONFIG) config?: OrderTopUpConfig,
    @Optional() @Inject(WALLET_RUNTIME_CONFIG) private readonly runtime?: Pick<WalletRuntimeConfig, 'treasuryAddress'>,
  ) {
    this.config = config ?? loadOrderTopUpConfig();
    // Same switch, same rules as CheckoutService: enforced unless NODE_ENV is development/test and the override is set.
    this.eligibilityRequired = resolveEligibilityRequired({ ELIGIBILITY_REQUIRED: process.env.ELIGIBILITY_REQUIRED, NODE_ENV: process.env.NODE_ENV }).required;
  }

  async topUpForOrder(customerId: string, orderId: string, customerIp?: string): Promise<OrderTopUpResult> {
    // Serialize per customer so two parallel requests cannot both create an intent.
    return this.locks.run(customerId, () => this.topUpLocked(customerId, orderId, customerIp));
  }

  private async topUpLocked(customerId: string, orderId: string, customerIp?: string): Promise<OrderTopUpResult> {
    // 1. Ownership first; a missing and a foreign order are indistinguishable.
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.customerId !== customerId) throw new NotFoundException('Order not found');
    if (order.status !== 'PENDING_PAYMENT') throw new ConflictException('Order is not awaiting payment');
    if (order.currency !== 'USD') throw new BadRequestException('Only USD orders can be paid with Research Credits');

    // 2. Eligibility before any intent (and before any balance read).
    if (this.eligibilityRequired) await requireApprovedEligibility(this.prisma, customerId);

    // Same guard as CheckoutService.prepare: a payment that is in flight or final means there is nothing to top up.
    const blocking = await this.prisma.cryptoTransaction.findFirst({
      where: { orderId, type: 'PURCHASE', status: { in: ['FINALIZED', 'SUBMITTED', 'CONFIRMED'] } },
    });
    if (blocking) {
      throw new ConflictException(blocking.status === 'FINALIZED' ? 'Order already has a finalized payment' : 'A payment for this order is already in flight');
    }

    let requiredAtomic: bigint;
    try {
      requiredAtomic = centsToAtomic(order.totalCents);
    } catch {
      throw new BadRequestException('Order total is invalid');
    }

    // 3. Spendable: the SAME computation as GET /v1/wallet/balance (CreditsService.getBalance). A stale chain read
    // is a 503 here (requireSpendableAtomic), never 0 spendable.
    const { balance, spendableAtomic: reported } = await this.credits.requireSpendableAtomic(customerId);
    if (!balance.hasWallet) throw new ConflictException('Link a wallet before buying credits');
    // Mirrors CheckoutService.prepare exactly: spendable already subtracts this order's own ACTIVE reservation, so it
    // is added back (otherwise the order's own hold would be counted against itself and inflate the shortfall).
    const now = new Date();
    const own = await this.prisma.creditReservation.findUnique({ where: { orderId } });
    const ownActiveHold = own && own.status === 'ACTIVE' && own.expiresAt > now ? own.amountAtomic : 0n;
    const spendableAtomic = reported + ownActiveHold;

    // 4. Shortfall.
    const shortfallAtomic = requiredAtomic - spendableAtomic;
    if (shortfallAtomic <= 0n) return { topUpNeeded: false, orderId, requiredAtomic, spendableAtomic };

    // 5. Whole dollars, fee buffer, floor, cap.
    const dollars = topUpDollarsFor(shortfallAtomic, this.config);
    if (dollars > BigInt(this.config.maxUsd)) {
      throw new BadRequestException(`The amount needed for this order exceeds the maximum single purchase of $${this.config.maxUsd}`);
    }
    const topUpUsdCents = Number(dollars) * 100;

    // 6. Idempotency.
    const open = await this.prisma.onRampIntent.findMany({
      where: { customerId, orderId, status: { in: ['CREATED', 'PENDING'] } },
      orderBy: { createdAt: 'desc' },
    });
    for (const intent of open) {
      if (intent.intendedUsdCents !== topUpUsdCents) continue;
      const quote = await this.onRamp.requoteIntent(customerId, intent, customerIp);
      if (!quote) continue;
      await this.expire(customerId, orderId, open.filter((other) => other.id !== intent.id).map((other) => other.id));
      return this.shape({ orderId, requiredAtomic, spendableAtomic, shortfallAtomic, topUpUsdCents, intentId: intent.id, status: intent.status, quote });
    }

    // 7. New intent through the existing creation path (destination is always the customer's own linked wallet).
    const created = await this.onRamp.createIntent(customerId, { intendedUsdCents: topUpUsdCents, customerIp, orderId });
    await this.expire(customerId, orderId, open.map((other) => other.id));
    await this.wallets.audit(customerId, 'ONRAMP_ORDER_TOPUP_CREATED', {
      orderId,
      intentId: created.intentId,
      requiredAtomic: requiredAtomic.toString(),
      spendableAtomic: spendableAtomic.toString(),
      shortfallAtomic: shortfallAtomic.toString(),
      topUpUsdCents,
      expiredIntentIds: open.map((other) => other.id),
    });
    return this.shape({ orderId, requiredAtomic, spendableAtomic, shortfallAtomic, topUpUsdCents, intentId: created.intentId, status: 'CREATED', quote: created.quote });
  }

  /**
   * Marks superseded intents EXPIRED. This is local bookkeeping only: it does not cancel anything at the provider,
   * and USDC that still arrives from an old purchase is simply part of the next chain balance read.
   */
  private async expire(customerId: string, orderId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.onRampIntent.updateMany({
      where: { id: { in: ids }, customerId, orderId, status: { in: ['CREATED', 'PENDING'] } },
      data: { status: 'EXPIRED' },
    });
  }

  private shape(input: {
    orderId: string;
    requiredAtomic: bigint;
    spendableAtomic: bigint;
    shortfallAtomic: bigint;
    topUpUsdCents: number;
    intentId: string;
    status: string;
    quote: OnRampQuote;
  }): OrderTopUpResult {
    return {
      topUpNeeded: true,
      orderId: input.orderId,
      intentId: input.intentId,
      requiredAtomic: input.requiredAtomic,
      spendableAtomic: input.spendableAtomic,
      shortfallAtomic: input.shortfallAtomic,
      topUpUsdCents: input.topUpUsdCents,
      quote: input.quote,
      status: input.status === 'PENDING' ? 'PENDING' : 'CREATED',
      merchant: this.runtime?.treasuryAddress ?? null,
    };
  }
}
