import type { EmailEnqueueInput, EmailPort } from '../../email/email.types';

/**
 * Recording EmailPort double (not a test file). `attempts` counts every enqueue call; `sent` holds what the outbox would
 * contain: like the real service, a repeated dedupeKey does not create a second row.
 */
export class RecordingEmail implements EmailPort {
  attempts: EmailEnqueueInput[] = [];
  sent: EmailEnqueueInput[] = [];
  /** Make enqueue reject (or throw synchronously when `sync`). */
  failWith: Error | null = null;
  sync = false;
  /** Make enqueue never settle. */
  hang = false;
  /** Make enqueue slow but successful. */
  delayMs = 0;
  private keys = new Set<string>();

  enqueue(input: EmailEnqueueInput): Promise<void> {
    this.attempts.push(input);
    if (this.failWith && this.sync) throw this.failWith;
    if (this.hang) return new Promise<void>(() => undefined);
    const record = () => {
      if (this.failWith) throw this.failWith;
      if (input.dedupeKey) {
        if (this.keys.has(input.dedupeKey)) return;
        this.keys.add(input.dedupeKey);
      }
      this.sent.push(input);
    };
    if (this.delayMs) return new Promise<void>((resolve, reject) => setTimeout(() => { try { record(); resolve(); } catch (error) { reject(error); } }, this.delayMs));
    return Promise.resolve().then(record);
  }
}

export const quietLogger = () => {
  const lines: string[] = [];
  return { lines, warn: (message: string) => void lines.push(message) };
};
