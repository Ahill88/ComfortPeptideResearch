/**
 * Transaction encoding + local safety inspection.
 * The platform API hands the browser an UNSIGNED transaction. Before the customer's key signs
 * anything we decode it locally and refuse to sign unless it matches the terms shown on screen.
 */
import { PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { CheckoutPreparation } from './api';

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
  /** The customer's wallet address: token authority and signer (and the fee payer too, unless feeSponsored). */
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
  /**
   * checkout only. True when the platform pays the network fee: the transaction must then have exactly two signers,
   * [platform fee payer, customer], the fee payer being `feePayer`, and that key must appear nowhere else in the message.
   * Default false: the customer's wallet must be the fee payer and sole signer (unchanged behaviour).
   */
  feeSponsored?: boolean;
  /** The fee payer the API announced (base58). Required when feeSponsored; when not sponsored it may only be null/undefined or the customer's wallet. */
  feePayer?: string | null;
};

/** What the signer must be told when the fee is sponsored so it can refuse anything but the expected two-signer shape. */
export type SigningOptions = { sponsoredFeePayer?: string };

export function signingOptionsFor(prep: { feeSponsored: boolean; feePayer: string | null }): SigningOptions | undefined {
  if (!prep.feeSponsored) return undefined;
  if (!prep.feePayer) throw new Error('The payment is marked fee-sponsored but names no fee payer. Nothing was signed.');
  return { sponsoredFeePayer: prep.feePayer };
}

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
 *   legacy message, 1 signature, fee payer = customer (or, when the platform sponsors the fee, 2 signatures
 *   [platform fee payer, customer] with the fee payer referenced by no instruction),
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
    const sponsored = expected.feeSponsored === true;
    const claimedFeePayer = expected.feePayer ?? null;
    if (!sponsored) {
      if (numRequiredSignatures !== 1 || numReadonlySignedAccounts !== 0 || tx.signatures.length !== 1) problems.push('The transaction must require exactly one signature (yours).');
      if (keys[0] !== expected.signer) problems.push('Your wallet must be the fee payer and only signer.');
      if (claimedFeePayer !== null && claimedFeePayer !== expected.signer) problems.push('The service names a fee payer other than your wallet but did not mark the fee as sponsored.');
    } else if (!checkout) {
      problems.push('A sponsored network fee is only supported for checkout payments.');
    } else {
      // Platform-paid fee: [fee payer, customer] sign; the fee payer exists only to pay the fee and must be inert everywhere else.
      let announced: string | null = null;
      try { announced = claimedFeePayer ? new PublicKey(claimedFeePayer).toBase58() : null; } catch { announced = null; }
      if (!announced || announced !== claimedFeePayer) problems.push('The service did not name a valid fee payer for the sponsored network fee.');
      if (announced === expected.signer) problems.push('The fee is marked as sponsored but the named fee payer is your own wallet.');
      if (announced === expected.destinationOwner) problems.push('The fee payer must not be the merchant address.');
      if (keys[0] === expected.signer) problems.push('The fee is marked as sponsored but your own wallet is the transaction fee payer.');
      else if (announced && keys[0] !== announced) problems.push('The transaction fee payer is not the fee payer the service announced.');
      // The customer (token authority) is normally a READ-ONLY signer here; the fee payer in slot 0 is always writable, so at most one signer is read-only.
      if (numRequiredSignatures !== 2 || numReadonlySignedAccounts > 1 || tx.signatures.length !== 2) problems.push('A fee-sponsored transaction must require exactly two signatures (the fee payer and yours).');
      if (!keys.slice(0, numRequiredSignatures).includes(expected.signer) || keys[1] !== expected.signer) problems.push('Your wallet must be the second signer of a fee-sponsored transaction.');
      if (keys[0] !== undefined) {
        const feePayerKey = keys[0];
        if (keys.filter((key) => key === feePayerKey).length !== 1) problems.push('The fee payer key appears more than once in the transaction.');
        const referencesFeePayer = message.compiledInstructions.some((ix) => ix.programIdIndex === 0 || ix.accountKeyIndexes.includes(0));
        if (referencesFeePayer) problems.push('The fee payer account is used inside an instruction; it may only pay the network fee.');
        const referenced = new Set<number>([0, 1]);
        for (const ix of message.compiledInstructions) { referenced.add(ix.programIdIndex); for (const index of ix.accountKeyIndexes) referenced.add(index); }
        if (keys.some((_, index) => !referenced.has(index))) problems.push('The transaction lists accounts that no instruction uses.');
      }
    }
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

/**
 * Everything that must hold before this browser may sign a prepared CHECKOUT payment, other than amount/recipient/expiry
 * (the top-up run checks those itself). The component and the tests call exactly this.
 */
export async function checkoutPreparationProblems(prep: CheckoutPreparation, signerAddress: string): Promise<string[]> {
  const problems: string[] = [];
  if (prep.network !== 'solana-devnet') problems.push(`Network "${prep.network}" is not supported by the sandbox wallet (Solana devnet only).`);
  // Exactly what the API builds: one TransferChecked (customer ATA -> merchant ATA) plus one read-only reference account = sha256(paymentReference).
  const referenceKey = await referenceKeyFor(prep.paymentReference);
  problems.push(...verifyUsdcTransfer(prep.unsignedTransactionBase64, {
    signer: signerAddress, destinationOwner: prep.merchant, amountAtomic: prep.amountAtomic, purpose: 'checkout', referenceKey: referenceKey ?? undefined,
    feeSponsored: prep.feeSponsored, feePayer: prep.feePayer,
  }));
  return problems;
}
