import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  decodeTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { PublicKey, Transaction } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import {
  ChainTransfer,
  ChainUnavailableError,
  SOLANA_NETWORK_DEVNET,
  SolanaNetwork,
  USDC_DECIMALS,
  USDC_DEVNET_MINT,
} from '../contracts';
import { base58Encode } from './base58';
import { ChainRejectedError } from './chain-errors';
import { BASE_FEE_LAMPORTS_PER_SIGNATURE, TOKEN_ACCOUNT_RENT_LAMPORTS, WalletChain } from './chain.types';

export interface SandboxChainOptions {
  /** Apply broadcast transfers to balances immediately (as if finalized). Default false. */
  autoFinalize?: boolean;
  /** SOL given to owners the sandbox has never seen (a fake faucet). Default 1 SOL. */
  defaultSolLamports?: bigint;
  /** Reject broadcasts whose fee payer lacks SOL for fee (+ ATA rent). Default false. */
  strictSolFees?: boolean;
}

interface SandboxTransfer extends ChainTransfer {
  applied: boolean;
}

/**
 * IN-MEMORY, DETERMINISTIC MOCK of Solana for tests and local development.
 *
 * - Nothing here touches a real cluster; state is lost on restart.
 * - USDC "credits" appear only through {@link creditUsdc} (the sandbox faucet), which the
 *   on-ramp mock-complete endpoint calls. Balances, not intent statuses, are the source of truth.
 * - broadcast() really parses and signature-verifies the transaction, so signing bugs are caught.
 */
export class SandboxSolanaChain implements WalletChain {
  /** The sandbox simulates DEVNET only and never claims another network (tests pin this); its mint is therefore the built-in devnet one. */
  readonly network: SolanaNetwork = SOLANA_NETWORK_DEVNET;
  readonly usdcMint = USDC_DEVNET_MINT;

  private readonly usdc = new Map<string, bigint>();
  private readonly sol = new Map<string, bigint>();
  private readonly ataOwners = new Map<string, string>();
  private readonly transfers = new Map<string, SandboxTransfer>();
  private readonly blockhashes = new Set<string>();
  private blockhashCounter = 0;
  private outage = false;
  private height = 1_000;

  constructor(private readonly options: SandboxChainOptions = {}) {
    this.issueBlockhash();
  }

  // ---- test / dev helpers -------------------------------------------------

  /** Credit finalized USDC base units to an owner (sandbox faucet). */
  creditUsdc(owner: string, amountAtomic: bigint): void {
    if (typeof amountAtomic !== 'bigint' || amountAtomic < 0n) throw new RangeError('amount must be a non-negative bigint');
    this.registerOwner(owner);
    this.usdc.set(owner, (this.usdc.get(owner) ?? 0n) + amountAtomic);
  }

  /** Set an exact finalized USDC balance (test convenience). */
  setUsdcBalance(owner: string, amountAtomic: bigint): void {
    if (typeof amountAtomic !== 'bigint' || amountAtomic < 0n) throw new RangeError('amount must be a non-negative bigint');
    this.registerOwner(owner);
    this.usdc.set(owner, amountAtomic);
  }

  creditSol(owner: string, lamports: bigint): void {
    this.sol.set(owner, (this.sol.get(owner) ?? this.defaultSol()) + lamports);
  }

  setSolBalance(owner: string, lamports: bigint): void {
    this.sol.set(owner, lamports);
  }

  /** Record an arbitrary observed transfer (e.g. for payment-verification tests). Optionally apply balances. */
  recordTransfer(transfer: ChainTransfer, opts: { applyBalances?: boolean } = {}): void {
    const entry: SandboxTransfer = { ...transfer, applied: false };
    this.transfers.set(transfer.signature, entry);
    if (opts.applyBalances) this.applyTransfer(entry);
  }

  /** Mark a broadcast transfer finalized and move balances. Returns false if unknown. */
  finalize(signature: string): boolean {
    const transfer = this.transfers.get(signature);
    if (!transfer) return false;
    this.applyTransfer(transfer);
    transfer.finalized = true;
    return true;
  }

  /** Mark a broadcast transfer as failed on chain (finalized, no balance movement). */
  fail(signature: string): boolean {
    const transfer = this.transfers.get(signature);
    if (!transfer) return false;
    transfer.finalized = true;
    transfer.succeeded = false;
    return true;
  }

  /** Simulate an RPC outage: every read/broadcast throws ChainUnavailableError. */
  setOutage(on: boolean): void {
    this.outage = on;
  }

  advanceBlockhash(): string {
    this.height += 150;
    return this.issueBlockhash();
  }

  // ---- SolanaChain --------------------------------------------------------

  async getFinalizedUsdcBalance(owner: string): Promise<bigint> {
    this.assertUp();
    return this.usdc.get(owner) ?? 0n;
  }

  async getSolBalanceLamports(owner: string): Promise<bigint> {
    this.assertUp();
    return this.sol.get(owner) ?? this.defaultSol();
  }

  async getLatestBlockhash() {
    this.assertUp();
    return { blockhash: this.currentBlockhash(), lastValidBlockHeight: this.height + 150 };
  }

  async estimateFeeLamports(): Promise<bigint> {
    this.assertUp();
    return BASE_FEE_LAMPORTS_PER_SIGNATURE;
  }

  async usdcAccountExists(owner: string): Promise<boolean> {
    this.assertUp();
    return this.usdc.has(owner) || this.ataOwners.has(this.ataOf(owner));
  }

  async tokenAccountRentLamports(): Promise<bigint> {
    this.assertUp();
    return TOKEN_ACCOUNT_RENT_LAMPORTS;
  }

  async broadcast(serialized: Uint8Array): Promise<string> {
    this.assertUp();
    let tx: Transaction;
    try {
      tx = Transaction.from(serialized);
    } catch {
      throw new ChainRejectedError('Transaction could not be deserialized');
    }
    if (!tx.signature || !tx.verifySignatures()) throw new ChainRejectedError('Transaction signature verification failed');
    if (!tx.recentBlockhash || !this.blockhashes.has(tx.recentBlockhash)) throw new ChainRejectedError('Blockhash not found');
    const signature = base58Encode(tx.signature);
    if (this.transfers.has(signature)) return signature; // idempotent re-broadcast

    const feePayer = tx.feePayer?.toBase58();
    if (!feePayer) throw new ChainRejectedError('Missing fee payer');

    // Learn account owners from ATA-creation instructions in this transaction (applied only on success).
    const learned = new Map<string, string>();
    let createsAccount = false;
    let transfer: { sourceOwner: string; destinationOwner: string; amount: bigint; mint: string; referenceKeys: string[] } | null = null;
    for (const ix of tx.instructions) {
      if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
        const ata = ix.keys[1]?.pubkey.toBase58();
        const owner = ix.keys[2]?.pubkey.toBase58();
        if (ata && owner && !this.ataOwners.has(ata)) createsAccount = true;
        if (ata && owner) learned.set(ata, owner);
      } else if (ix.programId.equals(TOKEN_PROGRAM_ID) && ix.data[0] === 12) {
        let decoded;
        try {
          decoded = decodeTransferCheckedInstruction(ix, TOKEN_PROGRAM_ID);
        } catch {
          throw new ChainRejectedError('Malformed token transfer instruction');
        }
        if (transfer) throw new ChainRejectedError('Sandbox supports a single token transfer per transaction');
        const mint = decoded.keys.mint.pubkey.toBase58();
        const sourceOwner = decoded.keys.owner.pubkey.toBase58();
        const destAta = decoded.keys.destination.pubkey.toBase58();
        if (mint !== this.usdcMint) throw new ChainRejectedError('Unsupported mint');
        if (decoded.data.decimals !== USDC_DECIMALS) throw new ChainRejectedError('Decimals mismatch');
        if (decoded.keys.source.pubkey.toBase58() !== this.ataOf(sourceOwner)) throw new ChainRejectedError('Source is not the signer ATA');
        if (!decoded.keys.owner.isSigner) throw new ChainRejectedError('Transfer authority must sign');
        const destinationOwner = learned.get(destAta) ?? this.ataOwners.get(destAta);
        if (!destinationOwner) throw new ChainRejectedError('Destination token account does not exist');
        // TransferChecked uses 4 fixed accounts (source, mint, destination, owner). Any further
        // accounts are Solana Pay style reference keys that bind this transfer to one payment.
        const referenceKeys = ix.keys.slice(4).map((meta) => meta.pubkey.toBase58());
        transfer = { sourceOwner, destinationOwner, amount: decoded.data.amount, mint, referenceKeys };
      } else {
        throw new ChainRejectedError('Sandbox rejects unsupported instruction programs');
      }
    }
    if (!transfer) throw new ChainRejectedError('No token transfer found in transaction');
    if (transfer.amount <= 0n) throw new ChainRejectedError('Amount must be positive');
    if ((this.usdc.get(transfer.sourceOwner) ?? 0n) < transfer.amount) throw new ChainRejectedError('Insufficient funds');
    // Fee-sponsored transaction: the fee payer is NOT the token authority. The authority (the customer) is still a
    // required signer whose signature was verified above (verifySignatures covers every required signer), so the
    // sponsor can neither authorize nor redirect the transfer. The network fee (5000 lamports per signature) is
    // debited from the FEE PAYER's SOL; the customer needs none. Customer-paid transactions keep the old model.
    const sponsored = transfer.sourceOwner !== feePayer;
    const feeLamports = BASE_FEE_LAMPORTS_PER_SIGNATURE * BigInt(tx.signatures.length);
    if (sponsored) {
      if ((this.sol.get(feePayer) ?? this.defaultSol()) < feeLamports) throw new ChainRejectedError('Insufficient SOL for fees');
    } else if (this.options.strictSolFees) {
      const need = BASE_FEE_LAMPORTS_PER_SIGNATURE + (createsAccount ? TOKEN_ACCOUNT_RENT_LAMPORTS : 0n);
      if ((this.sol.get(feePayer) ?? this.defaultSol()) < need) throw new ChainRejectedError('Insufficient SOL for fees');
    }
    if (sponsored) this.sol.set(feePayer, (this.sol.get(feePayer) ?? this.defaultSol()) - feeLamports);

    for (const [ata, owner] of learned) this.ataOwners.set(ata, owner);
    const entry: SandboxTransfer = {
      signature,
      network: this.network,
      finalized: false,
      succeeded: true,
      mint: transfer.mint,
      sourceOwner: transfer.sourceOwner,
      destinationOwner: transfer.destinationOwner,
      amountAtomic: transfer.amount,
      referenceKeys: transfer.referenceKeys,
      applied: false,
    };
    this.transfers.set(signature, entry);
    if (this.options.autoFinalize) {
      this.applyTransfer(entry);
      entry.finalized = true;
    }
    return signature;
  }

  async getTransfer(signature: string): Promise<ChainTransfer | null> {
    this.assertUp();
    const transfer = this.transfers.get(signature);
    if (!transfer) return null;
    const { applied: _applied, ...view } = transfer;
    return { ...view, referenceKeys: [...view.referenceKeys] };
  }

  // ---- internals ----------------------------------------------------------

  private applyTransfer(transfer: SandboxTransfer) {
    if (transfer.applied || !transfer.succeeded) return;
    const from = this.usdc.get(transfer.sourceOwner) ?? 0n;
    if (from < transfer.amountAtomic) {
      transfer.succeeded = false;
      return;
    }
    this.usdc.set(transfer.sourceOwner, from - transfer.amountAtomic);
    this.registerOwner(transfer.destinationOwner);
    this.usdc.set(transfer.destinationOwner, (this.usdc.get(transfer.destinationOwner) ?? 0n) + transfer.amountAtomic);
    transfer.applied = true;
  }

  private registerOwner(owner: string) {
    this.ataOwners.set(this.ataOf(owner), owner);
  }

  private ataOf(owner: string): string {
    return getAssociatedTokenAddressSync(new PublicKey(this.usdcMint), new PublicKey(owner), true).toBase58();
  }

  private defaultSol(): bigint {
    return this.options.defaultSolLamports ?? 1_000_000_000n;
  }

  private currentBlockhash = () => this.latestBlockhash;
  private latestBlockhash = '';

  private issueBlockhash(): string {
    this.blockhashCounter += 1;
    const digest = createHash('sha256').update(`sandbox-blockhash-${this.blockhashCounter}`).digest();
    this.latestBlockhash = new PublicKey(digest).toBase58();
    this.blockhashes.add(this.latestBlockhash);
    return this.latestBlockhash;
  }

  private assertUp() {
    if (this.outage) throw new ChainUnavailableError('Sandbox chain outage (simulated)');
  }
}
