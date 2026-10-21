/**
 * Browser client for the wallet API. Sandbox identity is the x-customer-email header.
 * Private keys are never an input to any function in this file.
 * All bigint values cross the wire as decimal STRINGS.
 */
import { toAtomic } from './credits';

export const API_BASE_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/v1').replace(/\/+$/, '');

export class WalletApiError extends Error {
  constructor(message: string, readonly status: number | null, readonly unavailable: boolean) {
    super(message);
    this.name = 'WalletApiError';
  }
}

export const SERVICE_UNAVAILABLE_MESSAGE = 'Wallet service unavailable';

type RequestOptions = { method?: 'GET' | 'POST'; email?: string | null; body?: unknown; signal?: AbortSignal; headers?: Record<string, string> };

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
  if (options.email) headers['x-customer-email'] = options.email;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new WalletApiError(SERVICE_UNAVAILABLE_MESSAGE, null, true);
  }
  const text = await response.text();
  let parsed: unknown = null;
  if (text) { try { parsed = JSON.parse(text); } catch { parsed = null; } }
  if (!response.ok) {
    const unavailable = response.status >= 500 || (response.status === 404 && parsed === null);
    const raw = parsed && typeof parsed === 'object' ? (parsed as { message?: unknown }).message : null;
    const message = Array.isArray(raw) ? raw.join(' ') : typeof raw === 'string' ? raw : unavailable ? SERVICE_UNAVAILABLE_MESSAGE : `Request failed (${response.status}).`;
    throw new WalletApiError(message, response.status, unavailable);
  }
  return parsed as T;
}

export function errorMessage(error: unknown, fallback = 'Something went wrong.'): string {
  if (error instanceof WalletApiError) return error.message;
  return error instanceof Error ? error.message : fallback;
}

/* ----------------------------- types ----------------------------- */

export type WalletRecord = { address: string; provider: string };
export type WalletBalance = { finalizedAtomic: bigint; spendableAtomic: bigint; researchCredits: bigint; stale: boolean };

export type WalletTransactionStatus = 'pending' | 'finalized' | 'failed' | 'unknown';
export type WalletTransaction = {
  id: string;
  type: string;
  status: WalletTransactionStatus;
  rawStatus: string;
  amountAtomic: bigint | null;
  signature: string | null;
  counterparty: string | null;
  reference: string | null;
  createdAt: string | null;
};

export type OnrampQuote = {
  provider: string;
  sandbox: boolean;
  widgetUrl: string;
  estimatedFeeUsdCents: number | null;
  estimatedUsdcAtomic: bigint | null;
  disclosures: string[];
  intentId: string;
};

/** POST /wallet/onramp/order-topup: either nothing is needed, or a card/bank top-up covering the shortfall for this order. */
export type OrderTopUp =
  | { topUpNeeded: false; orderId: string; requiredAtomic: bigint; spendableAtomic: bigint }
  | {
    topUpNeeded: true;
    orderId: string;
    intentId: string;
    requiredAtomic: bigint;
    spendableAtomic: bigint;
    shortfallAtomic: bigint;
    topUpUsdCents: number;
    quote: OnrampQuote;
    status: 'CREATED' | 'PENDING';
    /** Merchant payment address, only if the API volunteers it. The contract does not require it. */
    merchant: string | null;
  };

export type TransferPreparation = { id: string; unsignedTransactionBase64: string; feeLamports: bigint | null; amountAtomic: bigint; warnings: string[] };
export type TransferSubmission = { signature: string; status: string };

export type CheckoutPreparation = {
  paymentReference: string;
  amountAtomic: bigint;
  amountUsd: string | null;
  merchant: string;
  network: string;
  feeLamports: bigint | null;
  /** Base58 of the account that pays the network fee. null when the API did not say (older API): the customer pays, exactly as before. */
  feePayer: string | null;
  /** True when the platform pays the Solana network fee (the transaction then has two signers: platform fee payer, then the customer). false when omitted. */
  feeSponsored: boolean;
  unsignedTransactionBase64: string;
  expiresAt: string | null;
  disclosures: string[];
};
export type CheckoutPhase = 'awaiting' | 'submitted' | 'finalized' | 'failed';
export type CheckoutStatus = { phase: CheckoutPhase; rawStatus: string; signature: string | null };

/* --------------------------- normalizers --------------------------- */

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {});
const asString = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const asStrings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
const asCents = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);
const malformed = () => new WalletApiError('Wallet service returned an unexpected response.', null, true);

function requireString(value: unknown): string {
  const s = asString(value);
  if (!s) throw malformed();
  return s;
}
function requireAtomic(value: unknown): bigint {
  const n = typeof value === 'string' || typeof value === 'bigint' ? toAtomic(value) : null;
  if (n === null || n < 0n) throw malformed();
  return n;
}
function optionalAtomic(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'string' || typeof value === 'bigint' ? toAtomic(value) : typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : null;
  return n !== null && n >= 0n ? n : null;
}

export function normalizeBalance(raw: unknown): WalletBalance {
  const r = asRecord(raw);
  const finalizedAtomic = requireAtomic(r.finalizedAtomic);
  const spendableAtomic = requireAtomic(r.spendableAtomic);
  return { finalizedAtomic, spendableAtomic, researchCredits: spendableAtomic / 1_000_000n, stale: r.stale === true };
}

export function normalizeOrderTopUp(raw: unknown): OrderTopUp {
  const r = asRecord(raw);
  const orderId = requireString(r.orderId);
  const requiredAtomic = requireAtomic(r.requiredAtomic);
  const spendableAtomic = requireAtomic(r.spendableAtomic);
  if (r.topUpNeeded === false) return { topUpNeeded: false, orderId, requiredAtomic, spendableAtomic };
  if (r.topUpNeeded !== true) throw malformed();
  const shortfallAtomic = requireAtomic(r.shortfallAtomic);
  const topUpUsdCents = asCents(r.topUpUsdCents);
  // A top-up that is needed must have a positive shortfall and a positive amount; anything else is not safe to show as an offer.
  if (shortfallAtomic <= 0n || topUpUsdCents === null || topUpUsdCents <= 0) throw malformed();
  const intentId = requireString(r.intentId);
  const quote = asRecord(r.quote);
  const status = asString(r.status);
  return {
    topUpNeeded: true,
    orderId,
    intentId,
    requiredAtomic,
    spendableAtomic,
    shortfallAtomic,
    topUpUsdCents,
    quote: {
      provider: asString(quote.provider) ?? 'moonpay',
      sandbox: quote.sandbox === true,
      widgetUrl: asString(quote.widgetUrl) ?? '',
      estimatedFeeUsdCents: asCents(quote.estimatedFeeUsdCents),
      estimatedUsdcAtomic: optionalAtomic(quote.estimatedUsdcAtomic),
      disclosures: asStrings(quote.disclosures),
      intentId,
    },
    status: status === 'PENDING' ? 'PENDING' : 'CREATED',
    merchant: asString(r.merchant),
  };
}

export function normalizeTransactionStatus(raw: string): WalletTransactionStatus {
  const s = raw.toLowerCase();
  if (['finalized', 'completed', 'complete', 'succeeded', 'success', 'paid'].includes(s)) return 'finalized';
  if (['pending', 'submitted', 'confirmed', 'processing', 'created', 'awaiting', 'broadcast'].includes(s)) return 'pending';
  if (['failed', 'expired', 'rejected', 'cancelled', 'canceled', 'error'].includes(s)) return 'failed';
  return 'unknown';
}

export function normalizeTransactions(raw: unknown): WalletTransaction[] {
  const r = asRecord(raw);
  const list = Array.isArray(raw) ? raw : Array.isArray(r.transactions) ? r.transactions : Array.isArray(r.items) ? r.items : Array.isArray(r.data) ? r.data : null;
  if (!list) throw malformed();
  return list.map((entry, index) => {
    const e = asRecord(entry);
    const rawStatus = asString(e.status) ?? 'unknown';
    const type = (asString(e.type) ?? asString(e.kind) ?? 'UNKNOWN').toUpperCase();
    // API rows carry sourceAddress/destinationAddress and txSignature. The counterparty is the other party:
    // for incoming funds (deposits, refunds) it is the source, otherwise the destination.
    const incoming = type === 'DEPOSIT' || type === 'REFUND';
    const signature = asString(e.txSignature) ?? asString(e.signature);
    return {
      id: asString(e.id) ?? signature ?? `tx-${index}`,
      type,
      status: normalizeTransactionStatus(rawStatus),
      rawStatus,
      amountAtomic: optionalAtomic(e.amountAtomic),
      signature,
      counterparty: incoming
        ? asString(e.sourceAddress) ?? asString(e.source) ?? asString(e.counterparty)
        : asString(e.destinationAddress) ?? asString(e.destination) ?? asString(e.counterparty),
      reference: asString(e.orderId) ?? asString(e.reference) ?? asString(e.paymentReference),
      createdAt: asString(e.createdAt),
    };
  });
}

/* ----------------------------- calls ----------------------------- */

export type LinkChallenge = { message: string; expiresAt: string; challenge: string };

const LINK_MESSAGE_LINES = /^Helix & Field wallet link\nAccount: ([^\n]+)\nAddress: ([^\n]+)\nNonce: ([^\n]+)\nExpires: ([^\n]+)$/;

/** Step 1 of linking: asks the API for a short-lived challenge bound to this account and PUBLIC address. */
export async function fetchLinkChallenge(email: string, address: string): Promise<LinkChallenge> {
  const r = asRecord(await apiRequest('/wallet/link-challenge', { method: 'POST', email, body: { address } }));
  return { message: requireString(r.message), expiresAt: requireString(r.expiresAt), challenge: requireString(r.challenge) };
}

/**
 * Links this wallet to the account with proof of key control: challenge -> sign locally -> register.
 * `signMessage` signs with the wallet's own key in the caller's process (see WalletSigner.signMessage) and returns the
 * base64 detached ed25519 signature. Only that signature is sent; private keys are never an input here.
 */
export async function registerWallet(
  email: string,
  address: string,
  provider: string,
  signMessage: (message: string) => Promise<string> | string,
): Promise<void> {
  const { message, challenge } = await fetchLinkChallenge(email, address);
  // Never sign text the service chose without checking it is exactly the link statement for THIS account and address.
  const parts = LINK_MESSAGE_LINES.exec(message);
  if (!parts || parts[1] !== email.trim().toLowerCase() || parts[2] !== address) throw malformed();
  const signature = await signMessage(message);
  await apiRequest('/wallet', { method: 'POST', email, body: { address, provider, challenge, signature } });
}

export async function fetchWallet(email: string): Promise<WalletRecord | null> {
  try {
    // API contract: GET /wallet -> { wallet: { address, provider, network, createdAt }, provider: <descriptor> }
    const r = asRecord(await apiRequest('/wallet', { email }));
    const wallet = asRecord(r.wallet);
    const address = asString(wallet.address) ?? asString(r.address);
    return address ? { address, provider: asString(wallet.provider) ?? 'unknown' } : null;
  } catch (error) {
    if (error instanceof WalletApiError && error.status === 404) return null;
    throw error;
  }
}

export async function fetchBalance(email: string, signal?: AbortSignal): Promise<WalletBalance> {
  return normalizeBalance(await apiRequest('/wallet/balance', { email, signal }));
}

export async function fetchTransactions(email: string, signal?: AbortSignal): Promise<WalletTransaction[]> {
  return normalizeTransactions(await apiRequest('/wallet/transactions', { email, signal }));
}

export async function createOnrampQuote(email: string, usdAmountCents: number): Promise<OnrampQuote> {
  // API contract: POST /wallet/onramp { amountUsdCents } -> { intentId, status, quote: { provider, sandbox, widgetUrl, ... } }
  const r = asRecord(await apiRequest('/wallet/onramp', { method: 'POST', email, body: { amountUsdCents: usdAmountCents } }));
  const quote = asRecord(r.quote);
  return {
    provider: asString(quote.provider) ?? 'moonpay',
    sandbox: quote.sandbox === true,
    widgetUrl: asString(quote.widgetUrl) ?? '',
    estimatedFeeUsdCents: asCents(quote.estimatedFeeUsdCents),
    estimatedUsdcAtomic: optionalAtomic(quote.estimatedUsdcAtomic),
    disclosures: asStrings(quote.disclosures),
    intentId: requireString(r.intentId),
  };
}

/**
 * Asks the API whether this customer can pay this order now, and if not, for a card/bank top-up quote sized to the shortfall.
 * Contract: POST /wallet/onramp/order-topup { orderId }. Requesting a quote moves no money.
 */
export async function createOrderTopUp(email: string, orderId: string): Promise<OrderTopUp> {
  const topUp = normalizeOrderTopUp(await apiRequest('/wallet/onramp/order-topup', { method: 'POST', email, body: { orderId } }));
  if (topUp.orderId !== orderId) throw malformed();
  return topUp;
}

export async function mockCompleteOnramp(email: string, intentId: string): Promise<void> {
  await apiRequest(`/wallet/onramp/${encodeURIComponent(intentId)}/mock-complete`, { method: 'POST', email, body: {} });
}

export async function prepareTransfer(email: string, input: { destination: string; amountAtomic?: bigint; max?: boolean }): Promise<TransferPreparation> {
  const body = input.max ? { destination: input.destination, max: true } : { destination: input.destination, amountAtomic: (input.amountAtomic ?? 0n).toString() };
  // API contract: { transactionId, unsignedTransaction, amountAtomic, fee: { estimatedTotalLamports, ... }, warnings }
  const r = asRecord(await apiRequest('/wallet/transfers/prepare', { method: 'POST', email, body }));
  const fee = asRecord(r.fee);
  return {
    id: requireString(r.transactionId),
    unsignedTransactionBase64: requireString(r.unsignedTransaction),
    feeLamports: optionalAtomic(fee.estimatedTotalLamports),
    amountAtomic: requireAtomic(r.amountAtomic),
    warnings: asStrings(r.warnings),
  };
}

export async function submitTransfer(email: string, id: string, signedTransactionBase64: string): Promise<TransferSubmission> {
  // API contract: POST /wallet/transfers/:id/submit { signedTransaction } -> { id, status, txSignature, ... }
  const r = asRecord(await apiRequest(`/wallet/transfers/${encodeURIComponent(id)}/submit`, { method: 'POST', email, body: { signedTransaction: signedTransactionBase64 } }));
  return { signature: requireString(r.txSignature), status: asString(r.status) ?? 'SUBMITTED' };
}

/** POST /wallet/checkout/:orderId/prepare response -> CheckoutPreparation. Missing feePayer/feeSponsored mean "the customer pays" (old API). */
export function normalizeCheckoutPreparation(raw: unknown): CheckoutPreparation {
  const r = asRecord(raw);
  const usd = r.amountUsd;
  return {
    paymentReference: requireString(r.paymentReference),
    amountAtomic: requireAtomic(r.amountAtomic),
    amountUsd: typeof usd === 'string' ? usd : typeof usd === 'number' ? String(usd) : null,
    merchant: requireString(r.merchant),
    network: asString(r.network) ?? 'unknown',
    feeLamports: optionalAtomic(r.feeLamports),
    feePayer: asString(r.feePayer),
    feeSponsored: r.feeSponsored === true,
    unsignedTransactionBase64: requireString(r.unsignedTransactionBase64),
    expiresAt: asString(r.expiresAt),
    disclosures: asStrings(r.disclosures),
  };
}

export async function prepareCheckout(email: string, orderId: string): Promise<CheckoutPreparation> {
  return normalizeCheckoutPreparation(await apiRequest(`/wallet/checkout/${encodeURIComponent(orderId)}/prepare`, { method: 'POST', email, body: {} }));
}

export async function submitCheckout(email: string, orderId: string, signedTransactionBase64: string): Promise<void> {
  await apiRequest(`/wallet/checkout/${encodeURIComponent(orderId)}/submit`, { method: 'POST', email, body: { signedTransactionBase64 } });
}

/**
 * Maps GET /wallet/checkout/:orderId/status to a UI phase.
 * API shape: { orderId, orderStatus, payment: { status, txSignature, ... } | null, reservation }.
 * ONLY an order the backend reports as PAID (set after on-chain finality) yields 'finalized'. A Solana
 * "submitted" or "confirmed" payment is still in progress and is deliberately NOT treated as paid.
 */
export function normalizeCheckoutStatus(raw: unknown): CheckoutStatus {
  const r = asRecord(raw);
  const payment = asRecord(r.payment);
  const lower = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : null);
  const orderStatus = lower(r.orderStatus);
  const paymentStatus = lower(payment.status);
  const rawStatus = paymentStatus ?? orderStatus ?? 'unknown';
  const signature = asString(payment.txSignature);
  if (orderStatus !== null && ['paid', 'processing', 'shipped', 'delivered'].includes(orderStatus)) return { phase: 'finalized', rawStatus: orderStatus, signature };
  if ((paymentStatus !== null && ['failed', 'expired'].includes(paymentStatus)) || (orderStatus !== null && ['cancelled', 'refunded'].includes(orderStatus))) return { phase: 'failed', rawStatus, signature };
  if (paymentStatus !== null && ['submitted', 'confirmed', 'finalized'].includes(paymentStatus)) return { phase: 'submitted', rawStatus, signature };
  return { phase: 'awaiting', rawStatus, signature };
}

export async function fetchCheckoutStatus(email: string, orderId: string, signal?: AbortSignal): Promise<CheckoutStatus> {
  return normalizeCheckoutStatus(await apiRequest(`/wallet/checkout/${encodeURIComponent(orderId)}/status`, { email, signal }));
}
