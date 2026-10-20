export type RefundOutcome = 'FINALIZED' | 'ALREADY_FINALIZED' | 'PENDING' | 'FAILED' | 'TERMINAL';

/** Serialized refund row. Amounts are decimal strings of USDC base units (6 decimals). */
export interface RefundView {
  refundId: string;
  orderId: string;
  customerId: string;
  reference: string;
  status: string;
  amountAtomic: string;
  /** Merchant treasury owner (transfer source). */
  source: string;
  /** Customer's own wallet (transfer destination), derived server-side from the original purchase. */
  destination: string;
  mint: string;
  network: string;
  txSignature: string | null;
  failureReason: string | null;
  createdAt: string;
  finalizedAt: string | null;
}

export interface VerifyRefundResult {
  refund: RefundView;
  outcome: RefundOutcome;
  reason?: string;
  /** True only on the single call that moved the order to REFUNDED. */
  orderRefunded: boolean;
}
