import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { CoaAnchor } from '@prisma/client';
import { PublicKey } from '@solana/web3.js';
import { PrismaService } from '../../prisma.service';
import { base58Encode } from '../../wallet/chain/base58';
import { buildCoaMemo, type CoaAnchorKindName, type CoaAnchorPort } from '../coa.types';
import { COA_ANCHOR_CONFIG, type CoaAnchorConfig } from './coa-anchor.config';
import { COA_ANCHOR_CHAIN, CoaAnchorRejectedError, type CoaAnchorChain, type CoaAnchorTxView } from './coa-anchor-chain';
import { assertMemoOnlyMessage, buildMemoTransaction, checkAnchorBody, coaExplorerTxUrl } from './coa-anchor-message';
import { COA_PUBLISHER_SIGNER, type CoaPublisherSigner, requestCoaPublisherSignature } from './coa-publisher-signer.port';

/** A PENDING anchor with no signature, or whose signature the chain does not know, is re-attempted after this long (a blockhash lives about 1-2 minutes). */
export const ANCHOR_STALE_MS = 10 * 60_000;
/** Attempts (builds of a transaction) per anchor before it is marked FAILED "gave up". */
export const ANCHOR_MAX_ATTEMPTS = 5;
export const NO_SIGNER_ERROR = 'COA anchoring is unavailable: no publisher signer is bound';
const SWEEP_BATCH = 100;

export type AnchorRetryRefusal = 'DISABLED' | 'NO_SIGNER' | 'NOT_FOUND' | 'NOT_ELIGIBLE' | 'ALREADY_CONFIRMED' | 'IN_FLIGHT' | 'CHAIN_UNAVAILABLE';

/** Thrown by retry() only. The admin route maps `reason`: NOT_FOUND -> 404, ALREADY_CONFIRMED/IN_FLIGHT/NOT_ELIGIBLE -> 409, others -> 503/409. */
export class CoaAnchorRefusedError extends Error {
  constructor(readonly reason: AnchorRetryRefusal, message: string) {
    super(message);
    this.name = 'CoaAnchorRefusedError';
  }
}

export interface AnchorSnapshot {
  id: string;
  coaId: string;
  kind: CoaAnchorKindName;
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';
  memo: string;
  network: string;
  txSignature: string | null;
  slot: number | null;
  blockTime: Date | null;
  attempts: number;
  error: string | null;
  /** null unless there is a transaction signature. */
  explorerUrl: string | null;
}

export interface AnchorSweepSummary {
  checked: number;
  confirmed: number;
  failed: number;
  rebroadcast: number;
  unavailable: number;
}

type AnchorRow = CoaAnchor;

const isUniqueViolation = (error: unknown) => typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';

/** One short line, no URLs (an RPC error can carry an endpoint with an API key), bounded length. */
export function shortError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (text.split('\n')[0] ?? '').replace(/https?:\/\/\S+/gi, '[url]').trim().slice(0, 240) || 'unknown error';
}

/**
 * On-chain anchoring of COA hashes (docs/api/coa-anchoring.md). Implements the port the COA core calls after publish/revoke.
 *
 * Invariants:
 *  - never throws from requestAnchor / reconcile (anchoring is fail-soft); retry() throws only CoaAnchorRefusedError for operator-facing refusals;
 *  - one CoaAnchor row per (coa, kind) (DB unique); calls for the same key are serialized in-process and race-safe across processes
 *    (P2002 on create; compare-and-set on `attempts` before each attempt and on `txSignature IS NULL` before recording a signature);
 *  - the signature is persisted BEFORE broadcasting. Rejected by the cluster => FAILED (nothing can land). Anything else (timeout,
 *    RPC outage) => stays PENDING WITH the signature; only the reconciler decides, after reading the chain;
 *  - CONFIRMED only after the finalized transaction re-read from chain equals the exact anchor shape for the expected memo and publisher;
 *  - a signature unknown to the chain is only re-broadcast after ANCHOR_STALE_MS, and only after the lookup answered "not found".
 */
@Injectable()
export class AnchorService implements CoaAnchorPort {
  private readonly logger = new Logger(AnchorService.name);
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(COA_ANCHOR_CONFIG) private readonly config: CoaAnchorConfig,
    @Inject(COA_ANCHOR_CHAIN) private readonly chain: CoaAnchorChain,
    @Optional() @Inject(COA_PUBLISHER_SIGNER) private readonly signer?: CoaPublisherSigner,
  ) {}

  /** CoaAnchorPort. Idempotent per (coaId, kind); never throws. */
  async requestAnchor(input: { coaId: string; kind: CoaAnchorKindName }): Promise<void> {
    try {
      if (!this.config.enabled) return;
      await this.serialized(`${input.coaId}:${input.kind}`, () => this.requestLocked(input.coaId, input.kind));
    } catch (error) {
      this.logger.error(`Anchor request failed for coa ${input.coaId} (${input.kind}): ${shortError(error)}`);
    }
  }

  /** Current state of an anchor, for callers and tests. */
  async snapshot(coaId: string, kind: CoaAnchorKindName): Promise<AnchorSnapshot | null> {
    const row = await this.prisma.coaAnchor.findUnique({ where: { coaId_kind: { coaId, kind } } });
    return row ? this.toSnapshot(row) : null;
  }

  /**
   * Operator retry (POST /admin/coas/:id/anchor/retry). Refuses (CoaAnchorRefusedError) for a CONFIRMED anchor, for anything
   * ineligible, and for a transaction that may still land. A FAILED/stuck anchor whose old signature is found on chain is re-verified
   * first (it may simply confirm); only a signature the chain does not know (after ANCHOR_STALE_MS) or a transaction that definitively
   * failed is reset and attempted again.
   */
  async retry(coaId: string, kind: CoaAnchorKindName, now: Date = new Date()): Promise<AnchorSnapshot> {
    return this.serialized(`${coaId}:${kind}`, () => this.retryLocked(coaId, kind, now));
  }

  /** Re-reads the chain for one anchor and updates it (CONFIRMED / FAILED / unchanged). Never throws. */
  async verifyAnchor(anchorId: string, now: Date = new Date()): Promise<AnchorSnapshot | null> {
    try {
      const row = await this.prisma.coaAnchor.findUnique({ where: { id: anchorId } });
      if (!row) return null;
      return await this.serialized(`${row.coaId}:${row.kind}`, async () => {
        const fresh = await this.prisma.coaAnchor.findUnique({ where: { id: anchorId } });
        return fresh ? await this.verifyLocked(fresh, now) : null;
      });
    } catch (error) {
      this.logger.error(`Anchor verification failed for ${anchorId}: ${shortError(error)}`);
      return null;
    }
  }

  /** One sweep over PENDING anchors. Safe to run concurrently and repeatedly. */
  async reconcile(now: Date = new Date()): Promise<AnchorSweepSummary> {
    const summary: AnchorSweepSummary = { checked: 0, confirmed: 0, failed: 0, rebroadcast: 0, unavailable: 0 };
    const rows = await this.prisma.coaAnchor.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: SWEEP_BATCH });
    for (const row of rows) {
      summary.checked++;
      try {
        await this.serialized(`${row.coaId}:${row.kind}`, async () => {
          const fresh = await this.prisma.coaAnchor.findUnique({ where: { id: row.id } });
          if (!fresh || fresh.status !== 'PENDING') return;
          const result = fresh.txSignature ? await this.verifyLocked(fresh, now, summary) : await this.sweepUnsigned(fresh, now, summary);
          if (result?.status === 'CONFIRMED') summary.confirmed++;
          else if (result?.status === 'FAILED') summary.failed++;
        });
      } catch (error) {
        this.logger.error(`Anchor sweep failed for ${row.id}: ${shortError(error)}`);
      }
    }
    return summary;
  }

  // ---- request / retry ----------------------------------------------------

  private async requestLocked(coaId: string, kind: CoaAnchorKindName): Promise<AnchorSnapshot | null> {
    const prepared = await this.prepare(coaId, kind);
    if (!prepared) return null;
    const { row, memo } = prepared;
    // Already settled, or a transaction exists: only the reconciler decides from here (never a second transaction).
    if (row.status !== 'PENDING' || row.txSignature) return this.toSnapshot(row);
    return this.attempt(row, memo);
  }

  private async retryLocked(coaId: string, kind: CoaAnchorKindName, now: Date): Promise<AnchorSnapshot> {
    if (!this.config.enabled) throw new CoaAnchorRefusedError('DISABLED', 'COA anchoring is not enabled (COA_ANCHOR_ENABLED).');
    if (!this.signer) throw new CoaAnchorRefusedError('NO_SIGNER', NO_SIGNER_ERROR + '.');
    const prepared = await this.prepare(coaId, kind, true);
    if (!prepared) throw new CoaAnchorRefusedError('NOT_FOUND', 'COA not found.');
    let { row } = prepared;
    const { memo } = prepared;
    if (row.status === 'CONFIRMED') throw new CoaAnchorRefusedError('ALREADY_CONFIRMED', 'The anchor is already confirmed on chain.');

    if (row.txSignature) {
      let view: CoaAnchorTxView | null;
      try {
        view = await this.chain.getTransaction(row.txSignature);
      } catch (error) {
        throw new CoaAnchorRefusedError('CHAIN_UNAVAILABLE', `Could not read the chain, so the old transaction cannot be ruled out: ${shortError(error)}`);
      }
      if (view) {
        // It landed (or is landing): decide from the chain, not from the old state.
        if (!view.finalized) throw new CoaAnchorRefusedError('IN_FLIGHT', 'The transaction is on chain but not finalized yet; wait for verification.');
        const verified = await this.applyView(row, view, memo);
        if (verified.status === 'CONFIRMED') return verified;
        row = (await this.prisma.coaAnchor.findUnique({ where: { id: row.id } })) ?? row; // landed but wrong or failed: safe to send a new one
      } else if (row.updatedAt.getTime() > now.getTime() - ANCHOR_STALE_MS) {
        throw new CoaAnchorRefusedError('IN_FLIGHT', 'The transaction was sent less than 10 minutes ago and may still land; try again later.');
      }
    }
    const reset = await this.prisma.coaAnchor.updateMany({
      where: { id: row.id, status: { in: ['PENDING', 'FAILED'] }, txSignature: row.txSignature },
      data: { status: 'PENDING', txSignature: null, attempts: 0, error: null, slot: null, blockTime: null, memo, network: this.config.network },
    });
    if (reset.count !== 1) throw new CoaAnchorRefusedError('IN_FLIGHT', 'The anchor changed while retrying; refresh and try again.');
    const fresh = await this.prisma.coaAnchor.findUnique({ where: { id: row.id } });
    if (!fresh) throw new CoaAnchorRefusedError('NOT_FOUND', 'Anchor not found.');
    return this.attempt(fresh, memo);
  }

  /** Loads the coa, checks eligibility and returns the (possibly new) anchor row with its expected memo. Null = nothing to anchor. */
  private async prepare(coaId: string, kind: CoaAnchorKindName, forRetry = false): Promise<{ row: AnchorRow; memo: string } | null> {
    const coa = await this.prisma.coa.findUnique({ where: { id: coaId }, include: { lot: true } });
    if (!coa) {
      if (!forRetry) this.logger.warn(`Anchor requested for unknown coa ${coaId}`);
      return null;
    }
    // PUBLISH: the coa is, or was, published (a superseded or later revoked version keeps its publish anchor). REVOKE: only a revoked coa.
    const eligible = kind === 'PUBLISH' ? (coa.status === 'PUBLISHED' || coa.status === 'SUPERSEDED' || (coa.status === 'REVOKED' && coa.publishedAt !== null)) : coa.status === 'REVOKED';
    if (!eligible) {
      const message = `COA ${coaId} (${coa.status}) is not eligible for a ${kind} anchor`;
      if (forRetry) throw new CoaAnchorRefusedError('NOT_ELIGIBLE', message + '.');
      this.logger.warn(message);
      return null;
    }
    let memo: string;
    try {
      memo = buildCoaMemo(kind, coa.lot.code, coa.version, coa.fileSha256);
    } catch (error) {
      if (forRetry) throw new CoaAnchorRefusedError('NOT_ELIGIBLE', `This COA cannot be anchored: ${shortError(error)}`);
      this.logger.warn(`COA ${coaId} cannot be anchored: ${shortError(error)}`);
      return null;
    }
    let row = await this.prisma.coaAnchor.findUnique({ where: { coaId_kind: { coaId, kind } } });
    if (!row) {
      try {
        row = await this.prisma.coaAnchor.create({
          data: { coaId, kind, memo, network: this.config.network, status: 'PENDING', ...(this.signer ? {} : { error: NO_SIGNER_ERROR }) },
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        row = await this.prisma.coaAnchor.findUnique({ where: { coaId_kind: { coaId, kind } } });
        if (!row) throw error;
      }
    } else if (row.status === 'PENDING' && !row.txSignature && row.memo !== memo) {
      await this.prisma.coaAnchor.updateMany({ where: { id: row.id, status: 'PENDING', txSignature: null }, data: { memo } });
      row = (await this.prisma.coaAnchor.findUnique({ where: { id: row.id } })) ?? row;
    }
    return { row, memo };
  }

  // ---- one broadcast attempt ---------------------------------------------

  private async attempt(row: AnchorRow, memo: string): Promise<AnchorSnapshot> {
    const signer = this.signer;
    if (!signer) {
      if (row.error !== NO_SIGNER_ERROR) await this.prisma.coaAnchor.updateMany({ where: { id: row.id, status: 'PENDING' }, data: { error: NO_SIGNER_ERROR } });
      return this.reload(row);
    }
    // Compare-and-set on `attempts`: of several processes racing on the same row only one gets to build a transaction.
    const begun = await this.prisma.coaAnchor.updateMany({
      where: { id: row.id, status: 'PENDING', txSignature: null, attempts: row.attempts },
      data: { attempts: row.attempts + 1, memo, network: this.config.network, error: null },
    });
    if (begun.count !== 1) return this.reload(row);

    const note = async (error: string) => {
      await this.prisma.coaAnchor.updateMany({ where: { id: row.id, status: 'PENDING', txSignature: null }, data: { error } });
      return this.reload(row);
    };
    let publisher: PublicKey;
    try {
      publisher = new PublicKey(signer.publicKey);
    } catch {
      return note('COA publisher signer has an invalid public key');
    }
    let blockhash: string;
    try {
      blockhash = (await this.chain.getLatestBlockhash()).blockhash;
    } catch (error) {
      return note(`Solana RPC unavailable: ${shortError(error)}`);
    }
    const tx = buildMemoTransaction(publisher, memo, blockhash);
    let txSignature: string;
    try {
      const messageBytes = tx.serializeMessage();
      // The exact bytes that go to the signer must be the memo-only anchor message, or nothing is signed.
      assertMemoOnlyMessage(messageBytes, signer.publicKey, memo);
      const signature = await requestCoaPublisherSignature(signer, Uint8Array.from(messageBytes));
      tx.addSignature(publisher, Buffer.from(signature));
      if (!tx.verifySignatures()) throw new Error('the signature does not verify against the publisher key and the anchor message');
      txSignature = base58Encode(tx.signatures[0].signature!);
    } catch (error) {
      this.logger.error(`Signing the anchor for ${row.id} failed; nothing was broadcast: ${shortError(error)}`);
      return note(`Signing failed, nothing was sent: ${shortError(error)}`);
    }
    // Persist the signature BEFORE broadcasting: if the outcome turns out unknown, the reconciler can still find the transaction.
    const claimed = await this.prisma.coaAnchor.updateMany({ where: { id: row.id, status: 'PENDING', txSignature: null }, data: { txSignature } });
    if (claimed.count !== 1) return this.reload(row);

    try {
      const sent = await this.chain.broadcast(tx.serialize());
      if (sent !== txSignature) this.logger.warn(`Broadcast signature differs from the signed signature for anchor ${row.id}; keeping the signed one`);
      await this.prisma.coaAnchor.updateMany({ where: { id: row.id, txSignature }, data: { error: null } });
    } catch (error) {
      if (error instanceof CoaAnchorRejectedError) {
        // The ONLY definitive outcome: the cluster refused it, so it can never land and the signature is not worth keeping.
        await this.prisma.coaAnchor.updateMany({
          where: { id: row.id, status: 'PENDING', txSignature },
          data: { status: 'FAILED', txSignature: null, error: `Rejected by the cluster: ${shortError(error)}` },
        });
        this.logger.warn(`Anchor ${row.id} rejected: ${shortError(error)}`);
      } else {
        // Timeout / outage / anything else: the cluster MAY have accepted it. Stay PENDING with the signature; the reconciler decides.
        await this.prisma.coaAnchor.updateMany({
          where: { id: row.id, txSignature },
          data: { error: `Broadcast outcome unknown (kept for reconciliation): ${shortError(error)}` },
        });
        this.logger.warn(`Anchor ${row.id} broadcast outcome unknown: ${shortError(error)}`);
      }
    }
    return this.reload(row);
  }

  // ---- verification ---------------------------------------------------------

  private async verifyLocked(row: AnchorRow, now: Date, summary?: AnchorSweepSummary): Promise<AnchorSnapshot> {
    if (row.status !== 'PENDING' || !row.txSignature) return this.toSnapshot(row);
    const signer = this.signer;
    if (!signer) return this.toSnapshot(row); // the publisher key is unknown: nothing can be confirmed
    const memo = await this.expectedMemo(row);
    if (memo === null) return this.fail(row, 'the COA record no longer matches the anchored memo');
    if (row.network !== this.config.network) return this.fail(row, `anchored on ${row.network} but anchoring is now configured for ${this.config.network}`);
    let view: CoaAnchorTxView | null;
    try {
      view = await this.chain.getTransaction(row.txSignature);
    } catch (error) {
      if (summary) summary.unavailable++;
      this.logger.warn(`Anchor ${row.id}: chain unavailable: ${shortError(error)}`);
      return this.toSnapshot(row);
    }
    if (!view) return this.handleUnknown(row, memo, now, summary);
    return this.applyView(row, view, memo);
  }

  /** The chain returned a view for the row's signature: confirm, fail or leave pending. */
  private async applyView(row: AnchorRow, view: CoaAnchorTxView, memo: string): Promise<AnchorSnapshot> {
    const publisher = this.signer?.publicKey;
    if (!publisher || row.status === 'CONFIRMED') return this.toSnapshot(row);
    if (!view.finalized) return this.reload(row); // not final yet (even a failed-looking one may be dropped on a fork): wait
    if (!view.succeeded) return this.fail(row, `transaction failed on chain: ${view.errorText ?? 'unknown error'}`);
    if (!view.body) return this.reload(row);
    const problem = checkAnchorBody(view.body, memo, publisher);
    if (problem) return this.fail(row, `verification failed: ${problem}`);
    await this.prisma.coaAnchor.updateMany({
      where: { id: row.id, status: { in: ['PENDING', 'FAILED'] }, txSignature: row.txSignature },
      data: { status: 'CONFIRMED', error: null, slot: view.slot === null ? null : BigInt(view.slot), blockTime: view.blockTime === null ? null : new Date(view.blockTime * 1000) },
    });
    return this.reload(row);
  }

  /** The chain has no record of the signature. Re-broadcast only once the blockhash cannot be valid any more. */
  private async handleUnknown(row: AnchorRow, memo: string, now: Date, summary?: AnchorSweepSummary): Promise<AnchorSnapshot> {
    if (row.updatedAt.getTime() > now.getTime() - ANCHOR_STALE_MS) return this.toSnapshot(row); // may still land
    if (row.attempts >= ANCHOR_MAX_ATTEMPTS) return this.fail(row, `gave up after ${row.attempts} attempts (the transaction never landed)`, true);
    const reset = await this.prisma.coaAnchor.updateMany({
      where: { id: row.id, status: 'PENDING', txSignature: row.txSignature, updatedAt: row.updatedAt },
      data: { txSignature: null, error: 'The previous transaction was not found on chain after 10 minutes; sending again' },
    });
    if (reset.count !== 1) return this.reload(row);
    const fresh = await this.prisma.coaAnchor.findUnique({ where: { id: row.id } });
    if (!fresh) return this.toSnapshot(row);
    if (summary) summary.rebroadcast++;
    return this.attempt(fresh, memo);
  }

  /** PENDING without a signature: retried when stale (and only when enabled and a signer is bound), bounded by ANCHOR_MAX_ATTEMPTS. */
  private async sweepUnsigned(row: AnchorRow, now: Date, summary: AnchorSweepSummary): Promise<AnchorSnapshot | null> {
    if (!this.config.enabled || !this.signer) return null;
    if (row.updatedAt.getTime() > now.getTime() - ANCHOR_STALE_MS) return null;
    if (row.attempts >= ANCHOR_MAX_ATTEMPTS) return this.fail(row, `gave up after ${row.attempts} attempts`, true);
    const memo = await this.expectedMemo(row);
    if (memo === null) return this.fail(row, 'the COA record no longer matches the anchored memo');
    summary.rebroadcast++;
    return this.attempt(row, memo);
  }

  /** The memo rebuilt from the COA record; it must also equal the stored memo. null = mismatch or unreadable. */
  private async expectedMemo(row: AnchorRow): Promise<string | null> {
    const coa = await this.prisma.coa.findUnique({ where: { id: row.coaId }, include: { lot: true } });
    if (!coa) return null;
    try {
      const memo = buildCoaMemo(row.kind, coa.lot.code, coa.version, coa.fileSha256);
      return memo === row.memo ? memo : null;
    } catch {
      return null;
    }
  }

  private async fail(row: AnchorRow, reason: string, clearSignature = false): Promise<AnchorSnapshot> {
    await this.prisma.coaAnchor.updateMany({
      where: { id: row.id, status: 'PENDING' },
      data: { status: 'FAILED', error: reason.slice(0, 300), ...(clearSignature ? { txSignature: null } : {}) },
    });
    this.logger.warn(`Anchor ${row.id} failed: ${reason}`);
    return this.reload(row);
  }

  // ---- helpers --------------------------------------------------------------

  private async reload(row: AnchorRow): Promise<AnchorSnapshot> {
    return this.toSnapshot((await this.prisma.coaAnchor.findUnique({ where: { id: row.id } })) ?? row);
  }

  private toSnapshot(row: AnchorRow): AnchorSnapshot {
    return {
      id: row.id,
      coaId: row.coaId,
      kind: row.kind,
      status: row.status,
      memo: row.memo,
      network: row.network,
      txSignature: row.txSignature,
      slot: row.slot === null ? null : Number(row.slot),
      blockTime: row.blockTime,
      attempts: row.attempts,
      error: row.error,
      explorerUrl: row.txSignature ? coaExplorerTxUrl(row.network, row.txSignature) : null,
    };
  }

  /** Serializes work per key within this process (the DB constraints and compare-and-sets cover other processes). */
  private serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    const tail = run.catch(() => undefined);
    this.queues.set(key, tail);
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return run;
  }
}
