import type { EmailEnqueueInput, EmailPort } from '../email/email.types';

/** Upper bound a hook may add to settlement/shipping. Contract: under one second. */
export const ORDER_EMAIL_HOOK_TIMEOUT_MS = 750;

export type OrderEmailHookOutcome = 'enqueued' | 'skipped' | 'failed' | 'timeout';

export interface OrderEmailHookOptions {
  /** Absent when no email module is wired (the port is injected @Optional). */
  email: EmailPort | undefined;
  /** Receives ids only: never an address, a tracking number or an error message. */
  logger: { warn(message: string): void };
  template: 'order_confirmation' | 'order_shipped';
  orderId: string;
  /** Looks up whatever the message needs. Returning null means "nothing to send" (e.g. no customer email). */
  build: () => Promise<EmailEnqueueInput | null>;
  timeoutMs?: number;
}

/**
 * Fail-soft, time-boxed email enqueue for order events. It NEVER throws and never waits longer than `timeoutMs`:
 * lookup errors, enqueue errors, a hung port and a missing port all end in a return value, because paying or
 * shipping an order must not depend on email. A late rejection after the timeout is swallowed.
 */
export async function runOrderEmailHook(options: OrderEmailHookOptions): Promise<OrderEmailHookOutcome> {
  const { email, logger, template, orderId } = options;
  if (!email) return 'skipped';
  const timeoutMs = options.timeoutMs ?? ORDER_EMAIL_HOOK_TIMEOUT_MS;
  const work: Promise<OrderEmailHookOutcome> = (async () => {
    const input = await options.build();
    if (!input) return 'skipped';
    await email.enqueue(input);
    return 'enqueued';
  })();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([work, timeout]);
    if (outcome === 'timeout') {
      work.catch(() => undefined);
      logger.warn(`Order email hook timed out (template=${template}, order=${orderId}).`);
    }
    return outcome;
  } catch (error) {
    logger.warn(`Order email hook failed (template=${template}, order=${orderId}, error=${error instanceof Error ? error.name : 'unknown'}).`);
    return 'failed';
  } finally {
    if (timer) clearTimeout(timer);
  }
}
