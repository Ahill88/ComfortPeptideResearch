export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface DirectoryRow {
  id: string;
  customerId: string;
  email: string;
  address: string;
  provider: string;
  network: string;
  createdAt: string;
}

export interface BalanceRow {
  walletId: string;
  customerId: string;
  email: string;
  address: string;
  network: string;
  snapshot: null | {
    mint: string;
    amountAtomic: string;
    usdcExact: string;
    researchCreditsFloor: string;
    slot: string | null;
    observedAt: string;
  };
}
export interface BalancesResponse extends Page<BalanceRow> {
  label: string;
}

export interface FundingRow {
  id: string;
  email: string;
  provider: string;
  status: string;
  intendedUsdCents: number;
  destinationAddress: string;
  externalReference: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentRow {
  id: string;
  orderId: string;
  provider: string;
  status: string;
  amountAtomic: string;
  currency: string;
  walletAddress: string | null;
  txSignature: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface TransactionRow {
  id: string;
  customerId: string;
  type: string;
  status: string;
  amountAtomic: string;
  usdcExact: string;
  feeLamports: string | null;
  sourceAddress: string;
  destinationAddress: string;
  mint: string;
  network: string;
  reference: string;
  orderId: string | null;
  txSignature: string | null;
  failureReason: string | null;
  createdAt: string;
  finalizedAt: string | null;
}

export interface PaymentIntentsResponse {
  payments: Page<PaymentRow>;
  cryptoPurchases: Page<TransactionRow>;
}

export interface PendingOrderRow {
  id: string;
  customerId: string;
  email: string;
  status: string;
  totalCents: number;
  currency: string;
  createdAt: string;
  payment: null | { status: string; provider: string; expiresAt: string };
  creditReservation: null | { status: string; amountAtomic: string; expiresAt: string };
}

export interface SettlementDay {
  day: string;
  count: string;
  totalAtomic: string;
  totalUsdcExact: string;
}
export interface SettlementsResponse extends Page<SettlementDay> {
  allTime: { count: string; totalAtomic: string; totalUsdcExact: string };
}

export interface ReconciliationResponse {
  counts: Record<string, number>;
  oldestSubmitted: null | { id: string; createdAt: string; txSignature: string | null; type: string; ageSeconds: number | null };
}

export interface ProvidersResponse {
  privy: { status: string };
  moonpay: { mode: 'real' | 'sandbox'; realRequested: boolean; publishableKeyConfigured: boolean };
  solana: { network: string; walletChainMode: string };
  featureFlags: Record<string, boolean>;
}
