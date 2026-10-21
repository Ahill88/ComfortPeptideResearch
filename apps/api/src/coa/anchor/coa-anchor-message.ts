import { Message, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { MEMO_PROGRAM_ID } from '../coa.types';
import type { CoaAnchorNetwork } from '../coa-anchor-info';

/**
 * THE on-chain shape of an anchor (and the only thing the publisher key is ever asked to sign):
 *
 *   legacy Transaction, ONE instruction:
 *     programId = Memo v2 (MEMO_PROGRAM_ID)
 *     keys      = [ publisher: signer, read-only ]   (Memo v2 convention: a listed signer is verified by the program and logged
 *                                                      "Signed by <publisher>", which attributes the memo to the publisher on chain)
 *     data      = the memo, UTF-8 (buildCoaMemo)
 *   fee payer = the publisher (account index 0), the only signer, no other account, no other instruction.
 * Compiled account keys are therefore exactly [publisher (writable signer), MemoSq4g... (read-only program)].
 */
export function buildMemoTransaction(publisher: PublicKey, memo: string, recentBlockhash: string): Transaction {
  const tx = new Transaction({ feePayer: publisher, recentBlockhash });
  tx.add(
    new TransactionInstruction({
      programId: new PublicKey(MEMO_PROGRAM_ID),
      keys: [{ pubkey: publisher, isSigner: true, isWritable: false }],
      data: Buffer.from(memo, 'utf8'),
    }),
  );
  return tx;
}

/**
 * Hard invariant, run on the EXACT bytes that are about to be sent for signing. A signature by the publisher over any
 * other message could authorize more than a memo (for example a transfer out of the publisher's account), so this throws
 * (a plain Error) unless the message is precisely the anchor shape above.
 */
export function assertMemoOnlyMessage(messageBytes: Uint8Array, publisherAddress: string, memo: string): void {
  const fail = (why: string): never => {
    throw new Error(`COA anchor message invariant violated: ${why}`);
  };
  const message = Message.from(Buffer.from(messageBytes));
  const keys = message.accountKeys.map((key) => key.toBase58());
  if (keys.length !== 2 || keys[0] !== publisherAddress || keys[1] !== MEMO_PROGRAM_ID) fail('account keys must be exactly [publisher, memo program]');
  const { numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts } = message.header;
  if (numRequiredSignatures !== 1 || numReadonlySignedAccounts !== 0 || numReadonlyUnsignedAccounts !== 1) fail('the publisher must be the only (writable) signer');
  if (message.instructions.length !== 1) fail('exactly one instruction is required');
  const [instruction] = message.instructions;
  if (instruction.programIdIndex !== 1) fail('the instruction must invoke the memo program');
  if (instruction.accounts.length !== 1 || instruction.accounts[0] !== 0) fail('the instruction may reference only the publisher');
  const data = Transaction.populate(message).instructions[0].data;
  if (!Buffer.from(data).equals(Buffer.from(memo, 'utf8'))) fail('the instruction data must be exactly the memo');
}

/** `https://explorer.solana.com/tx/<signature>` plus `?cluster=devnet` for devnet only (mainnet is the explorer default). */
export function coaExplorerTxUrl(network: string, signature: string): string {
  const base = `https://explorer.solana.com/tx/${encodeURIComponent(signature)}`;
  return network === 'solana-devnet' ? `${base}?cluster=devnet` : base;
}

/** What the verifier needs from a finalized transaction, independent of the RPC library. */
export interface ChainAnchorBody {
  version: 'legacy' | number;
  /** Static account keys in message order (index 0 = fee payer). */
  accountKeys: string[];
  numRequiredSignatures: number;
  /** Top-level instructions in order. Account lists are resolved to addresses. */
  instructions: Array<{ programId: string; accounts: string[]; data: Uint8Array }>;
  /** Number of inner (CPI) instructions recorded by the cluster; the memo program makes none. */
  innerInstructionCount: number;
}

/**
 * The strict check behind CONFIRMED. Returns null only when the transaction body is EXACTLY the anchor shape for this memo and
 * this publisher, otherwise a short human reason (stored in CoaAnchor.error). Whether it succeeded / is finalized is checked by the caller.
 */
export function checkAnchorBody(body: ChainAnchorBody, expectedMemo: string, publisher: string): string | null {
  if (body.version !== 'legacy') return 'transaction is not a legacy transaction';
  if (body.accountKeys[0] !== publisher) return 'fee payer is not the configured publisher key';
  if (body.numRequiredSignatures !== 1) return 'transaction has more than one signer';
  const memoInstructions = body.instructions.filter((ix) => ix.programId === MEMO_PROGRAM_ID);
  if (body.instructions.length !== 1 || memoInstructions.length !== 1) {
    return `expected exactly one instruction, a single memo; found ${body.instructions.length} instruction(s) of which ${memoInstructions.length} are memo`;
  }
  if (body.innerInstructionCount !== 0) return 'transaction contains inner instructions';
  if (body.accountKeys.length !== 2 || body.accountKeys[1] !== MEMO_PROGRAM_ID) return 'transaction references accounts other than the publisher and the memo program';
  const [memo] = memoInstructions;
  if (memo.accounts.length !== 1 || memo.accounts[0] !== publisher) return 'memo instruction is not signed by the publisher alone';
  if (!Buffer.from(memo.data).equals(Buffer.from(expectedMemo, 'utf8'))) return 'on-chain memo does not equal the expected memo';
  return null;
}

export function isCoaAnchorNetworkName(value: string): value is CoaAnchorNetwork {
  return value === 'solana-devnet' || value === 'solana-mainnet';
}
