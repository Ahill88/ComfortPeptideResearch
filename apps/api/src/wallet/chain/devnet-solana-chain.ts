import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
  getAccount,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptAccount,
} from '@solana/spl-token';
import { Connection, ParsedInstruction, ParsedTransactionWithMeta, PartiallyDecodedInstruction, PublicKey, SendTransactionError } from '@solana/web3.js';
import {
  ChainTransfer,
  ChainUnavailableError,
  SolanaNetwork,
  WalletFeatureFlags,
  USDC_DEVNET_MINT,
} from '../contracts';
import { DEFAULT_DEVNET_RPC_URL } from '../wallet.config';
import { ChainRejectedError } from './chain-errors';
import { BASE_FEE_LAMPORTS_PER_SIGNATURE, WalletChain } from './chain.types';

const COMMITMENT = 'finalized' as const;

/**
 * A transaction that DID land (its signature has a status) but whose USDC transfer cannot be read
 * unambiguously: unparseable, token-2022, several token transfers, delegate/multisig authority, ...
 *
 * This is deliberately NOT the same as "not found" (getTransfer returns null) and can never be mistaken for
 * success. It extends ChainUnavailableError so that any caller unaware of it fails closed exactly like an RPC
 * outage (state untouched, balance read marked stale, HTTP 503) instead of treating the transaction as absent.
 * Aware callers (checkout verification/reconciliation, transfers) detect it structurally through the
 * `ambiguousTransfer` brand and route the payment to MANUAL REVIEW; they never expire, fail or settle on it.
 */
export class AmbiguousTransferError extends ChainUnavailableError {
  readonly ambiguousTransfer = true as const;
  constructor(readonly signature: string, readonly detail: string) {
    super(`Transaction ${signature} landed but its transfer is ambiguous or unparseable: ${detail}`);
    this.name = 'AmbiguousTransferError';
  }
}

/** spl-token instruction tags that move tokens: 3 = Transfer, 12 = TransferChecked. */
const TRANSFER_DISCRIMINATORS = new Set([3, 12]);
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** First decoded byte of base58 instruction data, or null when empty/undecodable. */
function firstByteOfBase58(data: string | undefined): number | null {
  if (typeof data !== 'string' || data.length === 0) return null;
  const bytes: number[] = []; // little-endian
  for (const char of data) {
    const value = BASE58_ALPHABET.indexOf(char);
    if (value < 0) return null;
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  while (zeros < data.length && data[zeros] === '1') zeros++;
  const decoded = [...Array(zeros).fill(0), ...bytes.reverse()];
  return decoded.length > 0 ? decoded[0] : null;
}

export interface DevnetChainOptions {
  rpcUrl?: string;
  network?: SolanaNetwork;
  /** THE USDC mint (config.usdcMint). Required explicitly for mainnet; only devnet may fall back to the built-in devnet mint. */
  usdcMint?: string;
  /** Inject a Connection (tests). */
  connection?: Connection;
}

/**
 * Solana RPC adapter (devnet by default). Reads use `finalized` commitment.
 *
 * Refuses to construct for mainnet unless flags.enableSolanaMainnet is true. Network
 * is the explicit option (SOLANA_NETWORK); an RPC URL that looks like mainnet while
 * the network is devnet is also rejected, so a misconfiguration cannot silently
 * point a "devnet" deployment at mainnet.
 *
 * NOTE: exercised only against an injected fake Connection in unit tests; it has not
 * been run against a live cluster in this phase.
 */
export class DevnetSolanaChain implements WalletChain {
  readonly network: SolanaNetwork;
  readonly usdcMint: string;
  private readonly connection: Connection;

  constructor(flags: WalletFeatureFlags, options: DevnetChainOptions = {}) {
    const rpcUrl = options.rpcUrl ?? process.env.SOLANA_RPC_URL ?? DEFAULT_DEVNET_RPC_URL;
    this.network = options.network ?? 'solana-devnet';
    const looksMainnet = /mainnet/i.test(rpcUrl);
    if (this.network === 'solana-mainnet' || looksMainnet) {
      if (!flags.enableSolanaMainnet) {
        throw new Error('Solana mainnet is disabled: set ENABLE_SOLANA_MAINNET=true to allow it (default false).');
      }
      if (this.network !== 'solana-mainnet') {
        throw new Error('SOLANA_RPC_URL looks like mainnet but SOLANA_NETWORK is devnet; refusing to start.');
      }
      if (!options.usdcMint) throw new Error('Mainnet requires an explicit SOLANA_USDC_MINT.');
      // A mainnet mint read through the devnet endpoint (the unset-variable default) silently yields zero balances.
      if (!options.rpcUrl || options.rpcUrl === DEFAULT_DEVNET_RPC_URL || /devnet/i.test(options.rpcUrl)) {
        throw new Error('Mainnet requires an explicit SOLANA_RPC_URL that is not the devnet default.');
      }
    }
    // Only devnet may fall back to the built-in mint; the mainnet branch above already required an explicit one.
    this.usdcMint = options.usdcMint ?? USDC_DEVNET_MINT;
    this.connection = options.connection ?? new Connection(rpcUrl, COMMITMENT);
  }

  async getFinalizedUsdcBalance(owner: string): Promise<bigint> {
    const ata = this.ata(owner);
    try {
      const account = await getAccount(this.connection, ata, COMMITMENT);
      return account.amount;
    } catch (error) {
      if (error instanceof TokenAccountNotFoundError || error instanceof TokenInvalidAccountOwnerError) return 0n;
      throw this.unavailable(error);
    }
  }

  async getSolBalanceLamports(owner: string): Promise<bigint> {
    return this.rpc(async () => BigInt(await this.connection.getBalance(new PublicKey(owner), COMMITMENT)));
  }

  async getLatestBlockhash() {
    return this.rpc(() => this.connection.getLatestBlockhash(COMMITMENT));
  }

  /** Base fee for a single-signature transaction. Priority fees are not used. */
  async estimateFeeLamports(): Promise<bigint> {
    return BASE_FEE_LAMPORTS_PER_SIGNATURE;
  }

  async usdcAccountExists(owner: string): Promise<boolean> {
    const info = await this.rpc(() => this.connection.getAccountInfo(this.ata(owner), COMMITMENT));
    return info !== null;
  }

  async tokenAccountRentLamports(): Promise<bigint> {
    return this.rpc(async () => BigInt(await getMinimumBalanceForRentExemptAccount(this.connection, COMMITMENT)));
  }

  async broadcast(serialized: Uint8Array): Promise<string> {
    try {
      return await this.connection.sendRawTransaction(serialized, {
        skipPreflight: false,
        preflightCommitment: COMMITMENT,
        maxRetries: 3,
      });
    } catch (error) {
      if (error instanceof SendTransactionError) throw new ChainRejectedError(error.message);
      throw this.unavailable(error);
    }
  }

  /**
   * Returns null ONLY when the cluster has no status for the signature ("not found").
   * A transaction that landed but cannot be read unambiguously throws AmbiguousTransferError (never null, never
   * a guessed transfer), unless it definitively FAILED on chain: a failed transaction moved no funds, so it is
   * reported as `succeeded: false` with empty transfer fields and callers fail it without manual review.
   */
  async getTransfer(signature: string): Promise<ChainTransfer | null> {
    const statuses = await this.rpc(() => this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true }));
    const status = statuses.value[0];
    if (!status) return null;
    const finalized = status.confirmationStatus === 'finalized';
    const succeeded = status.err === null;
    const parsed = await this.rpc(() =>
      this.connection.getParsedTransaction(signature, {
        commitment: finalized ? 'finalized' : 'confirmed',
        maxSupportedTransactionVersion: 0,
      }),
    );
    try {
      if (!parsed) throw new AmbiguousTransferError(signature, 'the transaction landed but its body is not available from the RPC');
      return this.toTransfer(signature, parsed, finalized, succeeded);
    } catch (error) {
      if (error instanceof AmbiguousTransferError && !succeeded) return this.failedTransfer(signature, finalized);
      throw error;
    }
  }

  // ---- internals ----------------------------------------------------------

  private failedTransfer(signature: string, finalized: boolean): ChainTransfer {
    return { signature, network: this.network, finalized, succeeded: false, mint: '', sourceOwner: '', destinationOwner: '', amountAtomic: 0n, referenceKeys: [] };
  }

  /**
   * Strict single-transfer parse. Requires EXACTLY ONE classic spl-token transfer/transferChecked in the whole
   * transaction (top-level + inner instructions) and rejects, as ambiguous: any Token-2022 instruction, any
   * unparsed instruction of the token program, a transfer authorized by anything other than the source token
   * account's owner (delegate), and inconsistent mint/owner data. Reference keys come only from THAT instruction's
   * own account list: the RPC parser exposes accounts beyond the authority as `signers`, so a Solana Pay reference
   * appended to the transfer shows up there. Read-only accounts elsewhere in the transaction are never references.
   */
  private toTransfer(signature: string, tx: ParsedTransactionWithMeta, finalized: boolean, succeeded: boolean): ChainTransfer {
    const ambiguous = (detail: string) => new AmbiguousTransferError(signature, detail);
    const instructions: Array<ParsedInstruction | PartiallyDecodedInstruction> = [
      ...tx.transaction.message.instructions,
      ...(tx.meta?.innerInstructions ?? []).flatMap((inner) => inner.instructions),
    ];
    const transfers: ParsedInstruction[] = [];
    for (const ix of instructions) {
      if (ix.programId.equals(TOKEN_2022_PROGRAM_ID)) throw ambiguous('Token-2022 instructions are not supported');
      if (!ix.programId.equals(TOKEN_PROGRAM_ID)) continue;
      if (!('parsed' in ix)) {
        // Unparsed token instruction. Benign helpers (e.g. the ATA program's CPIs) are fine; anything that could be a
        // transfer, or data we cannot decode at all, makes the transaction ambiguous.
        const discriminator = firstByteOfBase58(ix.data);
        if (discriminator === null || TRANSFER_DISCRIMINATORS.has(discriminator)) throw ambiguous('an spl-token instruction could not be parsed');
        continue;
      }
      if (ix.program !== 'spl-token') throw ambiguous('unexpected parser for the token program');
      if (ix.parsed?.type === 'transfer' || ix.parsed?.type === 'transferChecked') transfers.push(ix);
    }
    if (transfers.length === 0) throw ambiguous('no spl-token transfer found');
    if (transfers.length > 1) throw ambiguous(`${transfers.length} spl-token transfers found; exactly one is required`);

    const info = transfers[0].parsed.info as {
      source?: unknown;
      destination?: unknown;
      authority?: unknown;
      multisigAuthority?: unknown;
      signers?: unknown;
      mint?: unknown;
      amount?: unknown;
      tokenAmount?: { amount?: unknown };
    };
    const asString = (value: unknown, what: string): string => {
      if (typeof value !== 'string' || value.length === 0) throw ambiguous(`transfer ${what} is missing`);
      return value;
    };
    const source = asString(info.source, 'source');
    const destination = asString(info.destination, 'destination');
    const authority = asString(info.authority ?? info.multisigAuthority, 'authority');
    const keys = tx.transaction.message.accountKeys;
    const indexOf = (address: string) => keys.findIndex((key) => key.pubkey.toBase58() === address);
    const balances = [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])];
    const single = (address: string, field: 'owner' | 'mint', what: string): string => {
      const index = indexOf(address);
      if (index < 0) throw ambiguous(`${what} account is not in the transaction`);
      const values = new Set(balances.filter((b) => b.accountIndex === index).map((b) => b[field]));
      values.delete(undefined);
      if (values.size !== 1) throw ambiguous(`${what} token account ${field} is ${values.size === 0 ? 'unknown' : 'inconsistent'}`);
      return [...values][0] as string;
    };
    const sourceOwner = single(source, 'owner', 'source');
    const destinationOwner = single(destination, 'owner', 'destination');
    const mint = single(destination, 'mint', 'destination');
    if (single(source, 'mint', 'source') !== mint) throw ambiguous('source and destination mints differ');
    if (info.mint !== undefined && info.mint !== mint) throw ambiguous('transfer mint does not match the token accounts');
    // Delegate (or any non-owner) authority: the owner did not authorize this movement.
    if (authority !== sourceOwner) throw ambiguous('transfer authority is not the source token account owner (delegate)');

    const amount = info.tokenAmount?.amount ?? info.amount;
    if (typeof amount !== 'string' || !/^\d+$/.test(amount)) throw ambiguous('transfer amount is missing or malformed');

    const extra = Array.isArray(info.signers) ? (info.signers as unknown[]) : [];
    const referenceKeys = [
      ...new Set(
        extra
          .filter((address): address is string => typeof address === 'string')
          .filter((address) => {
            const key = keys[indexOf(address)];
            return !!key && !key.signer && !key.writable && address !== mint && address !== source && address !== destination;
          }),
      ),
    ];
    return {
      signature,
      network: this.network,
      finalized,
      succeeded,
      mint,
      sourceOwner,
      destinationOwner,
      amountAtomic: BigInt(amount),
      referenceKeys,
    };
  }

  private ata(owner: string): PublicKey {
    return getAssociatedTokenAddressSync(new PublicKey(this.usdcMint), new PublicKey(owner), true);
  }

  private async rpc<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw this.unavailable(error);
    }
  }

  private unavailable(error: unknown): ChainUnavailableError {
    if (error instanceof ChainUnavailableError) return error;
    const message = error instanceof Error ? error.message : 'unknown error';
    return new ChainUnavailableError(`Solana RPC request failed: ${message}`);
  }
}
