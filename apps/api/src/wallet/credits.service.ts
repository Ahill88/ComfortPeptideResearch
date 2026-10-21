import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { ChainUnavailableError, SolanaChain, computeSpendable } from './contracts';
import { usdcMintOf } from './chain/chain.types';
import { SOLANA_CHAIN } from './wallet.tokens';

export interface CreditBalance {
  hasWallet: boolean;
  walletAddress: string | null;
  network: string;
  mint: string;
  finalizedAtomic: bigint;
  pendingOutgoingAtomic: bigint;
  activeReservationsAtomic: bigint;
  spendableAtomic: bigint;
  researchCredits: bigint;
  /** True when the chain could not be read; spendable is then 0 (fail closed). */
  stale: boolean;
  asOf: Date;
  notice?: string;
}

export interface TransactionView {
  id: string;
  type: string;
  status: string;
  amountAtomic: bigint;
  feeLamports: bigint | null;
  sourceAddress: string;
  destinationAddress: string;
  mint: string;
  network: string;
  reference: string;
  orderId: string | null;
  txSignature: string | null;
  failureReason: string | null;
  createdAt: Date;
  finalizedAt: Date | null;
}

/** A new BalanceSnapshot is written when the finalized balance changed, or at least this often otherwise. */
export const SNAPSHOT_MAX_AGE_MS = 60 * 60_000;

/**
 * Research Credits are DERIVED, never issued:
 *   spendable = chain finalized USDC - in-flight outgoing - active order reservations.
 * Provider/on-ramp status is never consulted. If the chain cannot be read the result is
 * flagged stale with spendable 0; a cached higher value is never served.
 *
 * BalanceSnapshot rows are a write-only observation log for reporting (admin balances page). They are
 * never read here to compute any balance.
 */
@Injectable()
export class CreditsService {
  private readonly logger = new Logger(CreditsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SOLANA_CHAIN) private readonly chain: SolanaChain,
  ) {}

  async getBalance(customerId: string): Promise<CreditBalance> {
    const asOf = new Date();
    const mint = usdcMintOf(this.chain);
    const wallet = await this.prisma.customerWallet.findUnique({ where: { customerId } });
    const base = { network: this.chain.network, mint, asOf };
    if (!wallet) {
      return {
        ...base,
        hasWallet: false,
        walletAddress: null,
        finalizedAtomic: 0n,
        pendingOutgoingAtomic: 0n,
        activeReservationsAtomic: 0n,
        spendableAtomic: 0n,
        researchCredits: 0n,
        stale: false,
        notice: 'No wallet linked',
      };
    }

    // A wallet linked under another network (e.g. a devnet sandbox key after a switch to mainnet) is not spendable here: the same
    // address on another cluster is a different, unrelated balance. Checkout 409s on the same mismatch.
    if (wallet.network !== this.chain.network) {
      return {
        ...base,
        hasWallet: true,
        walletAddress: wallet.address,
        finalizedAtomic: 0n,
        pendingOutgoingAtomic: 0n,
        activeReservationsAtomic: 0n,
        spendableAtomic: 0n,
        researchCredits: 0n,
        stale: false,
        notice: 'Your linked wallet was linked on a different network than this deployment uses; link a wallet for this network before spending.',
      };
    }

    // Only rows of THIS chain's network count: a pending transfer or reservation made on another network (devnet rows left over
    // after a switch to mainnet, or the reverse) must never reduce, or inflate, what is spendable here.
    const pendingRows = await this.prisma.cryptoTransaction.findMany({
      where: {
        customerId,
        network: this.chain.network,
        type: { in: ['WITHDRAWAL', 'PURCHASE'] },
        status: { in: ['SUBMITTED', 'CONFIRMED'] },
      },
    });
    const reservationRows = await this.reservationsOnThisNetwork(
      customerId,
      await this.prisma.creditReservation.findMany({ where: { customerId, status: 'ACTIVE', expiresAt: { gt: asOf } } }),
    );

    let finalizedAtomic: bigint;
    let pending: typeof pendingRows;
    try {
      // ORDER MATTERS. Settle which pending transfers are already finalized BEFORE reading the balance:
      // a transfer finalized at this point is guaranteed to be reflected in the balance read below, so it
      // must not be subtracted again. Reading the balance first could exclude a transfer the balance does
      // not yet show, which would overstate spendable funds (the unsafe direction).
      pending = [];
      for (const row of pendingRows) {
        const transfer = row.txSignature ? await this.chain.getTransfer(row.txSignature) : null;
        const alreadyInBalance = !!transfer && transfer.finalized && transfer.succeeded;
        if (!alreadyInBalance) pending.push(row);
      }
      finalizedAtomic = await this.chain.getFinalizedUsdcBalance(wallet.address);
    } catch (error) {
      if (!(error instanceof ChainUnavailableError)) throw error;
      this.logger.warn(`Chain unavailable while reading balance: ${error.message}`);
      return {
        ...base,
        hasWallet: true,
        walletAddress: wallet.address,
        finalizedAtomic: 0n,
        pendingOutgoingAtomic: 0n,
        activeReservationsAtomic: 0n,
        spendableAtomic: 0n,
        researchCredits: 0n,
        stale: true,
        notice: 'Balance is temporarily unavailable; spending is disabled until the network can be read.',
      };
    }

    await this.recordSnapshot({ walletId: wallet.id, mint, amountAtomic: finalizedAtomic, observedAt: asOf });

    // An order whose payment is already submitted is held by its pending row; counting its reservation too
    // would subtract the same funds twice. Reservations only cover orders that have not yet been submitted.
    const submittedOrderIds = new Set(pendingRows.filter((row) => row.orderId).map((row) => row.orderId as string));
    const reservations = reservationRows.filter((row) => !submittedOrderIds.has(row.orderId));
    const pendingOutgoingAtomic = pending.reduce((sum, row) => sum + row.amountAtomic, 0n);
    const activeReservationsAtomic = reservations.reduce((sum, row) => sum + row.amountAtomic, 0n);
    const spendable = computeSpendable({ finalizedAtomic, pendingOutgoingAtomic, activeReservationsAtomic });
    return {
      ...base,
      hasWallet: true,
      walletAddress: wallet.address,
      finalizedAtomic,
      pendingOutgoingAtomic,
      activeReservationsAtomic,
      spendableAtomic: spendable.spendableAtomic,
      researchCredits: spendable.researchCredits,
      stale: false,
    };
  }

  /**
   * CreditReservation has no network column; a reservation belongs to the network of its order's LATEST purchase row (checkout
   * creates both together). A reservation that has no purchase row at all cannot be attributed to a network and is kept: counting
   * it can only lower spendable, which is the safe direction.
   */
  private async reservationsOnThisNetwork<T extends { orderId: string }>(customerId: string, reservations: T[]): Promise<T[]> {
    if (reservations.length === 0) return reservations;
    const purchases = await this.prisma.cryptoTransaction.findMany({
      where: { customerId, type: 'PURCHASE', orderId: { in: reservations.map((r) => r.orderId) } },
      orderBy: { createdAt: 'desc' },
    });
    const latestNetwork = new Map<string, string>();
    for (const row of purchases) if (row.orderId && !latestNetwork.has(row.orderId)) latestNetwork.set(row.orderId, row.network);
    return reservations.filter((r) => (latestNetwork.get(r.orderId) ?? this.chain.network) === this.chain.network);
  }

  /**
   * Records a reporting snapshot after a SUCCESSFUL chain read (never on stale/outage). Written only when the
   * amount differs from the wallet's latest snapshot or that snapshot is older than SNAPSHOT_MAX_AGE_MS, which
   * bounds growth. Best effort: any failure is logged and never affects the balance response. The latest
   * snapshot is read only to decide whether to write; it never feeds a balance.
   */
  private async recordSnapshot(input: { walletId: string; mint: string; amountAtomic: bigint; observedAt: Date }): Promise<void> {
    try {
      const latest = await this.prisma.balanceSnapshot.findFirst({
        where: { walletId: input.walletId, mint: input.mint },
        orderBy: { observedAt: 'desc' },
      });
      const unchanged = !!latest && latest.amountAtomic === input.amountAtomic;
      const fresh = !!latest && input.observedAt.getTime() - latest.observedAt.getTime() < SNAPSHOT_MAX_AGE_MS;
      if (unchanged && fresh) return;
      await this.prisma.balanceSnapshot.create({
        data: { walletId: input.walletId, mint: input.mint, amountAtomic: input.amountAtomic, observedAt: input.observedAt },
      });
    } catch (error) {
      this.logger.warn(`Could not record balance snapshot: ${(error as Error).message}`);
    }
  }

  /** Spendable base units, or 503 when the chain cannot be read (fail closed). */
  async requireSpendableAtomic(customerId: string): Promise<{ balance: CreditBalance; spendableAtomic: bigint }> {
    const balance = await this.getBalance(customerId);
    if (balance.stale) throw new ServiceUnavailableException('Balance is unavailable; try again shortly');
    return { balance, spendableAtomic: balance.spendableAtomic };
  }

  async listTransactions(customerId: string, limit = 100): Promise<TransactionView[]> {
    const rows = await this.prisma.cryptoTransaction.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      status: row.status,
      amountAtomic: row.amountAtomic,
      feeLamports: row.feeLamports ?? null,
      sourceAddress: row.sourceAddress,
      destinationAddress: row.destinationAddress,
      mint: row.mint,
      network: row.network,
      reference: row.reference,
      orderId: row.orderId ?? null,
      txSignature: row.txSignature ?? null,
      failureReason: row.failureReason ?? null,
      createdAt: row.createdAt,
      finalizedAt: row.finalizedAt ?? null,
    }));
  }
}
