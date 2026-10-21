import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { PublicKey, Transaction } from '@solana/web3.js';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma.service';
import { CHAIN_READINESS_PORT, type ChainReadinessPort } from '../checkout/ports';
import { ChainUnavailableError, SolanaChain, USDC_DECIMALS, type WalletFeatureFlags } from '../contracts';
import { base58Encode } from '../chain/base58';
import { ChainRejectedError } from '../chain/chain-errors';
import { TOKEN_ACCOUNT_RENT_LAMPORTS, WalletChain, usdcMintOf } from '../chain/chain.types';
import { CreditsService } from '../credits.service';
import { parseDestinationAddress, WalletService } from '../wallet.service';
import { COMPLIANCE_SCREEN, PREPARED_TX_STORE, SOLANA_CHAIN, WALLET_FEATURE_FLAGS } from '../wallet.tokens';
import { ComplianceScreen, refuseIfSanctioned } from './compliance-screen';
import { PreparedTransactionStore } from './prepared-transaction.store';

export const PREPARED_TTL_MS = 5 * 60_000;
/** After this long without being found on chain, an unconfirmed submission can no longer land (blockhash expired). */
export const UNCONFIRMED_EXPIRY_MS = 15 * 60_000;
const U64_MAX = (1n << 64n) - 1n;
const MAX_TX_BYTES = 1232;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface PrepareTransferInput {
  destination: unknown;
  amountAtomic?: unknown;
  max?: unknown;
}

export interface PreparedTransfer {
  transactionId: string;
  reference: string;
  /** Base64 legacy transaction with an empty signature slot for the customer. The platform never signs. */
  unsignedTransaction: string;
  signer: string;
  destination: string;
  amountAtomic: bigint;
  mint: string;
  decimals: number;
  fee: {
    networkFeeLamports: bigint;
    destinationAccountCreation: { required: boolean; rentLamports: bigint };
    estimatedTotalLamports: bigint;
  };
  expiresAt: Date;
  warnings: string[];
}

export interface TransferView {
  id: string;
  status: string;
  amountAtomic: bigint;
  destination: string;
  txSignature: string | null;
  failureReason: string | null;
}

/** Parses a base-unit amount: digits only, positive, within u64. Accepts bigint for internal callers. */
export function parseAtomicAmount(value: unknown): bigint {
  let amount: bigint;
  if (typeof value === 'bigint') amount = value;
  else if (typeof value === 'string' && /^\d{1,20}$/.test(value)) amount = BigInt(value);
  else throw new BadRequestException('amountAtomic must be a string of digits (USDC base units)');
  if (amount <= 0n) throw new BadRequestException('Amount must be greater than zero');
  if (amount > U64_MAX) throw new BadRequestException('Amount exceeds the maximum token amount');
  return amount;
}

@Injectable()
export class TransfersService {
  private readonly logger = new Logger(TransfersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: CreditsService,
    private readonly wallets: WalletService,
    @Inject(SOLANA_CHAIN) private readonly chain: SolanaChain,
    @Inject(PREPARED_TX_STORE) private readonly store: PreparedTransactionStore,
    @Inject(COMPLIANCE_SCREEN) private readonly compliance: ComplianceScreen,
    /**
     * Optional so older call sites still construct, but fail closed: with no flags a MAINNET chain refuses every transfer.
     * Devnet/sandbox never need them.
     */
    @Optional() @Inject(WALLET_FEATURE_FLAGS) private readonly flags: WalletFeatureFlags | undefined = undefined,
    /** Optional: the boot-time chain preflight; bound and not ready means transfers are refused with 503. */
    @Optional() @Inject(CHAIN_READINESS_PORT) private readonly readiness: ChainReadinessPort | undefined = undefined,
  ) {}

  /**
   * External USDC sends on mainnet are real money: they need BOTH ENABLE_SOLANA_MAINNET and ENABLE_LIVE_CRYPTO_PAYMENTS (the
   * mainnet flag alone only lets the adapter exist), and the chain preflight must have passed. Runs on prepare AND submit.
   */
  private assertTransfersAllowed(): void {
    if (this.chain.network === 'solana-mainnet') {
      if (!this.flags?.enableSolanaMainnet) throw new ConflictException('Solana mainnet is disabled');
      if (!this.flags.enableLiveCryptoPayments) throw new ConflictException('Live crypto payments are disabled');
    } else if (this.chain.network !== 'solana-devnet') {
      throw new ConflictException('Unsupported Solana network');
    }
    if (this.readiness && !this.readiness.isReady()) {
      this.logger.error(`Transfers refused: chain preflight has not passed (${this.readiness.reason()})`);
      throw new ServiceUnavailableException('Transfers are temporarily unavailable: the Solana network check has not passed');
    }
  }

  /** Builds an UNSIGNED legacy transaction for the customer's wallet to sign. Nothing is signed or sent here. */
  async prepare(customerId: string, input: PrepareTransferInput): Promise<PreparedTransfer> {
    this.assertTransfersAllowed();
    const wallet = await this.prisma.customerWallet.findUnique({ where: { customerId } });
    if (!wallet) throw new ConflictException('Link a wallet before sending');
    const destination = parseDestinationAddress(input.destination);
    const mint = usdcMintOf(this.chain);
    if (destination.toBase58() === wallet.address) throw new BadRequestException('Destination must differ from your own wallet');
    if (destination.toBase58() === mint) throw new BadRequestException('Destination cannot be the USDC mint address');

    const wantsMax = input.max === true;
    if (wantsMax && input.amountAtomic !== undefined && input.amountAtomic !== null) {
      throw new BadRequestException('Provide either amountAtomic or max, not both');
    }
    if (!wantsMax && (input.amountAtomic === undefined || input.amountAtomic === null)) {
      throw new BadRequestException('amountAtomic or max:true is required');
    }
    const requested = wantsMax ? null : parseAtomicAmount(input.amountAtomic);

    const { spendableAtomic } = await this.credits.requireSpendableAtomic(customerId);
    const amount = requested ?? spendableAtomic;
    if (amount <= 0n) throw new BadRequestException('Insufficient spendable balance');
    if (amount > spendableAtomic) throw new BadRequestException('Insufficient spendable balance');

    const verdict = await this.compliance.screen({
      customerId,
      sourceAddress: wallet.address,
      destinationAddress: destination.toBase58(),
      amountAtomic: amount,
      mint,
      surface: 'transfer',
    });
    await refuseIfSanctioned(verdict, 'transfer', (action, detail) => this.wallets.audit(customerId, action, detail));
    if (!verdict.allowed) {
      await this.wallets.audit(customerId, 'WITHDRAWAL_SCREENING_BLOCKED', { destination: destination.toBase58(), reason: verdict.reason ?? null });
      throw new ForbiddenException('This transfer cannot be processed');
    }

    const owner = new PublicKey(wallet.address);
    const mintKey = new PublicKey(mint);
    const sourceAta = getAssociatedTokenAddressSync(mintKey, owner, true);
    const destinationAta = getAssociatedTokenAddressSync(mintKey, destination, true);

    let blockhash: { blockhash: string; lastValidBlockHeight: number };
    let networkFee: bigint;
    let solBalance: bigint;
    let accountExists: boolean | null = null;
    let rent = TOKEN_ACCOUNT_RENT_LAMPORTS;
    try {
      blockhash = await this.chain.getLatestBlockhash();
      networkFee = await this.chain.estimateFeeLamports();
      solBalance = await this.chain.getSolBalanceLamports(wallet.address);
      const capable = this.chain as Partial<WalletChain>;
      if (capable.usdcAccountExists) accountExists = await capable.usdcAccountExists(destination.toBase58());
      if (capable.tokenAccountRentLamports) rent = await capable.tokenAccountRentLamports();
    } catch (error) {
      if (error instanceof ChainUnavailableError) throw new ServiceUnavailableException('Solana network is unavailable; try again shortly');
      throw error;
    }
    // If we cannot tell, include the idempotent create (a no-op when the account exists) and disclose it as possible.
    const createsAccount = accountExists !== true;

    const tx = new Transaction({ feePayer: owner, blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight });
    if (createsAccount) {
      tx.add(createAssociatedTokenAccountIdempotentInstruction(owner, destinationAta, destination, mintKey));
    }
    tx.add(createTransferCheckedInstruction(sourceAta, mintKey, destinationAta, owner, amount, USDC_DECIMALS));
    const messageBytes = new Uint8Array(tx.compileMessage().serialize());
    const unsigned = tx.serialize({ requireAllSignatures: false, verifySignatures: false });

    const reference = `wd_${randomUUID()}`;
    const expiresAt = new Date(Date.now() + PREPARED_TTL_MS);
    const row = await this.prisma.cryptoTransaction.create({
      data: {
        customerId,
        type: 'WITHDRAWAL',
        status: 'PREPARED',
        amountAtomic: amount,
        feeLamports: networkFee,
        sourceAddress: wallet.address,
        destinationAddress: destination.toBase58(),
        mint,
        network: this.chain.network,
        reference,
      },
    });
    try {
      await this.store.save({ transactionId: row.id, customerId, messageBytes, expiresAt });
    } catch (error) {
      await this.prisma.cryptoTransaction.update({ where: { id: row.id }, data: { status: 'FAILED', failureReason: 'prepared message could not be stored' } });
      throw error;
    }
    await this.wallets.audit(customerId, 'WITHDRAWAL_PREPARED', {
      transactionId: row.id,
      destination: destination.toBase58(),
      amountAtomic: amount.toString(),
    });

    const warnings = [
      'Blockchain transfers are irreversible. Once sent, USDC cannot be recalled by us or anyone else.',
      'Verify the destination address carefully. Sending to a wrong or unsupported address permanently loses the funds.',
      `Network fees are paid in SOL from your own wallet (about ${networkFee} lamports). Your wallet must hold enough SOL or the transfer will fail.`,
    ];
    if (createsAccount) {
      warnings.push(
        accountExists === false
          ? `The recipient has no USDC account yet. Creating it costs about ${rent} lamports of SOL rent, paid by you.`
          : `If the recipient has no USDC account yet, creating it costs about ${rent} lamports of SOL rent, paid by you.`,
      );
    }
    if (!PublicKey.isOnCurve(destination.toBytes())) {
      warnings.push('The destination is not a standard wallet address (it may be a program-controlled account). Make sure it can receive and move USDC.');
    }
    const estimatedTotal = networkFee + (createsAccount ? rent : 0n);
    if (solBalance < estimatedTotal) {
      warnings.push(`Your wallet holds ${solBalance} lamports of SOL, which is below the ~${estimatedTotal} lamports this transfer may require.`);
    }

    return {
      transactionId: row.id,
      reference,
      unsignedTransaction: Buffer.from(unsigned).toString('base64'),
      signer: wallet.address,
      destination: destination.toBase58(),
      amountAtomic: amount,
      mint,
      decimals: USDC_DECIMALS,
      fee: {
        networkFeeLamports: networkFee,
        destinationAccountCreation: { required: createsAccount, rentLamports: createsAccount ? rent : 0n },
        estimatedTotalLamports: estimatedTotal,
      },
      expiresAt,
      warnings,
    };
  }

  /**
   * Broadcasts a transaction the CUSTOMER signed. Requires a valid signature from the customer's
   * wallet over exactly the prepared message. The platform has no signing code path.
   */
  async submit(customerId: string, transactionId: string, signedTransactionBase64: unknown): Promise<TransferView> {
    this.assertTransfersAllowed();
    const row = await this.prisma.cryptoTransaction.findUnique({ where: { id: transactionId } });
    if (!row || row.customerId !== customerId || row.type !== 'WITHDRAWAL') throw new NotFoundException('Transfer not found');

    const bytes = this.decodeBase64(signedTransactionBase64);
    let tx: Transaction;
    try {
      tx = Transaction.from(bytes);
    } catch {
      throw new BadRequestException('Signed transaction could not be decoded');
    }
    const signatureBytes = tx.signature;
    const signature = signatureBytes ? base58Encode(signatureBytes) : null;

    if (row.status !== 'PREPARED') {
      // Duplicate submission: identical payload (same signature) returns the same result.
      if (signature && row.txSignature === signature) return this.view(row);
      throw new ConflictException('This transfer was already submitted with a different transaction');
    }

    const wallet = await this.prisma.customerWallet.findUnique({ where: { customerId } });
    if (!wallet) throw new ConflictException('Link a wallet before sending');
    const owner = new PublicKey(wallet.address);

    const record = await this.store.get(transactionId);
    if (!record || record.customerId !== customerId || record.expiresAt.getTime() < Date.now()) {
      if (record) await this.store.delete(transactionId);
      await this.prisma.cryptoTransaction.updateMany({ where: { id: transactionId, status: 'PREPARED' }, data: { status: 'EXPIRED', failureReason: 'prepared transaction expired' } });
      throw new ConflictException('Prepared transaction expired or is unavailable; prepare the transfer again');
    }

    // 1) exactly the prepared message, signed by exactly the customer's wallet.
    if (bytes.length > MAX_TX_BYTES) throw new BadRequestException('Transaction is too large');
    if (!tx.feePayer || !tx.feePayer.equals(owner)) throw new BadRequestException('Fee payer must be your wallet');
    const message = Buffer.from(tx.compileMessage().serialize());
    if (!message.equals(Buffer.from(record.messageBytes))) {
      throw new BadRequestException('Signed transaction does not match the prepared transaction');
    }
    if (tx.signatures.length !== 1 || !tx.signatures[0].publicKey.equals(owner)) {
      throw new BadRequestException('Transaction must be signed by your wallet only');
    }
    if (!tx.signatures[0].signature) throw new BadRequestException('Transaction is not signed');
    if (!tx.verifySignatures()) throw new BadRequestException('Signature is not valid for this transaction and wallet');

    // 2) funds still available (balances may have changed since prepare).
    const { spendableAtomic } = await this.credits.requireSpendableAtomic(customerId);
    if (row.amountAtomic > spendableAtomic) throw new BadRequestException('Insufficient spendable balance');

    // 3) claim before broadcasting so concurrent submits cannot double-send. txSignature is unique.
    try {
      const claimed = await this.prisma.cryptoTransaction.updateMany({
        where: { id: transactionId, status: 'PREPARED' },
        data: { status: 'SUBMITTED', txSignature: signature },
      });
      if (claimed.count !== 1) {
        const latest = await this.prisma.cryptoTransaction.findUnique({ where: { id: transactionId } });
        if (latest && latest.txSignature === signature) return this.view(latest);
        throw new ConflictException('This transfer was already submitted');
      }
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new ConflictException('This signed transaction was already used');
      throw error;
    }
    await this.store.delete(transactionId);

    try {
      // Canonical serialization of the verified transaction, never the raw client bytes (which may carry trailing
      // bytes or a non-minimal shortvec encoding that decoded fine but must not be forwarded).
      await this.chain.broadcast(tx.serialize());
    } catch (error) {
      if (error instanceof ChainRejectedError) {
        await this.prisma.cryptoTransaction.update({
          where: { id: transactionId },
          data: { status: 'FAILED', failureReason: `network rejected: ${error.message}`.slice(0, 200) },
        });
        throw new BadRequestException(`The network rejected the transaction: ${error.message}`.slice(0, 240));
      }
      if (error instanceof ChainUnavailableError) {
        // Unknown whether it propagated; keep SUBMITTED (counts as pending) and let reconciliation decide.
        this.logger.warn(`Broadcast outcome unknown for ${transactionId}: ${error.message}`);
        throw new ServiceUnavailableException('Network unavailable; the transfer may or may not have been sent. Check your transactions before retrying.');
      }
      throw error;
    }
    await this.wallets.audit(customerId, 'WITHDRAWAL_SUBMITTED', { transactionId, signature });
    const latest = await this.prisma.cryptoTransaction.findUnique({ where: { id: transactionId } });
    return this.view(latest ?? row);
  }

  /**
   * Syncs in-flight and stale rows with the chain. A row becomes FINALIZED only when
   * chain.getTransfer reports a finalized, successful transfer matching what was prepared.
   */
  async reconcile(customerId: string): Promise<void> {
    const rows = await this.prisma.cryptoTransaction.findMany({
      where: { customerId, type: 'WITHDRAWAL', status: { in: ['PREPARED', 'SUBMITTED', 'CONFIRMED'] } },
    });
    for (const row of rows) {
      try {
        await this.refreshOne(row);
      } catch (error) {
        if ((error as { ambiguousTransfer?: unknown } | null)?.ambiguousTransfer === true) {
          // Landed but unreadable (not an outage): leave the row SUBMITTED, never expire or settle it, and keep going.
          this.logger.error(`Withdrawal ${row.id} landed on chain but its transfer is ambiguous; needs manual review: ${(error as Error).message}`);
          continue;
        }
        if (error instanceof ChainUnavailableError) return;
        this.logger.warn(`Reconcile failed for ${row.id}: ${(error as Error).message}`);
      }
    }
  }

  private async refreshOne<T extends RowLike>(row: T): Promise<T> {
    const age = Date.now() - row.createdAt.getTime();
    if (row.status === 'PREPARED') {
      if (age > PREPARED_TTL_MS) {
        await this.prisma.cryptoTransaction.updateMany({ where: { id: row.id, status: 'PREPARED' }, data: { status: 'EXPIRED', failureReason: 'prepared transaction expired' } });
        await this.store.delete(row.id);
        return { ...row, status: 'EXPIRED', failureReason: 'prepared transaction expired' };
      }
      return row;
    }
    if ((row.status !== 'SUBMITTED' && row.status !== 'CONFIRMED') || !row.txSignature) return row;

    const transfer = await this.chain.getTransfer(row.txSignature);
    if (!transfer) {
      if (age > UNCONFIRMED_EXPIRY_MS) {
        await this.prisma.cryptoTransaction.updateMany({
          where: { id: row.id, status: { in: ['SUBMITTED', 'CONFIRMED'] } },
          data: { status: 'EXPIRED', failureReason: 'not found on chain after blockhash expiry' },
        });
        return { ...row, status: 'EXPIRED', failureReason: 'not found on chain after blockhash expiry' };
      }
      return row;
    }
    const matches =
      transfer.destinationOwner === row.destinationAddress &&
      transfer.sourceOwner === row.sourceAddress &&
      transfer.amountAtomic === row.amountAtomic &&
      transfer.mint === row.mint;
    if (!matches) {
      this.logger.error(`On-chain transfer ${row.txSignature} does not match prepared transfer ${row.id}`);
      return row;
    }
    if (transfer.finalized && transfer.succeeded) {
      const finalizedAt = new Date();
      await this.prisma.cryptoTransaction.updateMany({ where: { id: row.id, status: { in: ['SUBMITTED', 'CONFIRMED'] } }, data: { status: 'FINALIZED', finalizedAt } });
      return { ...row, status: 'FINALIZED', finalizedAt };
    }
    if (transfer.finalized && !transfer.succeeded) {
      await this.prisma.cryptoTransaction.updateMany({ where: { id: row.id, status: { in: ['SUBMITTED', 'CONFIRMED'] } }, data: { status: 'FAILED', failureReason: 'transaction failed on chain' } });
      return { ...row, status: 'FAILED', failureReason: 'transaction failed on chain' };
    }
    if (transfer.succeeded && row.status === 'SUBMITTED') {
      await this.prisma.cryptoTransaction.updateMany({ where: { id: row.id, status: 'SUBMITTED' }, data: { status: 'CONFIRMED' } });
      return { ...row, status: 'CONFIRMED' };
    }
    return row;
  }

  private decodeBase64(value: unknown): Buffer {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4 * MAX_TX_BYTES || !BASE64.test(value) || value.length % 4 !== 0) {
      throw new BadRequestException('signedTransaction must be a base64 string');
    }
    return Buffer.from(value, 'base64');
  }

  private view(row: RowLike): TransferView {
    return {
      id: row.id,
      status: row.status,
      amountAtomic: row.amountAtomic,
      destination: row.destinationAddress,
      txSignature: row.txSignature ?? null,
      failureReason: row.failureReason ?? null,
    };
  }
}

interface RowLike {
  id: string;
  status: string;
  amountAtomic: bigint;
  destinationAddress: string;
  sourceAddress: string;
  mint: string;
  txSignature: string | null;
  failureReason: string | null;
  createdAt: Date;
  finalizedAt?: Date | null;
}
