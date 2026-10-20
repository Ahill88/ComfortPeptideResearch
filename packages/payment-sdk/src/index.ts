/** Provider-neutral payment lifecycle. Settlement is permitted only from PROCESSING. */
export type PaymentStatus =
  | 'CREATED'
  | 'PENDING'
  | 'PROCESSING'
  | 'SETTLED'
  | 'FAILED'
  | 'EXPIRED'
  | 'REFUNDED'
  | 'DISPUTED';

const transitions: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  CREATED: ['PENDING', 'FAILED', 'EXPIRED'],
  PENDING: ['PROCESSING', 'FAILED', 'EXPIRED'],
  PROCESSING: ['SETTLED', 'FAILED', 'EXPIRED'],
  SETTLED: ['REFUNDED', 'DISPUTED'],
  FAILED: [],
  EXPIRED: [],
  REFUNDED: [],
  DISPUTED: ['SETTLED', 'REFUNDED'],
};

export function canTransitionPayment(
  from: PaymentStatus,
  to: PaymentStatus,
): boolean {
  return transitions[from].includes(to);
}

export function assertPaymentTransition(
  from: PaymentStatus,
  to: PaymentStatus,
): void {
  if (!canTransitionPayment(from, to)) {
    throw new Error(`Invalid payment transition: ${from} -> ${to}`);
  }
}

export type PaymentIntentRequest = {
  orderId: string;
  amountMinor: bigint;
  currency: 'USD' | 'USDC';
  /** A stable, caller-generated key. Reuse must return the original intent. */
  idempotencyKey: string;
};

export type PaymentIntent = {
  providerReference: string;
  status: PaymentStatus;
};

/** Produced only by a provider's trusted verifier, never directly from an API request. */
export type VerifiedSettlement = {
  providerReference: string;
  verifiedAt: Date;
  providerTransactionId: string;
  amountMinor: bigint;
  currency: string;
};

export interface PaymentProvider {
  createIntent(request: PaymentIntentRequest): Promise<PaymentIntent>;
  getStatus(providerReference: string): Promise<PaymentStatus>;
  /** This method must reject anything other than provider-verified settlement evidence. */
  confirmSettlement(settlement: VerifiedSettlement): Promise<PaymentStatus>;
  cancel(providerReference: string): Promise<void>;
  refund(providerReference: string, amountMinor: bigint): Promise<void>;
  reconcile(since: Date): Promise<void>;
}
