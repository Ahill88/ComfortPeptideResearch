import { Connection, SendTransactionError, VersionedTransactionResponse } from '@solana/web3.js';
import type { CoaAnchorNetwork } from '../coa-anchor-info';
import type { ChainAnchorBody } from './coa-anchor-message';

const COMMITMENT = 'finalized' as const;

/** The cluster definitively refused the transaction (simulation/preflight failure): it can never land. */
export class CoaAnchorRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoaAnchorRejectedError';
  }
}

/** The RPC failed or timed out. Says nothing about whether a transaction landed (never treat it as "rejected" or "not found"). */
export class CoaAnchorChainUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoaAnchorChainUnavailableError';
  }
}

export interface CoaAnchorTxView {
  signature: string;
  /** confirmationStatus === 'finalized'. */
  finalized: boolean;
  /** Execution result (err === null). Only trustworthy for a finalized view. */
  succeeded: boolean;
  /** Short description of the on-chain error, when it failed. */
  errorText: string | null;
  slot: number | null;
  blockTime: number | null;
  /** The transaction body; null until it is finalized. */
  body: ChainAnchorBody | null;
}

/** Everything anchoring needs from Solana. Implemented by SolanaCoaAnchorChain; tests supply a fake. */
export const COA_ANCHOR_CHAIN = Symbol('COA_ANCHOR_CHAIN');
export interface CoaAnchorChain {
  readonly network: CoaAnchorNetwork;
  /** A recent FINALIZED blockhash (known to every node, so a preflight failure is never "blockhash not found" on a lagging node). */
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  /** Sends canonical bytes with preflight. Throws CoaAnchorRejectedError (definitive) or CoaAnchorChainUnavailableError (outcome unknown). */
  broadcast(serialized: Uint8Array): Promise<string>;
  /** null ONLY when the cluster has no status for the signature ("not found", searched through history). RPC failures throw CoaAnchorChainUnavailableError. */
  getTransaction(signature: string): Promise<CoaAnchorTxView | null>;
}

export class SolanaCoaAnchorChain implements CoaAnchorChain {
  readonly network: CoaAnchorNetwork;
  private readonly connection: Connection;

  constructor(options: { network: CoaAnchorNetwork; rpcUrl: string; connection?: Connection }) {
    this.network = options.network;
    this.connection = options.connection ?? new Connection(options.rpcUrl, COMMITMENT);
  }

  async getLatestBlockhash() {
    return this.rpc(() => this.connection.getLatestBlockhash(COMMITMENT));
  }

  async broadcast(serialized: Uint8Array): Promise<string> {
    try {
      return await this.connection.sendRawTransaction(serialized, { skipPreflight: false, preflightCommitment: COMMITMENT, maxRetries: 3 });
    } catch (error) {
      if (error instanceof SendTransactionError) {
        // The cluster says this exact transaction was already processed: it LANDED. That is not a rejection.
        if (/already (been )?processed/i.test(error.message)) throw new CoaAnchorChainUnavailableError('the cluster reports the transaction was already processed');
        throw new CoaAnchorRejectedError(error.message);
      }
      throw this.unavailable(error);
    }
  }

  async getTransaction(signature: string): Promise<CoaAnchorTxView | null> {
    const statuses = await this.rpc(() => this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true }));
    const status = statuses.value[0];
    if (!status) return null;
    const finalized = status.confirmationStatus === 'finalized';
    const succeeded = status.err === null;
    const errorText = succeeded ? null : JSON.stringify(status.err).slice(0, 200);
    if (!finalized) return { signature, finalized: false, succeeded, errorText, slot: status.slot ?? null, blockTime: null, body: null };
    const tx = await this.rpc(() => this.connection.getTransaction(signature, { commitment: COMMITMENT, maxSupportedTransactionVersion: 0 }));
    // A finalized status with no readable body is an RPC inconsistency (pruned/lagging node): unknown, never "not found".
    if (!tx) throw new CoaAnchorChainUnavailableError('the transaction is finalized but its body is not available from the RPC');
    return {
      signature,
      finalized: true,
      succeeded: tx.meta ? tx.meta.err === null : succeeded,
      errorText: tx.meta?.err ? JSON.stringify(tx.meta.err).slice(0, 200) : errorText,
      slot: tx.slot,
      blockTime: tx.blockTime ?? null,
      body: toBody(tx),
    };
  }

  private async rpc<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw this.unavailable(error);
    }
  }

  private unavailable(error: unknown): CoaAnchorChainUnavailableError {
    if (error instanceof CoaAnchorChainUnavailableError) return error;
    return new CoaAnchorChainUnavailableError(`Solana RPC request failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

/** Converts a getTransaction result without relying on parsed-instruction formats: raw account indexes and raw data bytes. */
export function toBody(tx: VersionedTransactionResponse): ChainAnchorBody {
  const message = tx.transaction.message;
  const accountKeys = message.staticAccountKeys.map((key) => key.toBase58());
  const lookups = 'addressTableLookups' in message && Array.isArray(message.addressTableLookups) ? message.addressTableLookups.length : 0;
  const instructions = message.compiledInstructions.map((ix) => ({
    programId: accountKeys[ix.programIdIndex] ?? '',
    // An index beyond the static keys (a lookup-table account) resolves to '' so it can never equal the publisher.
    accounts: ix.accountKeyIndexes.map((index) => accountKeys[index] ?? ''),
    data: Uint8Array.from(ix.data),
  }));
  return {
    // A transaction using address lookup tables cannot be an anchor; flag it through the version.
    version: tx.version === 'legacy' && lookups === 0 ? 'legacy' : typeof tx.version === 'number' ? tx.version : 0,
    accountKeys,
    numRequiredSignatures: message.header.numRequiredSignatures,
    instructions,
    innerInstructionCount: (tx.meta?.innerInstructions ?? []).reduce((total, inner) => total + inner.instructions.length, 0),
  };
}
