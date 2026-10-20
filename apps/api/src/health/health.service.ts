import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/** Upper bound for the readiness database probe. A hung or slow database must fail the probe, not stall it. */
export const DB_PROBE_TIMEOUT_MS = 2000;

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * True only if `SELECT 1` completes within the timeout. Never throws and never exposes the failure reason:
   * driver errors can embed host names or connection strings, so only the error class/code is logged.
   * Redis is deliberately not checked: the API can serve catalog/checkout reads without it.
   */
  async isDatabaseReady(timeoutMs: number = DB_PROBE_TIMEOUT_MS): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const query = Promise.resolve()
      .then(() => this.prisma.$queryRaw`SELECT 1`)
      .then(() => 'ok' as const);
    // If the timeout wins, the query may still reject later; make sure that is never an unhandled rejection.
    query.catch(() => undefined);
    try {
      const outcome = await Promise.race([query, timeout]);
      if (outcome === 'timeout') this.logger.warn(`readiness: database probe timed out after ${timeoutMs}ms`);
      return outcome === 'ok';
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      this.logger.warn(`readiness: database probe failed (${error instanceof Error ? error.name : 'unknown error'}${typeof code === 'string' ? ` ${code}` : ''})`);
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
