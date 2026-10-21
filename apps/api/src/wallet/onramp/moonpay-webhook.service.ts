import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { MOONPAY_SOLANA_USDC_CURRENCY_CODE } from './moonpay-onramp.provider';

/**
 * MoonPay BUY webhook processing (events: transaction_created | transaction_updated | transaction_failed).
 *
 * THE INVARIANT: this service never credits, never creates a CryptoTransaction, never marks an order paid and never
 * writes a balance. It touches exactly two tables: OnRampIntent (status + externalReference, so the UI and the admin
 * funding page stop showing CREATED forever) and WalletAuditEvent. It has no chain client and makes no network call.
 * Credits and order payment derive only from the finalized on-chain balance read, never from anything MoonPay says.
 *
 * Delivery is at-least-once and unordered, so ordering is decided by data.updatedAt, not arrival order.
 * "Last processed updatedAt" needs no schema change: every event that is newer than the stored state writes ONE
 * WalletAuditEvent (action MOONPAY_WEBHOOK_PROCESSED) whose detail carries { intentId, moonpayUpdatedAt }; the
 * high-water mark of an intent is the largest moonpayUpdatedAt among such rows (found with a JSON path filter on
 * detail.intentId). Writes are
 * serialised per intent by a row lock (SELECT ... FOR UPDATE) inside one DB transaction, so two concurrent deliveries
 * cannot both pass the "strictly newer" test.
 */
export const MOONPAY_WEBHOOK_EVENT_TYPES = ['transaction_created', 'transaction_updated', 'transaction_failed'] as const;
export type MoonPayWebhookEventType = (typeof MOONPAY_WEBHOOK_EVENT_TYPES)[number];

export const AUDIT_PROCESSED = 'MOONPAY_WEBHOOK_PROCESSED';
export const AUDIT_UNKNOWN_INTENT = 'MOONPAY_WEBHOOK_UNKNOWN_INTENT';
export const AUDIT_MISMATCH = 'MOONPAY_WEBHOOK_MISMATCH';
export const AUDIT_STALE = 'MOONPAY_WEBHOOK_STALE';
/** customerId used on audit rows for events that name no known customer. */
export const UNKNOWN_CUSTOMER_ID = 'unknown';

export type MoonPayBuyStatus = 'waitingPayment' | 'pending' | 'waitingAuthorization' | 'failed' | 'completed';
const BUY_STATUSES: readonly string[] = ['waitingPayment', 'pending', 'waitingAuthorization', 'failed', 'completed'];

export type IntentStatus = 'CREATED' | 'PENDING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';
type MappedStatus = 'PENDING' | 'FAILED' | 'COMPLETED';

/** Signed but structurally unusable payload. The controller answers 400 (visible in MoonPay's delivery log, retried). */
export class InvalidWebhookPayloadError extends Error {}

export interface BuyEvent {
  type: MoonPayWebhookEventType;
  moonpayTransactionId: string;
  updatedAtMs: number;
  updatedAtIso: string;
  /** Raw MoonPay status; may be outside the documented set (then the event is a manual-review mismatch). */
  status: string;
  failureReason: string | null;
  cryptoTransactionId: string | null;
  walletAddress: string | null;
  currencyCode: string | null;
  externalTransactionId: string | null;
  externalCustomerId: string | null;
  /** Top-level envelope externalCustomerId; used only to label audit rows of unknown intents. */
  envelopeCustomerId: string | null;
}

export type WebhookOutcome =
  | { outcome: 'ignored-type' }
  | { outcome: 'unknown-intent' }
  | { outcome: 'mismatch'; reason: string }
  | { outcome: 'duplicate' }
  | { outcome: 'stale' }
  | { outcome: 'processed'; intentId: string; statusBefore: IntentStatus; statusAfter: IntentStatus; changed: boolean };

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const str = (value: unknown, max = 128): string | null => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : null);

/** Validates a signed envelope. Returns null for event types we do not handle (acknowledged, never processed). */
export function parseBuyEvent(body: unknown): BuyEvent | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new InvalidWebhookPayloadError('body must be a JSON object');
  const envelope = body as Record<string, unknown>;
  if (typeof envelope.type !== 'string') throw new InvalidWebhookPayloadError('type is required');
  if (!(MOONPAY_WEBHOOK_EVENT_TYPES as readonly string[]).includes(envelope.type)) return null;

  const data = envelope.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new InvalidWebhookPayloadError('data must be an object');
  const record = data as Record<string, unknown>;
  const id = str(record.id);
  if (!id) throw new InvalidWebhookPayloadError('data.id is required');
  const status = str(record.status, 64);
  if (!status) throw new InvalidWebhookPayloadError('data.status is required');
  const updatedAtMs = typeof record.updatedAt === 'string' ? Date.parse(record.updatedAt) : NaN;
  if (!Number.isFinite(updatedAtMs)) throw new InvalidWebhookPayloadError('data.updatedAt must be an ISO 8601 timestamp');
  const currency = record.currency;
  const currencyCode = typeof currency === 'object' && currency !== null ? str((currency as Record<string, unknown>).code, 32) : null;

  return {
    type: envelope.type as MoonPayWebhookEventType,
    moonpayTransactionId: id,
    updatedAtMs,
    updatedAtIso: new Date(updatedAtMs).toISOString(),
    status,
    failureReason: str(record.failureReason, 64),
    cryptoTransactionId: str(record.cryptoTransactionId, 128),
    walletAddress: str(record.walletAddress, 128),
    currencyCode,
    externalTransactionId: str(record.externalTransactionId, 128),
    externalCustomerId: str(record.externalCustomerId, 128),
    envelopeCustomerId: str(envelope.externalCustomerId, 128),
  };
}

/** Informational mapping of MoonPay's status onto our intent status. Null = status outside the documented set. */
export function mapBuyStatus(status: string): MappedStatus | null {
  if (!BUY_STATUSES.includes(status)) return null;
  if (status === 'completed') return 'COMPLETED';
  if (status === 'failed') return 'FAILED';
  return 'PENDING';
}

export interface Transition {
  status: IntentStatus;
  /** Machine readable note stored on the audit row. */
  note?: string;
  manualReview?: boolean;
}

/**
 * What a (strictly newer) event may do to the local intent status:
 *   CREATED | PENDING : follow MoonPay.
 *   COMPLETED         : never moves backwards (a later "failed" is kept out and flagged for review).
 *   FAILED            : never moves back to pending; a completed event is recorded (funds were delivered) and flagged.
 *   EXPIRED           : our local bookkeeping is kept, EXCEPT for completed (MoonPay may deliver funds for an intent we
 *                       expired): recorded as COMPLETED with a note.
 */
export function decideTransition(current: IntentStatus, next: MappedStatus): Transition {
  switch (current) {
    case 'CREATED':
    case 'PENDING':
      return { status: next };
    case 'COMPLETED':
      return next === 'FAILED' ? { status: 'COMPLETED', note: 'failed-after-completed-ignored', manualReview: true } : { status: 'COMPLETED' };
    case 'FAILED':
      return next === 'COMPLETED' ? { status: 'COMPLETED', note: 'completed-after-failed', manualReview: true } : { status: 'FAILED' };
    case 'EXPIRED':
      return next === 'COMPLETED' ? { status: 'COMPLETED', note: 'completed-after-expiry' } : { status: 'EXPIRED' };
  }
}

type Tx = Prisma.TransactionClient;
type IntentRow = NonNullable<Awaited<ReturnType<Tx['onRampIntent']['findUnique']>>>;

const isUniqueViolation = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';

@Injectable()
export class MoonPayWebhookService {
  private readonly logger = new Logger(MoonPayWebhookService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Applies one verified, parsed event. Throws only for infrastructure failures (the caller answers 5xx and MoonPay retries). */
  async handleEvent(body: unknown): Promise<WebhookOutcome> {
    const event = parseBuyEvent(body);
    if (!event) return { outcome: 'ignored-type' };
    // A unique-constraint race (same MoonPay transaction id claimed by two intents) aborts the transaction; the retry
    // sees the other holder in its pre-check and records a manual-review mismatch instead.
    for (let attempt = 0; ; attempt += 1) {
      try {
        // MoonPay gives up on a delivery after 5 seconds, so the transaction is bounded below that.
        return await this.prisma.$transaction((tx) => this.apply(tx, event), { maxWait: 1500, timeout: 3500 });
      } catch (error) {
        if (attempt === 0 && isUniqueViolation(error)) continue;
        throw error;
      }
    }
  }

  private async apply(tx: Tx, event: BuyEvent): Promise<WebhookOutcome> {
    const intentId = event.externalTransactionId;
    let intent: IntentRow | null = null;
    if (intentId && SAFE_ID.test(intentId)) {
      // Serialise concurrent deliveries for one intent so the "newer than last processed" decision cannot race.
      await tx.$queryRaw`SELECT "id" FROM "OnRampIntent" WHERE "id" = ${intentId} FOR UPDATE`;
      intent = await tx.onRampIntent.findUnique({ where: { id: intentId } });
    }
    if (!intent) {
      await this.auditOnce(tx, event.externalCustomerId ?? event.envelopeCustomerId ?? UNKNOWN_CUSTOMER_ID, AUDIT_UNKNOWN_INTENT, `${event.moonpayTransactionId}|${event.updatedAtIso}`, {
        moonpayTransactionId: event.moonpayTransactionId,
        eventType: event.type,
        moonpayStatus: event.status,
        moonpayUpdatedAt: event.updatedAtIso,
      });
      this.logger.warn(`MoonPay ${event.type} for an unknown on-ramp intent (transaction ${event.moonpayTransactionId}); acknowledged`);
      return { outcome: 'unknown-intent' };
    }

    const mismatch = await this.findMismatch(tx, intent, event);
    if (mismatch) {
      await this.auditOnce(tx, intent.customerId, AUDIT_MISMATCH, `${event.moonpayTransactionId}|${event.updatedAtIso}|${mismatch}`, {
        intentId: intent.id,
        reason: mismatch,
        manualReview: true,
        moonpayTransactionId: event.moonpayTransactionId,
        eventType: event.type,
        moonpayStatus: event.status,
        moonpayUpdatedAt: event.updatedAtIso,
      });
      this.logger.warn(`MoonPay ${event.type} for intent ${intent.id} needs manual review: ${mismatch}; no state changed`);
      return { outcome: 'mismatch', reason: mismatch };
    }

    const lastProcessedMs = await this.lastProcessedUpdatedAt(tx, intent);
    if (lastProcessedMs !== null && event.updatedAtMs <= lastProcessedMs) {
      if (event.updatedAtMs === lastProcessedMs) return { outcome: 'duplicate' };
      await this.auditOnce(tx, intent.customerId, AUDIT_STALE, `${event.moonpayTransactionId}|${event.updatedAtIso}`, {
        intentId: intent.id,
        moonpayTransactionId: event.moonpayTransactionId,
        eventType: event.type,
        moonpayStatus: event.status,
        moonpayUpdatedAt: event.updatedAtIso,
        lastProcessedUpdatedAt: new Date(lastProcessedMs).toISOString(),
      });
      return { outcome: 'stale' };
    }

    const mapped = mapBuyStatus(event.status) as MappedStatus; // findMismatch already rejected unknown statuses
    const before = intent.status as IntentStatus;
    const transition = decideTransition(before, mapped);
    const data: Prisma.OnRampIntentUpdateManyMutationInput = {};
    if (transition.status !== before) data.status = transition.status;
    // First sighting of the MoonPay transaction: remember its id (unique column; conflicts were rejected above).
    if (!intent.externalReference) data.externalReference = event.moonpayTransactionId;
    if (Object.keys(data).length > 0) {
      const updated = await tx.onRampIntent.updateMany({ where: { id: intent.id, status: before }, data });
      if (updated.count !== 1) throw new Error(`On-ramp intent ${intent.id} changed while the webhook was being applied`);
    }

    await tx.walletAuditEvent.create({
      data: {
        customerId: intent.customerId,
        action: AUDIT_PROCESSED,
        detail: {
          intentId: intent.id,
          moonpayTransactionId: event.moonpayTransactionId,
          eventType: event.type,
          moonpayStatus: event.status,
          moonpayUpdatedAt: event.updatedAtIso,
          statusBefore: before,
          statusAfter: transition.status,
          changed: transition.status !== before,
          ...(transition.note ? { note: transition.note } : {}),
          ...(transition.manualReview ? { manualReview: true } : {}),
          ...(event.failureReason ? { failureReason: event.failureReason } : {}),
          ...(event.cryptoTransactionId ? { cryptoTransactionId: event.cryptoTransactionId } : {}),
        },
      },
    });
    this.logger.log(`MoonPay ${event.type} applied to intent ${intent.id}: ${before} -> ${transition.status}`);
    return { outcome: 'processed', intentId: intent.id, statusBefore: before, statusAfter: transition.status, changed: transition.status !== before };
  }

  /** First failed identity/consistency check, or null. Any hit means: no status change, manual-review audit, still HTTP 200. */
  private async findMismatch(tx: Tx, intent: IntentRow, event: BuyEvent): Promise<string | null> {
    if (intent.provider !== 'moonpay') return 'provider-not-moonpay';
    if (event.externalCustomerId !== null && event.externalCustomerId !== intent.customerId) return 'customer-mismatch';
    if (event.walletAddress !== intent.destinationAddress) return 'wallet-mismatch';
    if (event.currencyCode?.toLowerCase() !== MOONPAY_SOLANA_USDC_CURRENCY_CODE) return 'currency-mismatch';
    if (mapBuyStatus(event.status) === null) return 'unrecognised-status';
    if (intent.externalReference && intent.externalReference !== event.moonpayTransactionId) return 'transaction-id-differs';
    if (!intent.externalReference) {
      const holder = await tx.onRampIntent.findUnique({ where: { externalReference: event.moonpayTransactionId } });
      if (holder && holder.id !== intent.id) return 'transaction-id-claimed-by-other-intent';
    }
    return null;
  }

  /**
   * Largest moonpayUpdatedAt (ms) among the MOONPAY_WEBHOOK_PROCESSED events of this intent, or null if none. The maximum
   * is taken over the event payloads, never by row creation time: createdAt is not a reliable ordering across concurrent
   * transactions, and an intent has only a handful of rows (one per newer delivery).
   */
  private async lastProcessedUpdatedAt(tx: Tx, intent: IntentRow): Promise<number | null> {
    const rows = await tx.walletAuditEvent.findMany({
      where: { customerId: intent.customerId, action: AUDIT_PROCESSED, detail: { path: ['intentId'], equals: intent.id } },
    });
    let max: number | null = null;
    for (const row of rows) {
      const stamp = (row.detail as { moonpayUpdatedAt?: unknown } | null)?.moonpayUpdatedAt;
      const ms = typeof stamp === 'string' ? Date.parse(stamp) : NaN;
      if (Number.isFinite(ms) && (max === null || ms > max)) max = ms;
    }
    return max;
  }

  /** Writes an audit row unless an identical delivery already wrote one (MoonPay retries up to 9 times). */
  private async auditOnce(tx: Tx, customerId: string, action: string, dedupeKey: string, detail: Record<string, unknown>) {
    const existing = await tx.walletAuditEvent.findFirst({ where: { customerId, action, detail: { path: ['dedupeKey'], equals: dedupeKey } } });
    if (existing) return;
    await tx.walletAuditEvent.create({ data: { customerId, action, detail: { ...detail, dedupeKey } as Prisma.InputJsonValue } });
  }
}
