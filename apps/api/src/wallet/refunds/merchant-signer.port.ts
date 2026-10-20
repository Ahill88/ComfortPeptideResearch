/**
 * MerchantSigner port.
 *
 * A refund of a paid credits purchase is a NEW USDC transfer FROM the merchant treasury TO the
 * customer's own wallet. Moving treasury funds requires the MERCHANT's signature. The platform
 * (this codebase) never signs anything and never moves customer funds: signing is delegated to
 * whatever is bound to this token.
 *
 * THERE IS NO REAL IMPLEMENTATION IN THIS REPOSITORY, ON PURPOSE.
 * Production MUST bind a KMS/HSM-backed signer (for example a cloud KMS ed25519 key, an HSM, or a
 * multisig / policy-engine service such as Squads or Fireblocks) that:
 *   - never exports key material to the API process,
 *   - enforces its own policy on the `context` it is given (amount caps, destination allowlist
 *     derived from the original purchase, human approval for large refunds, rate limits),
 *   - returns the SAME transaction with the merchant signature added (the platform re-verifies this).
 * Until a signer is bound, RefundsService.prepareAndSubmit fails closed with HTTP 503 and changes
 * nothing. Tests may bind a throwaway in-memory signer; production code must not.
 */
export const MERCHANT_SIGNER = Symbol('MERCHANT_SIGNER');

export interface MerchantSignerContext {
  refundId: string;
  orderId: string;
  amountAtomic: bigint;
  /** The customer's own wallet, derived server-side from the original purchase. Never client input. */
  destination: string;
}

export interface MerchantSigner {
  /** Base58 public key (owner address) of the merchant treasury this signer controls. */
  treasuryAddress(): Promise<string>;
  /**
   * Receives the unsigned serialized legacy transaction (base64) and returns the serialized
   * transaction (base64) carrying the treasury's signature over exactly the same message.
   * The platform rejects any response whose message differs or whose signature is not the
   * treasury's valid signature.
   */
  signTransaction(unsignedBase64: string, context: MerchantSignerContext): Promise<string>;
}
