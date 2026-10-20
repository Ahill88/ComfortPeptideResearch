/**
 * Transaction encoding + local safety inspection.
 * The platform API hands the browser an UNSIGNED transaction. Before the customer's key signs
 * anything we decode it locally and refuse to sign unless it matches the terms shown on screen.
 */
import { PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';

/** USDC mint on Solana devnet (matches the API contract). Devnet only. */
export const USDC_DEVNET_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

export const USDC_DECIMALS = 6;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export type ExpectedTransfer = {
  /** The customer's wallet address: fee payer, sole signer and token authority. */
  signer: string;
  /** OWNER address of the recipient (not a token account). */
  destinationOwner: string;
  amountAtomic: bigint;
  /**
   * 'transfer' (default): what POST /wallet/transfers/prepare builds - an optional idempotent
   *   associated-token-account creation for the recipient, then one TransferChecked.
   * 'checkout': what POST /wallet/checkout/:orderId/prepare builds - exactly one TransferChecked
   *   carrying one extra read-only, non-signer reference account, and nothing else.
   */
  purpose?: 'transfer' | 'checkout';
  /** checkout only: base58 sha256(paymentReference) (see referenceKeyFor). When omitted only the account shape is checked. */
  referenceKey?: string;
  /** Defaults to the devnet USDC mint. */
  mint?: string;
};

/** Solana-Pay-style reference key the API derives: sha256(paymentReference) as a public key. Null if WebCrypto is unavailable. */
export async function referenceKeyFor(paymentReference: string): Promise<string | null> {
  const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined;
  if (!subtle) return null;
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(paymentReference));
  return new PublicKey(new Uint8Array(digest)).toBase58();
}

const ATA_PROGRAM = ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();
const TOKEN_PROGRAM = TOKEN_PROGRAM_ID.toBase58();
const SYSTEM_PROGRAM = SystemProgram.programId.toBase58();
const TRANSFER_CHECKED = 12;
const ATA_CREATE_IDEMPOTENT = 1;

/**
 * Strict pre-sign check. Returns a list of mismatches; an EMPTY list means the transaction is
 * byte-for-byte the shape the API builds and nothing else:
 *   legacy message, 1 signature, fee payer = customer,
 *   [optional idempotent ATA create for the recipient (transfer only)] + one TransferChecked
 *   customer ATA -> recipient ATA for exactly the shown amount in the expected mint
 *   (+ one read-only non-signer reference account for checkout).
 * Anything else (extra instructions, extra accounts, other programs, v0/lookup tables) is rejected.
 */
export function verifyUsdcTransfer(unsignedBase64: string, expected: ExpectedTransfer): string[] {
  const problems: string[] = [];
  const checkout = expected.purpose === 'checkout';
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(base64ToBytes(unsignedBase64));
  } catch {
    return ['The transaction could not be decoded.'];
  }
  try {
    const mintAddress = expected.mint ?? USDC_DEVNET_MINT;
    const mint = new PublicKey(mintAddress);
    const expectedSource = getAssociatedTokenAddressSync(mint, new PublicKey(expected.signer), true).toBase58();
    const expectedDestination = getAssociatedTokenAddressSync(mint, new PublicKey(expected.destinationOwner), true).toBase58();

    const message = tx.message;
    if (tx.version !== 'legacy') problems.push('The transaction is not a legacy transaction.');
    if (message.addressTableLookups.length > 0) problems.push('The transaction uses address lookup tables and cannot be verified locally.');
    const keys = message.staticAccountKeys.map((key) => key.toBase58());
    const { numRequiredSignatures, numReadonlySignedAccounts } = message.header;
    if (numRequiredSignatures !== 1 || numReadonlySignedAccounts !== 0 || tx.signatures.length !== 1) problems.push('The transaction must require exactly one signature (yours).');
    if (keys[0] !== expected.signer) problems.push('Your wallet must be the fee payer and only signer.');
    if (expected.amountAtomic <= 0n) problems.push('The amount must be greater than zero.');

    const instructions = message.compiledInstructions;
    const accountsOf = (ix: (typeof instructions)[number]) => ix.accountKeyIndexes.map((index) => keys[index]);
    const transferIx = instructions[instructions.length - 1];
    const prefix = instructions.slice(0, -1);
    if (!transferIx) {
      problems.push('The transaction contains no USDC transfer.');
    } else {
      // --- the single TransferChecked ---
      const data = transferIx.data;
      const accounts = accountsOf(transferIx);
      if (keys[transferIx.programIdIndex] !== TOKEN_PROGRAM || data.length !== 10 || data[0] !== TRANSFER_CHECKED) {
        problems.push('The last instruction is not a checked USDC token transfer.');
      } else {
        const amount = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(1, true);
        if (amount !== expected.amountAtomic) problems.push('The transfer amount does not match the amount shown.');
        if (data[9] !== USDC_DECIMALS) problems.push('The transfer uses unexpected token decimals.');
        const [source, txMint, destination, authority] = accounts;
        if (txMint !== mintAddress) problems.push('The transfer is not in devnet USDC.');
        if (authority !== expected.signer || source !== expectedSource) problems.push('The transfer does not originate from your wallet USDC account.');
        if (destination !== expectedDestination) problems.push('The transfer destination does not match the recipient shown.');
        if (!message.isAccountSigner(transferIx.accountKeyIndexes[3] ?? -1) || message.isAccountSigner(transferIx.accountKeyIndexes[0] ?? -1)) problems.push('The transfer authority is not marked as the signer.');
        if (checkout) {
          const reference = accounts[4];
          const referenceIndex = transferIx.accountKeyIndexes[4];
          if (accounts.length !== 5 || reference === undefined || referenceIndex === undefined) problems.push('The payment is missing its single reference account.');
          else {
            if (message.isAccountSigner(referenceIndex) || message.isAccountWritable(referenceIndex)) problems.push('The payment reference account must be read-only and not a signer.');
            if (expected.referenceKey && reference !== expected.referenceKey) problems.push('The payment reference does not match this order.');
          }
        } else if (accounts.length !== 4) {
          problems.push('The transfer carries unexpected extra accounts.');
        }
      }
      // --- everything before it: only the recipient's idempotent ATA creation, only for plain transfers ---
      if (prefix.length > (checkout ? 0 : 1)) problems.push('The transaction contains instructions other than the USDC transfer.');
      else if (prefix.length === 1) {
        const ix = prefix[0];
        const a = accountsOf(ix);
        const isIdempotentCreate = keys[ix.programIdIndex] === ATA_PROGRAM && ix.data.length === 1 && ix.data[0] === ATA_CREATE_IDEMPOTENT && a.length === 6;
        if (!isIdempotentCreate) problems.push('The transaction contains an instruction other than an idempotent recipient account creation.');
        else {
          const [payer, ata, owner, ataMint, system, token] = a;
          if (payer !== expected.signer || ata !== expectedDestination || owner !== expected.destinationOwner || ataMint !== mintAddress || system !== SYSTEM_PROGRAM || token !== TOKEN_PROGRAM) {
            problems.push('The recipient account creation does not match the recipient shown.');
          }
        }
      }
    }
  } catch {
    problems.push('The transaction could not be checked against the expected recipient.');
  }
  return Array.from(new Set(problems));
}
