import type { EmailConfig } from './email.config';
import { ConsoleEmailProvider } from './providers/console.provider';
import { ResendEmailProvider } from './providers/resend.provider';

/** DI token for the active transport (null when EMAIL_PROVIDER=none). */
export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');

export interface OutboundEmail {
  /** EmailOutbox id: stable across retries, so a provider can use it as an idempotency key. */
  id: string;
  to: string;
  template: string;
  subject: string;
  text: string;
  html: string;
}

export type SendResult =
  | { ok: true; providerMessageId: string | null }
  /** `error` is shown to operators: providers must redact it (the worker redacts again before storing). */
  | { ok: false; retryable: boolean; error: string; retryAfterMs?: number };

/** Add a provider by implementing this and extending createEmailProvider. send() should return a SendResult; a throw is treated as retryable. */
export interface EmailProvider {
  readonly name: string;
  send(message: OutboundEmail): Promise<SendResult>;
}

/** Builds the transport for a validated config. `none` yields null: the worker then logs one loud warning and sends nothing. */
export function createEmailProvider(config: EmailConfig): EmailProvider | null {
  switch (config.provider) {
    case 'console':
      return new ConsoleEmailProvider({ devFiles: config.devFiles, dir: config.devOutboxDir });
    case 'resend':
      return new ResendEmailProvider({ apiKey: config.apiKey as string, from: config.from as string });
    default:
      return null;
  }
}
