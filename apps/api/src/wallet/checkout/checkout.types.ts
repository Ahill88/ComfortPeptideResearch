/** Result shapes. All token amounts are strings (bigint base units) so JSON never loses precision. */
export interface PrepareResult {
  paymentReference: string;
  /** USDC base units (6 decimals) as a decimal string. */
  amountAtomic: string;
  /** Display only, derived from integer cents (e.g. "250.00"). */
  amountUsd: string;
  merchant: string;
  network: string;
  mint: string;
  /** Estimated network fee in lamports (paid by the customer wallet in SOL), as a decimal string. */
  feeLamports: string;
  /** Unsigned legacy transaction. The customer signs it with their own wallet. */
  unsignedTransactionBase64: string;
  expiresAt: string;
  disclosures: string[];
}

export interface SubmitResult {
  paymentReference: string;
  txSignature: string;
  status: 'SUBMITTED' | 'CONFIRMED' | 'FINALIZED';
  /** True when the identical signed payload had already been submitted. */
  idempotent: boolean;
}

export interface StatusResult {
  orderId: string;
  orderStatus: string;
  payment: null | {
    paymentReference: string;
    status: string;
    amountAtomic: string;
    txSignature: string | null;
    failureReason: string | null;
    finalizedAt: string | null;
  };
  reservation: null | { status: string; amountAtomic: string; expiresAt: string };
}

export type VerifyOutcome = 'FINALIZED' | 'ALREADY_FINALIZED' | 'FAILED' | 'PENDING' | 'TERMINAL' | 'UNKNOWN';

export interface VerifyResult {
  outcome: VerifyOutcome;
  paymentReference?: string;
  orderId?: string;
  /** Failure / pending detail. */
  reason?: string;
  /** For PENDING: 'not_found' (RPC has no such tx) or 'not_finalized'. */
  pendingKind?: 'not_found' | 'not_finalized';
  /** True only for the single call that performed the settlement. */
  settledNow?: boolean;
}

/** Merchant settlement record derived from FINALIZED PURCHASE rows (no dedicated table exists). */
export interface SettlementRecord {
  orderId: string;
  customerId: string;
  paymentReference: string;
  txSignature: string;
  amountAtomic: bigint;
  mint: string;
  network: string;
  sourceAddress: string;
  merchant: string;
  finalizedAt: Date | null;
}

export interface ReconcileSummary {
  checked: number;
  finalized: number;
  failed: number;
  /** Reservations moved to EXPIRED plus purchase rows moved to EXPIRED (never-submitted or never-landed). */
  expired: number;
  unavailable: number;
}
