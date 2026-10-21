/**
 * CoaPublisherSigner port: the key that signs the on-chain anchors of certificates of analysis (COAs).
 *
 * WHAT THE SIGNATURE CAN AUTHORIZE: the platform only ever asks this signer to sign ONE kind of message, a legacy Solana
 * transaction message with a single Memo-program instruction (see coa-anchor-message.ts). AnchorService asserts that on the
 * exact bytes it is about to send for signing (assertMemoOnlyMessage: one instruction, program = Memo, no account other than
 * the publisher, fee payer = publisher) and refuses to ask otherwise. The Memo program moves no funds, so the key's only
 * possible loss is the few dollars of SOL it holds for fees. Anchors are public records; the key is NOT a payment key.
 *
 * THERE IS NO PRODUCTION IMPLEMENTATION IN THIS REPOSITORY, ON PURPOSE (same rule as FeePayerSigner / MerchantSigner).
 * Production deployments MUST bind a KMS/HSM-backed signer under this token (a cloud KMS ed25519 key, an HSM, a policy
 * engine) that:
 *   - never exports key material to the API process,
 *   - is a DEDICATED key that holds only a small SOL budget for fees (never USDC, never the treasury, never the fee-payer
 *     key used for checkout sponsorship, never any customer wallet),
 *   - is rotated by binding a new key and publishing the change (docs/api/coa-anchoring.md).
 * With no signer bound, anchoring is simply unavailable: COAs still publish, anchors stay PENDING with a clear error and
 * nothing is broadcast. The only implementations in this repository are test doubles (tests/coa) and the throwaway-key
 * development launcher (tools/dev/api-devnet-sponsored.ts), neither of which ships in apps/api/src.
 *
 * Configuration (which network, RPC, on/off) is separate: coa-anchor.config.ts.
 */
export const COA_PUBLISHER_SIGNER = Symbol('COA_PUBLISHER_SIGNER');

export interface CoaPublisherSigner {
  /** Base58 public key of the publisher: the transaction's fee payer and only signer. */
  readonly publicKey: string;
  /**
   * Returns the 64-byte ed25519 DETACHED signature over `message`, the serialized transaction MESSAGE (what
   * `Transaction.serializeMessage()` returns), never a whole transaction. The platform verifies the signature against the
   * transaction before broadcasting, so a broken signer can only make an anchor attempt fail, never broadcast something wrong.
   */
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

/** Thrown when the signer misbehaves (throws, returns the wrong shape). The anchor attempt is abandoned; nothing is broadcast. */
export class CoaPublisherSignerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'CoaPublisherSignerError';
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

/**
 * The single place the platform asks the publisher signer for a signature. Validates the shape of the answer; the caller
 * additionally verifies the signature cryptographically against the transaction before broadcasting.
 */
export async function requestCoaPublisherSignature(signer: CoaPublisherSigner, message: Uint8Array): Promise<Uint8Array> {
  let signature: unknown;
  try {
    signature = await signer.signMessage(message);
  } catch (error) {
    throw new CoaPublisherSignerError(`COA publisher signer failed: ${error instanceof Error ? error.message : 'unknown error'}`, { cause: error });
  }
  if (!(signature instanceof Uint8Array) || signature.byteLength !== 64) {
    throw new CoaPublisherSignerError('COA publisher signer returned something other than a 64-byte signature');
  }
  return signature;
}
