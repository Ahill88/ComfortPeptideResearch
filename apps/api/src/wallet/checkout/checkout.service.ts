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
import { Message, PublicKey, Transaction } from '@solana/web3.js';
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma.service';
import { requireApprovedEligibility } from '../../compliance/eligibility.gate';
import { isNonProductionRuntime } from '../../config/runtime';
import { ChainRejectedError } from '../chain/chain-errors';
import { ChainUnavailableError, USDC_DECIMALS, USDC_DEVNET_MINT, centsToAtomic } from '../contracts';
import {
  BALANCE_PORT,
  CHAIN_PORT,
  CHECKOUT_CONFIG,
  PREPARED_MESSAGE_STORE,
  WALLET_FLAGS,
  WALLET_LOOKUP_PORT,
  type BalancePort,
  type ChainPort,
  type CheckoutConfig,
  type PreparedMessage,
  type PreparedMessageStore,
  type WalletFlagsPort,
  type WalletLookupPort,
} from './ports';
import {
  KeyedLock,
  base58Encode,
  formatCents,
  formatLamportsAsSol,
  isUniqueViolation,
  isValidPublicKey,
  referenceKeyFor,
} from './checkout.util';
import type { PrepareResult, StatusResult, SubmitResult, VerifyResult } from './checkout.types';
import { VerificationService } from './verification.service';

const MAX_SIGNED_TX_BASE64_CHARS = 2048; // Solana packet limit is 1232 raw bytes.
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Whether the eligibility gate is enforced. ENFORCED BY DEFAULT. ELIGIBILITY_REQUIRED=false disables it ONLY when
 * NODE_ENV is exactly "development" or "test" (local demos); in any other runtime (production, staging, unset,
 * "Production", ...) the override is ignored, the gate stays on, and a warning is returned for the startup log.
 */
export function resolveEligibilityRequired(env: { ELIGIBILITY_REQUIRED?: string; NODE_ENV?: string }): { required: boolean; warning?: string } {
  const requested = env.ELIGIBILITY_REQUIRED?.trim().toLowerCase();
  if (requested !== 'false') return { required: true };
  if (isNonProductionRuntime(env)) {
    return { required: false, warning: `ELIGIBILITY_REQUIRED=false: the customer eligibility gate is DISABLED (NODE_ENV=${env.NODE_ENV}). Never do this outside local development.` };
  }
  return {
    required: true,
    warning: `ELIGIBILITY_REQUIRED=false is IGNORED because NODE_ENV is ${JSON.stringify(env.NODE_ENV ?? null)} (only "development" or "test" may disable it); the eligibility gate stays ENFORCED.`,
  };
}

/**
 * Customer-authorized USDC checkout ("Pay with Research Credits").
 *
 * Research Credits are a derived display of spendable USDC; there is NO separate credit deduction.
 * Spendable only goes down when the customer-signed USDC transfer finalizes on chain (see
 * VerificationService). This service NEVER signs, holds keys, or builds a signed transaction:
 * it builds an unsigned transaction and later requires the customer's own valid signature.
 *
 * "Live" means Solana mainnet. Devnet/sandbox chains are allowed without enableLiveCryptoPayments.
 */
@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);
  private readonly locks = new KeyedLock();
  /** Coalesces concurrent verifications of the same payment so status polling cannot multiply RPC calls. */
  private readonly verifying = new Map<string, Promise<VerifyResult>>();
  /** Resolved once at construction (i.e. at application startup) so the warning is visible in the boot log. */
  private readonly eligibilityRequired: boolean;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CHAIN_PORT) private readonly chain: ChainPort,
    @Inject(BALANCE_PORT) private readonly balances: BalancePort,
    @Inject(WALLET_LOOKUP_PORT) private readonly wallets: WalletLookupPort,
    @Inject(WALLET_FLAGS) private readonly flags: WalletFlagsPort,
    @Inject(PREPARED_MESSAGE_STORE) private readonly store: PreparedMessageStore,
    @Inject(CHECKOUT_CONFIG) private readonly config: CheckoutConfig,
    /**
     * Enables pull-driven settlement (post-broadcast kick and status refresh). Optional (note the default:
     * the seven required constructor parameters are unchanged) so the service still works standalone;
     * ReconciliationService remains the safety net either way.
     */
    @Optional() @Inject(VerificationService) private readonly verification: VerificationService | undefined = undefined,
  ) {
    const eligibility = resolveEligibilityRequired({ ELIGIBILITY_REQUIRED: process.env.ELIGIBILITY_REQUIRED, NODE_ENV: process.env.NODE_ENV });
    this.eligibilityRequired = eligibility.required;
    if (eligibility.warning) this.logger.warn(eligibility.warning);
  }

  /** 403 unless the customer's eligibility is APPROVED (see resolveEligibilityRequired for the dev/test override). */
  private async assertEligible(customerId: string): Promise<void> {
    if (!this.eligibilityRequired) return;
    await requireApprovedEligibility(this.prisma, customerId);
  }

  /** Resolves a customer id from an email (used by the controller's dev identity header). */
  async findCustomerIdByEmail(email: string): Promise<string | null> {
    const customer = await this.prisma.customer.findUnique({ where: { email: email.trim().toLowerCase() } });
    return customer?.id ?? null;
  }

  // ---------------------------------------------------------------------------------------------
  // prepare
  // ---------------------------------------------------------------------------------------------
  async prepare(customerId: string, orderId: string): Promise<PrepareResult> {
    // Eligibility first: nothing (reservation, transaction, RPC call) happens for an unapproved customer.
    await this.assertEligible(customerId);
    // In-process serialization per customer prevents concurrent prepares from over-reserving.
    // Cross-process idempotency is enforced by the unique CreditReservation.orderId (P2002 handled).
    return this.locks.run(customerId, () => this.prepareLocked(customerId, orderId));
  }

  private async prepareLocked(customerId: string, orderId: string): Promise<PrepareResult> {
    const order = await this.loadOwnedOrder(customerId, orderId);
    if (order.status !== 'PENDING_PAYMENT') throw new ConflictException('Order is not awaiting payment');
    if (!order.researchAcknowledgedAt) throw new BadRequestException('Research-use acknowledgement is required');
    if (order.currency !== 'USD') throw new BadRequestException('Only USD orders can be paid with Research Credits');

    const blocking = await this.prisma.cryptoTransaction.findFirst({
      where: { orderId, type: 'PURCHASE', status: { in: ['FINALIZED', 'SUBMITTED', 'CONFIRMED'] } },
    });
    if (blocking) {
      throw new ConflictException(
        blocking.status === 'FINALIZED' ? 'Order already has a finalized payment' : 'A payment for this order is already in flight',
      );
    }

    const network = this.chain.network;
    const flags = this.flags;
    if (network === 'solana-mainnet') {
      if (!flags.enableSolanaMainnet) throw new ConflictException('Solana mainnet is disabled');
      // "Live" == mainnet. Devnet/sandbox does not require enableLiveCryptoPayments.
      if (!flags.enableLiveCryptoPayments) throw new ConflictException('Live crypto payments are disabled');
    } else if (network !== 'solana-devnet') {
      throw new ConflictException('Unsupported Solana network');
    }
    const mint = network === 'solana-devnet' ? USDC_DEVNET_MINT : this.config.mainnetUsdcMint;
    if (!mint || !isValidPublicKey(mint)) throw new ConflictException('USDC mint is not configured for this network');

    const wallet = await this.wallets.getWallet(customerId);
    if (!wallet || !isValidPublicKey(wallet.address)) throw new ConflictException('Customer has no valid wallet');
    if (wallet.network && wallet.network !== network) throw new ConflictException('Customer wallet network does not match the chain');

    const merchant = this.config.treasury;
    if (!merchant || !isValidPublicKey(merchant)) throw new ServiceUnavailableException('Merchant treasury is not configured');
    if (merchant === wallet.address) throw new ConflictException('Merchant treasury must differ from the customer wallet');

    let amountAtomic: bigint;
    try {
      amountAtomic = centsToAtomic(order.totalCents);
    } catch {
      throw new BadRequestException('Order total is invalid');
    }
    if (amountAtomic <= 0n) throw new BadRequestException('Order total must be greater than zero');

    const now = new Date();
    const existing = await this.prisma.creditReservation.findUnique({ where: { orderId } });
    if (existing?.status === 'CONSUMED') throw new ConflictException('Order already has a finalized payment');
    const ownActiveHold = existing && existing.status === 'ACTIVE' && existing.expiresAt > now ? existing.amountAtomic : 0n;

    const fee = await this.guard(() => this.chain.estimateFeeLamports());
    const balance = await this.guard(() => this.balances.getSpendable(customerId));
    if (balance.stale) throw new ServiceUnavailableException('Balance is stale; cannot authorize a purchase right now');
    // Spendable already subtracts this order's own ACTIVE reservation, so add it back for idempotent re-prepare.
    if (balance.spendableAtomic + ownActiveHold < amountAtomic) {
      throw new HttpException('Insufficient Research Credits for this order', 402);
    }
    const sol = await this.guard(() => this.chain.getSolBalanceLamports(wallet.address));
    if (sol < fee) throw new HttpException('Insufficient SOL in the customer wallet for the network fee', 402);

    const { reservation, row } = await this.ensureReservation({
      customerId,
      orderId,
      amountAtomic,
      mint,
      network,
      payer: wallet.address,
      merchant,
      now,
    });

    const reference = row.reference;
    const referenceKey = referenceKeyFor(reference);
    let stored = await this.store.get(reference);
    const reusable = stored && now.getTime() - stored.createdAtMs < this.config.messageReuseMs;
    let unsigned: Transaction;
    if (reusable && stored) {
      unsigned = Transaction.populate(Message.from(stored.messageBytes));
    } else {
      const blockhash = await this.guard(() => this.chain.getLatestBlockhash());
      unsigned = this.buildUnsignedTransaction({
        payer: wallet.address,
        merchant,
        mint,
        amountAtomic,
        referenceKey,
        blockhash: blockhash.blockhash,
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
      });
      stored = {
        reference,
        orderId,
        customerId,
        payer: wallet.address,
        merchant,
        mint,
        amountAtomic,
        referenceKey: referenceKey.toBase58(),
        feeLamports: fee,
        messageBytes: new Uint8Array(unsigned.compileMessage().serialize()),
        createdAtMs: now.getTime(),
      } satisfies PreparedMessage;
      await this.store.put(stored);
      await this.prisma.cryptoTransaction.updateMany({ where: { id: row.id, status: 'PREPARED' }, data: { feeLamports: fee } });
    }

    const unsignedBytes = unsigned.serialize({ requireAllSignatures: false, verifySignatures: false });
    const feeLamports = stored!.feeLamports;
    const amountUsd = formatCents(order.totalCents);
    return {
      paymentReference: reference,
      amountAtomic: amountAtomic.toString(),
      amountUsd,
      merchant,
      network,
      mint,
      feeLamports: feeLamports.toString(),
      unsignedTransactionBase64: Buffer.from(unsignedBytes).toString('base64'),
      expiresAt: reservation.expiresAt.toISOString(),
      disclosures: [
        `Price: ${amountUsd} USD, charged as exactly ${amountAtomic.toString()} USDC base units (${USDC_DECIMALS} decimals).`,
        `Estimated network fee: about ${formatLamportsAsSol(feeLamports)} SOL (${feeLamports.toString()} lamports), paid in SOL by your own wallet, not by Research Credits.`,
        'Authorization is by your own signature: nothing is sent unless your wallet signs this exact transaction. The platform never holds or uses your private keys.',
        'Credits are not deducted separately. Your Research Credits reduce only when the USDC transfer is finalized on Solana.',
        `This purchase is held for you until ${reservation.expiresAt.toISOString()}; after that you must prepare it again.`,
      ],
    };
  }

  private buildUnsignedTransaction(input: {
    payer: string;
    merchant: string;
    mint: string;
    amountAtomic: bigint;
    referenceKey: PublicKey;
    blockhash: string;
    lastValidBlockHeight: number;
  }): Transaction {
    const payer = new PublicKey(input.payer);
    const mint = new PublicKey(input.mint);
    const merchant = new PublicKey(input.merchant);
    const source = getAssociatedTokenAddressSync(mint, payer, false);
    // Treasury may be a PDA/multisig owner, so allow off-curve owners. The treasury ATA must already exist.
    const destination = getAssociatedTokenAddressSync(mint, merchant, true);
    const instruction = createTransferCheckedInstruction(source, mint, destination, payer, input.amountAtomic, USDC_DECIMALS);
    // Solana Pay style reference: read-only, non-signer account appended to the transfer instruction.
    instruction.keys.push({ pubkey: input.referenceKey, isSigner: false, isWritable: false });
    const tx = new Transaction({ feePayer: payer, blockhash: input.blockhash, lastValidBlockHeight: input.lastValidBlockHeight });
    tx.add(instruction);
    return tx;
  }

  /**
   * Creates (or reuses) the unique-per-order reservation and its PREPARED purchase row.
   * Reservation + purchase row are created atomically; a P2002 on CreditReservation.orderId means a
   * concurrent prepare won and we adopt its rows.
   */
  private async ensureReservation(input: {
    customerId: string;
    orderId: string;
    amountAtomic: bigint;
    mint: string;
    network: string;
    payer: string;
    merchant: string;
    now: Date;
  }) {
    const { customerId, orderId, amountAtomic, now } = input;
    const expiresAt = new Date(now.getTime() + this.config.reservationTtlMs);
    const newRow = () => ({
      customerId,
      orderId,
      type: 'PURCHASE' as const,
      status: 'PREPARED' as const,
      amountAtomic,
      sourceAddress: input.payer,
      destinationAddress: input.merchant,
      mint: input.mint,
      network: input.network,
      reference: `chk_${randomBytes(16).toString('hex')}`,
    });

    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.prisma.creditReservation.findUnique({ where: { orderId } });
      if (!current) {
        try {
          return await this.prisma.$transaction(async (tx) => {
            const reservation = await tx.creditReservation.create({
              data: { customerId, orderId, amountAtomic, status: 'ACTIVE', expiresAt },
            });
            const row = await tx.cryptoTransaction.create({ data: newRow() });
            await tx.walletAuditEvent.create({
              data: { customerId, action: 'checkout.prepared', detail: { orderId, reference: row.reference, amountAtomic: amountAtomic.toString() } },
            });
            return { reservation, row };
          });
        } catch (error) {
          if (isUniqueViolation(error)) continue; // concurrent prepare won; adopt its rows
          throw error;
        }
      }

      if (current.status === 'CONSUMED') throw new ConflictException('Order already has a finalized payment');
      if (current.amountAtomic !== amountAtomic) throw new ConflictException('Existing reservation does not match the order total');

      if (current.status === 'ACTIVE' && current.expiresAt > now) {
        const row = await this.prisma.cryptoTransaction.findFirst({ where: { orderId, type: 'PURCHASE', status: 'PREPARED' } });
        if (row && row.sourceAddress === input.payer && row.destinationAddress === input.merchant && row.mint === input.mint && row.network === input.network) {
          return { reservation: current, row };
        }
        // No usable prepared row (or wallet/treasury changed): retire any and issue a new reference.
        return this.prisma.$transaction(async (tx) => {
          await tx.cryptoTransaction.updateMany({ where: { orderId, type: 'PURCHASE', status: 'PREPARED' }, data: { status: 'EXPIRED', failureReason: 'superseded' } });
          const created = await tx.cryptoTransaction.create({ data: newRow() });
          return { reservation: current, row: created };
        });
      }

      // Expired/released/ACTIVE-but-past-expiry reservation: revive conditionally (compare-and-set).
      const revived = await this.prisma.$transaction(async (tx) => {
        const claim = await tx.creditReservation.updateMany({
          where: { id: current.id, status: current.status },
          data: { status: 'ACTIVE', expiresAt },
        });
        if (claim.count !== 1) return null;
        await tx.cryptoTransaction.updateMany({ where: { orderId, type: 'PURCHASE', status: 'PREPARED' }, data: { status: 'EXPIRED', failureReason: 'superseded' } });
        const row = await tx.cryptoTransaction.create({ data: newRow() });
        await tx.walletAuditEvent.create({
          data: { customerId, action: 'checkout.prepared', detail: { orderId, reference: row.reference, amountAtomic: amountAtomic.toString(), revived: true } },
        });
        return { reservation: { ...current, status: 'ACTIVE' as const, expiresAt }, row };
      });
      if (revived) return revived;
    }
    throw new ConflictException('Could not reserve credits for this order; retry');
  }

  // ---------------------------------------------------------------------------------------------
  // submit
  // ---------------------------------------------------------------------------------------------
  async submit(customerId: string, orderId: string, signedTransactionBase64: string): Promise<SubmitResult> {
    // Approval may have been revoked since prepare: re-check before anything is decoded, claimed or broadcast.
    await this.assertEligible(customerId);
    if (
      typeof signedTransactionBase64 !== 'string' ||
      signedTransactionBase64.length === 0 ||
      signedTransactionBase64.length > MAX_SIGNED_TX_BASE64_CHARS ||
      !BASE64.test(signedTransactionBase64)
    ) {
      throw new BadRequestException('signedTransactionBase64 is not valid base64');
    }
    let tx: Transaction;
    try {
      tx = Transaction.from(Buffer.from(signedTransactionBase64, 'base64'));
    } catch {
      throw new BadRequestException('Transaction could not be deserialized');
    }
    const firstSignature = tx.signatures[0]?.signature;
    const incomingSignature = firstSignature ? base58Encode(firstSignature) : null;

    const order = await this.loadOwnedOrder(customerId, orderId);
    const rows = await this.prisma.cryptoTransaction.findMany({ where: { orderId, type: 'PURCHASE' }, orderBy: { createdAt: 'desc' } });
    const inflight = rows.find((r) => r.status === 'SUBMITTED' || r.status === 'CONFIRMED' || r.status === 'FINALIZED');
    if (inflight) {
      if (inflight.txSignature && incomingSignature && inflight.txSignature === incomingSignature) {
        // Identical payload: idempotent. Never re-broadcast here; just nudge settlement (covers an unknown-outcome submit).
        this.kickSettlement(inflight.reference);
        return {
          paymentReference: inflight.reference,
          txSignature: inflight.txSignature,
          status: inflight.status as SubmitResult['status'],
          idempotent: true,
        };
      }
      throw new ConflictException('A different transaction was already submitted for this order');
    }
    if (order.status !== 'PENDING_PAYMENT') throw new ConflictException('Order is not awaiting payment');

    const row = rows.find((r) => r.status === 'PREPARED');
    if (!row) throw new ConflictException('No prepared payment for this order; call prepare first');
    const reservation = await this.prisma.creditReservation.findUnique({ where: { orderId } });
    if (!reservation || reservation.status !== 'ACTIVE') throw new ConflictException('Reservation is no longer active; prepare again');
    if (reservation.expiresAt <= new Date()) throw new ConflictException('Reservation expired; prepare again');

    const expected = await this.store.get(row.reference);
    if (!expected) throw new ConflictException('Prepared transaction is no longer available; prepare again');

    const wallet = await this.wallets.getWallet(customerId);
    if (!wallet || wallet.address !== expected.payer || row.sourceAddress !== expected.payer) {
      throw new ConflictException('Customer wallet changed since prepare; prepare again');
    }

    // 1. The message must be byte-for-byte what we prepared (amount, destination, reference, mint, payer).
    const actualMessage = tx.serializeMessage();
    if (!Buffer.from(expected.messageBytes).equals(actualMessage)) {
      throw new BadRequestException('Transaction does not match the prepared payment');
    }
    // 2. The customer's own valid signature over exactly that message is mandatory.
    if (!tx.feePayer || tx.feePayer.toBase58() !== wallet.address) {
      throw new BadRequestException('Fee payer is not the customer wallet');
    }
    const signer = tx.signatures[0];
    if (!signer || !signer.signature || signer.publicKey.toBase58() !== wallet.address || !incomingSignature) {
      throw new BadRequestException('Transaction is not signed by the customer wallet');
    }
    if (tx.signatures.length !== 1 || !tx.verifySignatures()) {
      throw new BadRequestException('Transaction signature is invalid');
    }

    // Re-check right before the claim: the awaits above are a window in which approval could be revoked.
    await this.assertEligible(customerId);

    // 3. Claim (compare-and-set) before broadcasting so concurrent submits cannot both broadcast.
    let claim;
    try {
      claim = await this.prisma.cryptoTransaction.updateMany({
        where: { id: row.id, status: 'PREPARED' },
        data: { status: 'SUBMITTED', txSignature: incomingSignature },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Transaction signature already recorded');
      throw error;
    }
    if (claim.count !== 1) throw new ConflictException('Payment was already submitted or is no longer prepared');

    let broadcastSignature: string;
    try {
      // Always the canonical re-serialization (never forwarded raw client bytes).
      broadcastSignature = await this.chain.broadcast(tx.serialize());
    } catch (error) {
      if (error instanceof ChainRejectedError) {
        // The ONLY definitive outcome: the cluster refused the transaction, so it can never land. Safe to re-prepare.
        await this.prisma.cryptoTransaction.updateMany({
          where: { id: row.id, status: 'SUBMITTED', txSignature: incomingSignature },
          data: { status: 'PREPARED', txSignature: null },
        });
        this.logger.warn(`Broadcast rejected for ${row.reference}: ${error.message}`);
        throw new HttpException('Solana rejected the transaction; prepare again', 502);
      }
      // Timeout / RPC outage / anything else: the cluster MAY have accepted the transaction. Keep SUBMITTED with the
      // signature (funds stay held, re-prepare is blocked, so the customer cannot pay twice). Retrying the identical
      // payload is idempotent; verification/reconciliation settles it, or expires it once it can no longer land.
      this.logger.warn(`Broadcast outcome unknown for ${row.reference}: ${(error as Error).message}`);
      await this.prisma.walletAuditEvent
        .create({ data: { customerId, action: 'checkout.submit_outcome_unknown', detail: { orderId, reference: row.reference, txSignature: incomingSignature } } })
        .catch((auditError: unknown) => this.logger.error(`Could not audit unknown broadcast outcome for ${row.reference}: ${(auditError as Error).message}`));
      if (error instanceof ChainUnavailableError) {
        throw new ServiceUnavailableException(
          'Solana RPC is unavailable; the payment may or may not have been sent. Do not pay again: retry submitting the same signed transaction or check the order status.',
        );
      }
      throw error;
    }
    if (broadcastSignature !== incomingSignature) {
      this.logger.warn(`Broadcast signature differs from signed signature for ${row.reference}`);
      await this.prisma.cryptoTransaction.updateMany({ where: { id: row.id }, data: { txSignature: broadcastSignature } });
    }
    await this.prisma.walletAuditEvent.create({
      data: { customerId, action: 'checkout.submitted', detail: { orderId, reference: row.reference, txSignature: broadcastSignature } },
    });
    // Best-effort, non-blocking: settle promptly instead of waiting for the reconciliation scheduler.
    this.kickSettlement(row.reference);
    return { paymentReference: row.reference, txSignature: broadcastSignature, status: 'SUBMITTED', idempotent: false };
  }

  /**
   * Fire-and-forget verifyAndSettle. Runs only after a successful broadcast; never throws, never awaited by
   * the caller, so it can neither fail nor delay the submit response. verifyAndSettle re-verifies everything
   * on chain and settles exactly once, so an early/duplicate kick is harmless.
   */
  private kickSettlement(reference: string): void {
    if (!this.verification) return;
    void this.verifyOnce(reference).catch((error) => {
      this.logger.warn(`Post-submit settlement attempt failed for ${reference}: ${(error as Error).message}`);
    });
  }

  private verifyOnce(reference: string): Promise<VerifyResult> {
    const running = this.verifying.get(reference);
    if (running) return running;
    // Promise.resolve().then(...) also converts a synchronous throw into a rejection.
    const attempt = Promise.resolve()
      .then(() => this.verification!.verifyAndSettle({ paymentReference: reference }))
      .finally(() => this.verifying.delete(reference));
    this.verifying.set(reference, attempt);
    return attempt;
  }

  // ---------------------------------------------------------------------------------------------
  // status
  // ---------------------------------------------------------------------------------------------
  /**
   * Returns the checkout status. If the order's purchase is in flight (SUBMITTED/CONFIRMED) this first asks
   * VerificationService to verify and settle it (pull-driven settlement), then returns the fresh state.
   * The refresh is best effort: an RPC outage (or any refresh error) leaves state untouched and the
   * pre-existing state is returned with 200; status never answers 503 because of an RPC blip.
   */
  async status(customerId: string, orderId: string): Promise<StatusResult> {
    // Ownership is enforced before anything can be triggered: a foreign/missing order is a 404.
    await this.loadOwnedOrder(customerId, orderId);
    if (this.verification) {
      const inflight = await this.prisma.cryptoTransaction.findFirst({
        where: { orderId, type: 'PURCHASE', status: { in: ['SUBMITTED', 'CONFIRMED'] } },
      });
      if (inflight) await this.refreshInflight(inflight.reference);
    }
    return this.readStatus(customerId, orderId);
  }

  private async refreshInflight(reference: string): Promise<void> {
    try {
      await this.verifyOnce(reference);
    } catch (error) {
      if (error instanceof ServiceUnavailableException || error instanceof ChainUnavailableError) {
        this.logger.warn(`Status refresh skipped for ${reference}: Solana RPC unavailable`);
      } else {
        this.logger.error(`Status refresh failed for ${reference}: ${(error as Error).message}`);
      }
    }
  }

  private async readStatus(customerId: string, orderId: string): Promise<StatusResult> {
    const order = await this.loadOwnedOrder(customerId, orderId);
    const rows = await this.prisma.cryptoTransaction.findMany({ where: { orderId, type: 'PURCHASE' }, orderBy: { createdAt: 'desc' } });
    const row = rows.find((r) => r.status === 'FINALIZED') ?? rows[0] ?? null;
    const reservation = await this.prisma.creditReservation.findUnique({ where: { orderId } });
    return {
      orderId,
      orderStatus: order.status,
      payment: row
        ? {
            paymentReference: row.reference,
            status: row.status,
            amountAtomic: row.amountAtomic.toString(),
            txSignature: row.txSignature ?? null,
            failureReason: row.failureReason ?? null,
            finalizedAt: row.finalizedAt ? row.finalizedAt.toISOString() : null,
          }
        : null,
      reservation: reservation
        ? { status: reservation.status, amountAtomic: reservation.amountAtomic.toString(), expiresAt: reservation.expiresAt.toISOString() }
        : null,
    };
  }

  // ---------------------------------------------------------------------------------------------
  private async loadOwnedOrder(customerId: string, orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    // Same response for missing and foreign orders to avoid order-id enumeration.
    if (!order || order.customerId !== customerId) throw new NotFoundException('Order not found');
    return order;
  }

  /** Maps chain/balance outages to 503 without side effects. */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ChainUnavailableError) throw new ServiceUnavailableException('Solana RPC is unavailable');
      throw error;
    }
  }
}
