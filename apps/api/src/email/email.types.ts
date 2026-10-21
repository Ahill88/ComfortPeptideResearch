/** Email contract (docs/api/commerce-contract.md section 1). */
export type EmailTemplate = 'email_verification' | 'password_reset' | 'order_confirmation' | 'order_shipped';

/** Every template name, in contract order. Anything outside this list is rejected by EmailService.enqueue. */
export const EMAIL_TEMPLATES: readonly EmailTemplate[] = ['email_verification', 'password_reset', 'order_confirmation', 'order_shipped'];

export interface EmailEnqueueInput {
  to: string;
  template: EmailTemplate;
  data: Record<string, unknown>;
  /** Idempotency key: enqueueing the same key twice creates ONE outbox row. */
  dedupeKey?: string;
}

export const EMAIL_PORT = Symbol('EMAIL_PORT');
export interface EmailPort {
  /** Never throws to the caller for provider problems: it only records the message in the outbox. */
  enqueue(input: EmailEnqueueInput): Promise<void>;
}

/** Data keys per template (documented in docs/api/email.md). Callers build links; the templates only render them. */
export interface EmailTemplateData {
  email_verification: { link: string; name?: string | null };
  password_reset: { link: string };
  order_confirmation: { orderId: string; totalCents: number; currency: string };
  order_shipped: { orderId: string; carrier: string; trackingNumber: string; trackingUrl?: string | null };
}

/** A fully rendered message. `subject` never contains CR/LF. */
export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}
