import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { describeListSource, SANCTIONS_CONFIG, SANCTIONS_FETCHER, SANCTIONS_SOURCE, type SanctionsConfig } from './sanctions.config';
import { fetchSdnList, SanctionsFetchError, type SanctionsFetcher } from './sanctions-fetcher';

export interface SanctionsRunView {
  fetchedAt: Date;
  entryCount: number;
  status: string;
  error: string | null;
}

export interface SanctionsStatusView {
  source: string;
  lastRun: SanctionsRunView | null;
  addressCount: number;
}

export type RefreshTrigger = 'startup' | 'schedule' | 'admin';

export interface RefreshOptions {
  trigger: RefreshTrigger;
  /** OWNER endpoint only: accept a large drop in entry count. An empty list is never accepted. */
  force?: boolean;
  /** Automatic triggers skip when the last OK run is younger than this. */
  minOkAgeMs?: number;
  /** Automatic triggers skip when a FAILED run is younger than this (retry gap). */
  retryGapMs?: number;
}

export interface RefreshResult {
  outcome: 'OK' | 'FAILED' | 'SKIPPED';
  /** Redacted, safe to show an admin. */
  reason: string | null;
  entryCount: number | null;
}

/** A RUNNING row older than this is a crashed attempt: it stops blocking new runs. */
export const STALE_RUN_MS = 5 * 60_000;
/** A successful run may not shrink the list by more than this fraction of the previous run unless forced. */
export const MAX_PLAUSIBLE_DROP = 0.5;
const KEEP_RUNS = 50;
const INSERT_BATCH = 500;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

@Injectable()
export class SanctionsService {
  private readonly logger = new Logger(SanctionsService.name);
  private inflight: Promise<RefreshResult> | null = null;
  private readonly fetcher: SanctionsFetcher;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SANCTIONS_CONFIG) private readonly config: SanctionsConfig,
    @Optional() @Inject(SANCTIONS_FETCHER) fetcher?: SanctionsFetcher,
  ) {
    this.fetcher = fetcher ?? fetchSdnList;
  }

  /** True once at least one run has succeeded (so the table holds a full, validated list). */
  async isReady(): Promise<boolean> {
    return (await this.prisma.sanctionsListRun.findFirst({ where: { source: SANCTIONS_SOURCE, status: 'OK' }, select: { id: true } })) !== null;
  }

  /**
   * Exact match on the address string against EVERY currency (a listed address is a listed person). EVM-style addresses (0x + 40 hex)
   * are also compared case-insensitively: checksum casing is cosmetic there. Base58 addresses (Solana, Tron, Bitcoin) are case-sensitive,
   * so they never match case-insensitively (a base58 string cannot start with '0').
   */
  async findListed(addresses: readonly string[]): Promise<boolean> {
    const exact = [...new Set(addresses.map((a) => a.trim()).filter((a) => a !== ''))];
    if (exact.length === 0) return false;
    const evmLower = [...new Set(exact.filter((a) => EVM_ADDRESS.test(a)).map((a) => a.toLowerCase()))];
    const hit = await this.prisma.sanctionsAddress.findFirst({
      where: {
        source: SANCTIONS_SOURCE,
        OR: [{ address: { in: exact } }, ...(evmLower.length > 0 ? [{ address: { in: evmLower, mode: 'insensitive' as const } }] : [])],
      },
      select: { id: true },
    });
    return hit !== null;
  }

  async status(): Promise<SanctionsStatusView> {
    const [last, addressCount] = await Promise.all([
      this.prisma.sanctionsListRun.findFirst({
        where: { source: SANCTIONS_SOURCE, status: { in: ['OK', 'FAILED'] } },
        orderBy: { fetchedAt: 'desc' },
        select: { fetchedAt: true, entryCount: true, status: true, error: true },
      }),
      this.prisma.sanctionsAddress.count({ where: { source: SANCTIONS_SOURCE } }),
    ]);
    return { source: describeListSource(this.config.listUrl), lastRun: last, addressCount };
  }

  /** Single flight per process (concurrent callers share one run) and per database (conditional claim under an advisory lock). */
  refresh(options: RefreshOptions): Promise<RefreshResult> {
    if (this.inflight) return this.inflight;
    const run = this.runRefresh(options).finally(() => {
      this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  private async claim(options: RefreshOptions): Promise<{ runId: string } | { skipped: string }> {
    return this.prisma.$transaction(async (tx) => {
      // Serialises the claim decision across instances (and across processes sharing the schema). Released at commit.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('sanctions-refresh:' || current_schema()))::text AS locked`;
      const now = Date.now();
      await tx.sanctionsListRun.updateMany({
        where: { source: SANCTIONS_SOURCE, status: 'RUNNING', fetchedAt: { lt: new Date(now - STALE_RUN_MS) } },
        data: { status: 'FAILED', error: 'The previous refresh did not finish.' },
      });
      if ((await tx.sanctionsListRun.count({ where: { source: SANCTIONS_SOURCE, status: 'RUNNING' } })) > 0) {
        return { skipped: 'A refresh is already running.' };
      }
      if (options.minOkAgeMs !== undefined) {
        const lastOk = await tx.sanctionsListRun.findFirst({ where: { source: SANCTIONS_SOURCE, status: 'OK' }, orderBy: { fetchedAt: 'desc' }, select: { fetchedAt: true } });
        if (lastOk && now - lastOk.fetchedAt.getTime() < options.minOkAgeMs) return { skipped: 'The list is recent enough.' };
      }
      if (options.retryGapMs !== undefined) {
        const lastFailed = await tx.sanctionsListRun.findFirst({ where: { source: SANCTIONS_SOURCE, status: 'FAILED' }, orderBy: { fetchedAt: 'desc' }, select: { fetchedAt: true } });
        if (lastFailed && now - lastFailed.fetchedAt.getTime() < options.retryGapMs) return { skipped: 'A refresh failed recently; waiting before retrying.' };
      }
      const run = await tx.sanctionsListRun.create({ data: { source: SANCTIONS_SOURCE, status: 'RUNNING' }, select: { id: true } });
      return { runId: run.id };
    });
  }

  private async fail(runId: string, reason: string, sha256?: string): Promise<RefreshResult> {
    await this.prisma.sanctionsListRun.update({ where: { id: runId }, data: { status: 'FAILED', error: reason.slice(0, 300), fetchedAt: new Date(), ...(sha256 ? { sha256 } : {}) } });
    this.logger.warn(`Sanctions list refresh failed: ${reason}`);
    return { outcome: 'FAILED', reason, entryCount: null };
  }

  private async runRefresh(options: RefreshOptions): Promise<RefreshResult> {
    let claimed: { runId: string } | { skipped: string };
    try {
      claimed = await this.claim(options);
    } catch {
      this.logger.warn('Sanctions list refresh could not start (database error).');
      return { outcome: 'FAILED', reason: 'The refresh could not start.', entryCount: null };
    }
    if ('skipped' in claimed) return { outcome: 'SKIPPED', reason: claimed.skipped, entryCount: null };
    const { runId } = claimed;

    try {
      const download = await this.fetcher({ url: this.config.listUrl, allowInsecure: this.config.allowInsecureUrl });

      // One entry per exact address string: the unique key is (source, address).
      const unique = new Map<string, (typeof download.addresses)[number]>();
      for (const entry of download.addresses) if (!unique.has(entry.address)) unique.set(entry.address, entry);
      const entryCount = unique.size;

      const previous = await this.prisma.sanctionsListRun.findFirst({ where: { source: SANCTIONS_SOURCE, status: 'OK' }, orderBy: { fetchedAt: 'desc' }, select: { entryCount: true } });
      if (entryCount === 0) return await this.fail(runId, 'The downloaded list holds no digital currency addresses; the previous data was kept.', download.sha256);
      if (previous && !options.force && entryCount < previous.entryCount * (1 - MAX_PLAUSIBLE_DROP)) {
        return await this.fail(runId, `The downloaded list shrank implausibly (${entryCount} addresses, previously ${previous.entryCount}); the previous data was kept.`, download.sha256);
      }

      const rows = [...unique.values()].map((entry) => ({
        source: SANCTIONS_SOURCE,
        address: entry.address,
        currency: entry.currency,
        entryUid: entry.entryUid,
        listedName: entry.listedName,
        runId,
      }));
      await this.prisma.$transaction(
        async (tx) => {
          await tx.sanctionsAddress.deleteMany({ where: { source: SANCTIONS_SOURCE } });
          for (let i = 0; i < rows.length; i += INSERT_BATCH) await tx.sanctionsAddress.createMany({ data: rows.slice(i, i + INSERT_BATCH) });
          await tx.sanctionsListRun.update({ where: { id: runId }, data: { status: 'OK', entryCount, sha256: download.sha256, error: null, fetchedAt: new Date() } });
        },
        { timeout: 60_000, maxWait: 10_000 },
      );
      await this.pruneRuns();
      this.logger.log(
        `Sanctions list refreshed: ${entryCount} addresses (previously ${previous?.entryCount ?? 0}); ${download.rejectedAddresses} entries rejected, ${download.malformedEntries} malformed blocks skipped.`,
      );
      return { outcome: 'OK', reason: null, entryCount };
    } catch (error) {
      const reason = error instanceof SanctionsFetchError ? error.publicMessage : 'The list could not be stored; the previous data was kept.';
      try {
        return await this.fail(runId, reason);
      } catch {
        this.logger.warn('Sanctions list refresh failed and the failure could not be recorded.');
        return { outcome: 'FAILED', reason, entryCount: null };
      }
    }
  }

  private async pruneRuns(): Promise<void> {
    try {
      const keep = await this.prisma.sanctionsListRun.findMany({ where: { source: SANCTIONS_SOURCE }, orderBy: { fetchedAt: 'desc' }, take: KEEP_RUNS, select: { id: true } });
      if (keep.length < KEEP_RUNS) return;
      await this.prisma.sanctionsListRun.deleteMany({
        where: { source: SANCTIONS_SOURCE, status: { not: 'RUNNING' }, id: { notIn: keep.map((r) => r.id) }, addresses: { none: {} } },
      });
    } catch {
      // Housekeeping only.
    }
  }
}
