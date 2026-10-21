import { Logger } from '@nestjs/common';
import type { CoaAnchorKindName, CoaAnchorPort } from './coa.types';

/** A slow or failing anchor must never fail or noticeably delay a publish/revoke response. */
export const ANCHOR_REQUEST_TIMEOUT_MS = 3000;

const logger = new Logger('CoaAnchor');

/**
 * Calls the anchor port AFTER the database transaction committed. Awaited (so a fast port has finished by the time the response is built),
 * but bounded by a timeout and wrapped in try/catch. The port's own work keeps running after a timeout (its rejection is swallowed).
 * Only ids are logged. Returns whether the port completed without error in time.
 */
export async function requestAnchorSafely(
  port: CoaAnchorPort | undefined,
  input: { coaId: string; kind: CoaAnchorKindName },
  timeoutMs: number = ANCHOR_REQUEST_TIMEOUT_MS,
): Promise<boolean> {
  if (!port) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    const call = Promise.resolve().then(() => port.requestAnchor(input));
    call.catch(() => undefined);
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      timer.unref?.();
    });
    const outcome = await Promise.race([call.then(() => 'done' as const), timeout]);
    if (outcome === 'timeout') {
      logger.warn(`anchor request timed out coa=${input.coaId} kind=${input.kind}`);
      return false;
    }
    return true;
  } catch {
    logger.warn(`anchor request failed coa=${input.coaId} kind=${input.kind}`);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
