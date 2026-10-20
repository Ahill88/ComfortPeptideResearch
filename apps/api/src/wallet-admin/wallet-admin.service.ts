import { Injectable } from '@nestjs/common';
import { CryptoTxStatus, OnRampStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { loadFeatureFlags } from '../wallet/contracts';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './wallet-admin.dto';
import { formatUsdcExact, floorResearchCredits, serialize } from './serialize';

export const BALANCE_LABEL = 'display balance observed on chain; not a platform-held balance';

const ALL_TX_STATUSES: CryptoTxStatus[] = ['PREPARED', 'SUBMITTED', 'CONFIRMED', 'FINALIZED', 'FAILED', 'EXPIRED'];

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export function clampTake(take: number | undefined): number {
  if (take === undefined || !Number.isFinite(take)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(take)));
}

function pageArgs(take: number, cursor?: string) {
  return {
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  };
}

function toPage<T extends { id: string }>(rows: T[], take: number): Page<T> {
  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}

const NEWEST_FIRST = [{ createdAt: 'desc' }, { id: 'desc' }] as const;
const customerEmail = { select: { email: true } } as const;

/**
 * Read-only queries only. This service never writes, never calls the chain, never signs,
 * and never accepts a wallet address or amount as input.
 */
@Injectable()
export class WalletAdminService {
  constructor(private readonly prisma: PrismaService) {}

  protected now(): Date {
    return new Date();
  }

  async directory(take?: number, cursor?: string) {
    const size = clampTake(take);
    const rows = await this.prisma.customerWallet.findMany({
      ...pageArgs(size, cursor),
      orderBy: [...NEWEST_FIRST],
      select: {
        id: true,
        customerId: true,
        address: true,
        provider: true,
        network: true,
        createdAt: true,
        customer: customerEmail,
      },
    });
    const page = toPage(rows, size);
    return serialize({
      items: page.items.map(({ customer, ...wallet }) => ({ ...wallet, email: customer.email })),
      nextCursor: page.nextCursor,
    });
  }

  async balances(take?: number, cursor?: string) {
    const size = clampTake(take);
    const rows = await this.prisma.customerWallet.findMany({
      ...pageArgs(size, cursor),
      orderBy: [...NEWEST_FIRST],
      select: {
        id: true,
        customerId: true,
        address: true,
        network: true,
        customer: customerEmail,
        snapshots: {
          orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
          take: 1,
          select: { mint: true, amountAtomic: true, slot: true, observedAt: true },
        },
      },
    });
    const page = toPage(rows, size);
    return serialize({
      label: BALANCE_LABEL,
      items: page.items.map((wallet) => {
        const snapshot = wallet.snapshots[0] ?? null;
        return {
          walletId: wallet.id,
          customerId: wallet.customerId,
          email: wallet.customer.email,
          address: wallet.address,
          network: wallet.network,
          snapshot: snapshot
            ? {
                mint: snapshot.mint,
                amountAtomic: snapshot.amountAtomic,
                usdcExact: formatUsdcExact(snapshot.amountAtomic),
                researchCreditsFloor: floorResearchCredits(snapshot.amountAtomic),
                slot: snapshot.slot,
                observedAt: snapshot.observedAt,
              }
            : null,
        };
      }),
      nextCursor: page.nextCursor,
    });
  }

  async funding(take?: number, cursor?: string, status?: OnRampStatus) {
    const size = clampTake(take);
    const rows = await this.prisma.onRampIntent.findMany({
      ...pageArgs(size, cursor),
      where: status ? { status } : undefined,
      orderBy: [...NEWEST_FIRST],
      select: {
        id: true,
        customerId: true,
        provider: true,
        status: true,
        intendedUsdCents: true,
        destinationAddress: true,
        externalReference: true,
        createdAt: true,
        updatedAt: true,
        customer: customerEmail,
      },
    });
    const page = toPage(rows, size);
    return serialize({
      items: page.items.map(({ customer, ...intent }) => ({ ...intent, email: customer.email })),
      nextCursor: page.nextCursor,
    });
  }

  async paymentIntents(take?: number, paymentsCursor?: string, purchasesCursor?: string) {
    const size = clampTake(take);
    const [payments, purchases] = await Promise.all([
      this.prisma.payment.findMany({
        ...pageArgs(size, paymentsCursor),
        orderBy: [...NEWEST_FIRST],
        select: {
          id: true,
          orderId: true,
          provider: true,
          status: true,
          amountAtomic: true,
          currency: true,
          walletAddress: true,
          txSignature: true,
          expiresAt: true,
          createdAt: true,
        },
      }),
      this.prisma.cryptoTransaction.findMany({
        ...pageArgs(size, purchasesCursor),
        where: { type: 'PURCHASE' },
        orderBy: [...NEWEST_FIRST],
        select: this.transactionSelect(),
      }),
    ]);
    return serialize({
      payments: toPage(payments, size),
      cryptoPurchases: this.mapTransactions(toPage(purchases, size)),
    });
  }

  async transactions(take?: number, cursor?: string, status?: CryptoTxStatus) {
    const size = clampTake(take);
    const rows = await this.prisma.cryptoTransaction.findMany({
      ...pageArgs(size, cursor),
      where: status ? { status } : undefined,
      orderBy: [...NEWEST_FIRST],
      select: this.transactionSelect(),
    });
    return serialize(this.mapTransactions(toPage(rows, size)));
  }

  async failed(take?: number, cursor?: string) {
    const size = clampTake(take);
    const rows = await this.prisma.cryptoTransaction.findMany({
      ...pageArgs(size, cursor),
      where: { status: { in: ['FAILED', 'EXPIRED'] } },
      orderBy: [...NEWEST_FIRST],
      select: this.transactionSelect(),
    });
    return serialize(this.mapTransactions(toPage(rows, size)));
  }

  async pendingOrders(take?: number, cursor?: string) {
    const size = clampTake(take);
    const rows = await this.prisma.order.findMany({
      ...pageArgs(size, cursor),
      where: { status: 'PENDING_PAYMENT' },
      orderBy: [...NEWEST_FIRST],
      select: {
        id: true,
        customerId: true,
        status: true,
        totalCents: true,
        currency: true,
        createdAt: true,
        customer: customerEmail,
        payment: { select: { status: true, provider: true, expiresAt: true } },
        creditReservation: { select: { status: true, amountAtomic: true, expiresAt: true } },
      },
    });
    const page = toPage(rows, size);
    return serialize({
      items: page.items.map(({ customer, ...order }) => ({ ...order, email: customer.email })),
      nextCursor: page.nextCursor,
    });
  }

  /** FINALIZED PURCHASE rows aggregated per UTC day. Counts and totals are decimal strings. */
  async settlements(take?: number, cursor?: string) {
    const size = clampTake(take);
    const where = { type: 'PURCHASE', status: 'FINALIZED' } as const;
    const dayFilter = cursor ? Prisma.sql`AND to_char(COALESCE("finalizedAt", "createdAt"), 'YYYY-MM-DD') < ${cursor}` : Prisma.empty;
    const [days, totals] = await Promise.all([
      this.prisma.$queryRaw<Array<{ day: string; count: string; total_atomic: string | null }>>(Prisma.sql`
        SELECT to_char(COALESCE("finalizedAt", "createdAt"), 'YYYY-MM-DD') AS day,
               COUNT(*)::text AS count,
               COALESCE(SUM("amountAtomic"), 0)::text AS total_atomic
        FROM "CryptoTransaction"
        WHERE "type" = 'PURCHASE'::"CryptoTxType" AND "status" = 'FINALIZED'::"CryptoTxStatus" ${dayFilter}
        GROUP BY 1
        ORDER BY 1 DESC
        LIMIT ${size + 1}`),
      this.prisma.cryptoTransaction.aggregate({ where, _count: { _all: true }, _sum: { amountAtomic: true } }),
    ]);
    const hasMore = days.length > size;
    const items = (hasMore ? days.slice(0, size) : days).map((row) => ({
      day: row.day,
      count: String(row.count),
      totalAtomic: String(row.total_atomic ?? '0'),
      totalUsdcExact: formatUsdcExact(BigInt(row.total_atomic ?? '0')),
    }));
    const allTime = totals._sum.amountAtomic ?? 0n;
    return serialize({
      items,
      nextCursor: hasMore ? items[items.length - 1].day : null,
      allTime: {
        count: BigInt(totals._count._all),
        totalAtomic: allTime,
        totalUsdcExact: formatUsdcExact(allTime),
      },
    });
  }

  async reconciliation() {
    const [groups, oldest] = await Promise.all([
      this.prisma.cryptoTransaction.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.cryptoTransaction.findFirst({
        where: { status: 'SUBMITTED' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, createdAt: true, txSignature: true, type: true },
      }),
    ]);
    const counts: Record<string, number> = Object.fromEntries(ALL_TX_STATUSES.map((s) => [s, 0]));
    for (const group of groups) counts[group.status] = group._count._all;
    const ageSeconds = oldest ? Math.max(0, Math.floor((this.now().getTime() - oldest.createdAt.getTime()) / 1000)) : null;
    return serialize({
      counts,
      oldestSubmitted: oldest ? { ...oldest, ageSeconds } : null,
    });
  }

  providers() {
    const flags = loadFeatureFlags();
    const publishableKeyConfigured = typeof process.env.MOONPAY_PUBLISHABLE_KEY === 'string' && process.env.MOONPAY_PUBLISHABLE_KEY.length > 0;
    const mode = flags.enableRealMoonpay && publishableKeyConfigured ? 'real' : 'sandbox';
    const rawChainMode = process.env.WALLET_CHAIN_MODE;
    // Only a short, plain token is echoed back; anything else is reported as invalid, never raw.
    const walletChainMode = !rawChainMode ? 'unset' : /^[a-z0-9_-]{1,32}$/i.test(rawChainMode) ? rawChainMode : 'invalid';
    // Only booleans, enums and fixed strings are returned. Secret values are never read into the response.
    return {
      privy: { status: 'not configured' },
      moonpay: { mode, realRequested: flags.enableRealMoonpay, publishableKeyConfigured },
      solana: { network: flags.enableSolanaMainnet ? 'solana-mainnet' : 'solana-devnet', walletChainMode },
      featureFlags: {
        ENABLE_REAL_MOONPAY: flags.enableRealMoonpay,
        ENABLE_SOLANA_MAINNET: flags.enableSolanaMainnet,
        ENABLE_LIVE_CRYPTO_PAYMENTS: flags.enableLiveCryptoPayments,
        ENABLE_DELEGATED_PAYMENTS: flags.enableDelegatedPayments,
        ENABLE_LIVE_FULFILLMENT: flags.enableLiveFulfillment,
      },
    };
  }

  private transactionSelect() {
    return {
      id: true,
      customerId: true,
      type: true,
      status: true,
      amountAtomic: true,
      feeLamports: true,
      sourceAddress: true,
      destinationAddress: true,
      mint: true,
      network: true,
      reference: true,
      orderId: true,
      txSignature: true,
      failureReason: true,
      createdAt: true,
      finalizedAt: true,
    } as const;
  }

  private mapTransactions<T extends { id: string; amountAtomic: bigint }>(page: Page<T>) {
    return {
      items: page.items.map((tx) => ({ ...tx, usdcExact: formatUsdcExact(tx.amountAtomic) })),
      nextCursor: page.nextCursor,
    };
  }
}
