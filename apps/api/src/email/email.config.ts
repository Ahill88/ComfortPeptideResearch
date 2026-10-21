import { blank, isNonProductionRuntime, type EnvLike } from '../config/runtime';
import { EmailConfigError } from './email.errors';
import { isValidSender } from './email.validation';

export const EMAIL_CONFIG = Symbol('EMAIL_CONFIG');

export type EmailProviderName = 'console' | 'resend' | 'none';
export const EMAIL_PROVIDER_NAMES: readonly EmailProviderName[] = ['console', 'resend', 'none'];

export const DEFAULT_WORKER_INTERVAL_MS = 5000;
const MAX_WORKER_INTERVAL_MS = 3_600_000;
const DEFAULT_DEV_OUTBOX_DIR = '/tmp/helix-dev-mail';

export interface EmailConfig {
  provider: EmailProviderName;
  /** Provider credential (resend only). Never log it; pass it to redactText as a known value. */
  apiKey: string | null;
  /** Sender address, `a@b.co` or `Name <a@b.co>` (resend only). */
  from: string | null;
  /** 0 disables the worker. */
  workerIntervalMs: number;
  /** True only in development/test: the console provider may then write full messages to files. */
  devFiles: boolean;
  devOutboxDir: string;
  /** Normalised STOREFRONT_PUBLIC_URL origin (no trailing slash) or null when unset. */
  storefrontUrl: string | null;
}

/**
 * Parses and validates the EMAIL_* environment. Throws EmailConfigError (every problem listed, no values echoed) so a bad
 * configuration stops the API from starting instead of silently dropping mail.
 *
 *   EMAIL_PROVIDER            console | resend | none. Default: console in development/test, none in every other runtime.
 *   EMAIL_API_KEY, EMAIL_FROM both required for resend.
 *   EMAIL_WORKER_INTERVAL_MS  0 (disabled) or 100..3600000; default 5000.
 *   EMAIL_DEV_OUTBOX_DIR      development/test only; default /tmp/helix-dev-mail.
 *   STOREFRONT_PUBLIC_URL     optional http(s) origin used by callers to build links.
 */
export function loadEmailConfig(env: EnvLike = process.env): EmailConfig {
  const problems: string[] = [];
  const nonProduction = isNonProductionRuntime(env);

  let provider: EmailProviderName = nonProduction ? 'console' : 'none';
  if (!blank(env.EMAIL_PROVIDER)) {
    const requested = (env.EMAIL_PROVIDER as string).trim().toLowerCase();
    if ((EMAIL_PROVIDER_NAMES as readonly string[]).includes(requested)) provider = requested as EmailProviderName;
    else problems.push(`EMAIL_PROVIDER must be one of ${EMAIL_PROVIDER_NAMES.join(', ')}`);
  }

  const apiKey = blank(env.EMAIL_API_KEY) ? null : (env.EMAIL_API_KEY as string).trim();
  const from = blank(env.EMAIL_FROM) ? null : (env.EMAIL_FROM as string).trim();
  if (provider === 'resend') {
    if (!apiKey) problems.push('EMAIL_API_KEY is required when EMAIL_PROVIDER=resend');
    else if (/[\s\u0000-\u001f]/.test(apiKey)) problems.push('EMAIL_API_KEY must not contain whitespace');
    if (!from) problems.push('EMAIL_FROM is required when EMAIL_PROVIDER=resend');
  }
  if (from && !isValidSender(from)) {
    problems.push('EMAIL_FROM must be a valid address (a@example.com or Name <a@example.com>)');
  }

  let workerIntervalMs = DEFAULT_WORKER_INTERVAL_MS;
  if (!blank(env.EMAIL_WORKER_INTERVAL_MS)) {
    const raw = (env.EMAIL_WORKER_INTERVAL_MS as string).trim();
    const parsed = /^\d{1,8}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(parsed) || (parsed !== 0 && (parsed < 100 || parsed > MAX_WORKER_INTERVAL_MS))) {
      problems.push(`EMAIL_WORKER_INTERVAL_MS must be 0 (disabled) or a whole number of milliseconds from 100 to ${MAX_WORKER_INTERVAL_MS}`);
    } else workerIntervalMs = parsed;
  }

  let storefrontUrl: string | null = null;
  if (!blank(env.STOREFRONT_PUBLIC_URL)) {
    try {
      const url = new URL((env.STOREFRONT_PUBLIC_URL as string).trim());
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme');
      storefrontUrl = url.origin;
    } catch {
      problems.push('STOREFRONT_PUBLIC_URL must be an http(s) URL such as https://shop.example.com');
    }
  }

  if (problems.length > 0) throw new EmailConfigError(problems);
  return {
    provider,
    apiKey: provider === 'resend' ? apiKey : null,
    from: provider === 'resend' ? from : null,
    workerIntervalMs,
    devFiles: nonProduction,
    devOutboxDir: nonProduction && !blank(env.EMAIL_DEV_OUTBOX_DIR) ? (env.EMAIL_DEV_OUTBOX_DIR as string).trim() : DEFAULT_DEV_OUTBOX_DIR,
    storefrontUrl,
  };
}
