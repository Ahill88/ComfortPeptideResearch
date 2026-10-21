/** Email contract (docs/api/commerce-contract.md section 1). */
export type EmailTemplate = 'email_verification' | 'password_reset' | 'order_confirmation' | 'order_shipped';

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
