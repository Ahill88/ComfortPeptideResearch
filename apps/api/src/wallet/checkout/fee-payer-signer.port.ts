/**
 * FeePayerSigner port: who pays the Solana network fee for a "Pay with Research Credits" checkout.
 *
 * PRODUCT DECISION: a customer who bought USDC through the fiat on-ramp holds no SOL, so the platform pays the
 * network fee for wallet checkout when FEE_SPONSORSHIP=true. This is the ONLY thing the platform ever signs:
 *
 *   - The fee payer is account index 0 of the transaction MESSAGE and appears in NO instruction's account list,
 *     so a fee-payer signature can authorize nothing except paying the fee. It cannot move USDC, cannot move SOL
 *     out of any account, and cannot touch a customer's funds (the customer's wallet remains the USDC token
 *     authority and must sign). The checkout service asserts this on the compiled message before any signature
 *     is requested, and again right before it asks for one.
 *   - The customer can never supply or replace the fee-payer signature (it is cleared and re-created here).
 *
 * THERE IS NO PRODUCTION IMPLEMENTATION IN THIS REPOSITORY, ON PURPOSE (same rule as MerchantSigner).
 * Production/devnet deployments MUST bind a KMS/HSM-backed signer under this token (a cloud KMS ed25519 key,
 * an HSM, a policy engine) that:
 *   - never exports key material to the API process,
 *   - holds a key whose account carries ONLY the SOL budget for fees (never USDC, never the treasury),
 *   - is not the merchant treasury and not any customer wallet.
 * With no signer bound, sponsorship is simply unavailable: prepare falls back to customer-pays and a submit of
 * an already-sponsored payment fails closed with HTTP 503 and broadcasts nothing.
 * The only in-repo implementation is the sandbox-only in-memory signer (chain/sandbox-fee-payer-signer.ts), which
 * refuses to construct outside NODE_ENV=development|test.
 */
export const FEE_PAYER_SIGNER = Symbol('FEE_PAYER_SIGNER');

export interface FeePayerSigner {
  /** Base58 public key of the account that pays fees (the signer's own address). */
  readonly publicKey: string;
  /**
   * Returns the 64-byte ed25519 DETACHED signature over `message`, which is the serialized transaction MESSAGE
   * (what `Transaction.serializeMessage()` returns), never a whole transaction. The platform verifies the
   * signature before using it, so a broken signer can only make a submit fail, never broadcast something wrong.
   */
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

/** Thrown when the signer misbehaves (throws, times out, returns the wrong shape). The platform maps it to 503. */
export class FeePayerSignerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'FeePayerSignerError';
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

/**
 * The single place the platform asks the signer for a signature. Validates the shape of the answer; the caller
 * additionally verifies the signature cryptographically against the transaction before broadcasting.
 */
export async function requestFeePayerSignature(signer: FeePayerSigner, message: Uint8Array): Promise<Uint8Array> {
  let signature: unknown;
  try {
    signature = await signer.signMessage(message);
  } catch (error) {
    throw new FeePayerSignerError(`Fee payer signer failed: ${error instanceof Error ? error.message : 'unknown error'}`, { cause: error });
  }
  if (!(signature instanceof Uint8Array) || signature.byteLength !== 64) {
    throw new FeePayerSignerError('Fee payer signer returned something other than a 64-byte signature');
  }
  return signature;
}
