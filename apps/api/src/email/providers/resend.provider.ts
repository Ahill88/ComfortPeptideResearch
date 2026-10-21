import { redactText } from '../email.redact';
import type { EmailProvider, OutboundEmail, SendResult } from '../email.provider';

/** Verified against https://resend.com/docs/api-reference/emails/send-email and /errors (see docs/api/email.md). */
export const RESEND_SEND_URL = 'https://api.resend.com/emails';
export const RESEND_TIMEOUT_MS = 10_000;

export interface ResendProviderOptions {
  apiKey: string;
  from: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  url?: string;
}

const MAX_RETRY_AFTER_MS = 6 * 3_600_000;

/**
 * Resend REST transport (global fetch, no SDK). POST /emails with `Authorization: Bearer <key>` and an `Idempotency-Key` derived
 * from the outbox id (Resend keeps keys for 24 h, max 256 chars; the retry schedule stays inside that window), so a retry after a
 * lost response or a crashed worker cannot send twice. Classification:
 *   2xx                                  sent
 *   429, 5xx, 408, network/timeout       retry (409 only for concurrent_idempotent_requests / resource_locked)
 *   every other 4xx                      permanent failure (bad key, unverified domain, validation, idempotency mismatch)
 * Provider messages are redacted (keys, addresses, token-shaped strings) before they leave this class.
 */
export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly url: string;

  constructor(private readonly options: ResendProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? RESEND_TIMEOUT_MS;
    this.url = options.url ?? RESEND_SEND_URL;
  }

  async send(message: OutboundEmail): Promise<SendResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `helix-email-${message.id}`,
        },
        body: JSON.stringify({ from: this.options.from, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
      });
      const raw = (await response.text().catch(() => '')).slice(0, 4096);
      let body: { id?: unknown; name?: unknown; message?: unknown } = {};
      try {
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        if (parsed && typeof parsed === 'object') body = parsed as typeof body;
      } catch {
        /* non-JSON body: only the status is used */
      }
      if (response.status >= 200 && response.status < 300) {
        return { ok: true, providerMessageId: typeof body.id === 'string' && body.id.length <= 128 ? body.id : null };
      }
      const name = typeof body.name === 'string' ? body.name : 'error';
      const detail = typeof body.message === 'string' ? body.message : '';
      const error = redactText(`resend HTTP ${response.status} ${name}: ${detail}`, [this.options.apiKey, this.options.from]);
      const retryable =
        response.status === 429 || response.status >= 500 || response.status === 408 ||
        (response.status === 409 && (name === 'concurrent_idempotent_requests' || name === 'resource_locked'));
      if (!retryable) return { ok: false, retryable: false, error };
      const retryAfter = Number(response.headers?.get?.('retry-after'));
      const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS) : undefined;
      return { ok: false, retryable: true, error, ...(retryAfterMs ? { retryAfterMs } : {}) };
    } catch (error) {
      const aborted = controller.signal.aborted;
      return { ok: false, retryable: true, error: aborted ? `resend request timed out after ${this.timeoutMs} ms` : redactText(error, [this.options.apiKey, this.options.from]) };
    } finally {
      clearTimeout(timer);
    }
  }
}
