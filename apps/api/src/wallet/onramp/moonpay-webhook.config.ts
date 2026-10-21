import { EnvLike, blank } from '../../config/runtime';
import { DEFAULT_WEBHOOK_TOLERANCE_SECONDS } from './moonpay-webhook.signature';

/** Injection token for MoonPayWebhookConfig. */
export const MOONPAY_WEBHOOK_CONFIG = Symbol('MOONPAY_WEBHOOK_CONFIG');

export const MAX_WEBHOOK_TOLERANCE_SECONDS = 86_400;

export interface MoonPayWebhookConfig {
  /**
   * The WEBHOOK API key from the MoonPay dashboard (Developers page). It is a different credential from the widget
   * URL-signing key and must never be reused for it. Null = not configured: the endpoint answers 503 and processes
   * nothing, in every runtime.
   */
  webhookKey: string | null;
  /** Accepted distance between the header timestamp and our clock, in seconds, in either direction. */
  toleranceSeconds: number;
}

/** Invalid or out-of-range tolerance values fall back to the default (never to "no check"). */
export function parseToleranceSeconds(raw: string | undefined): number {
  if (blank(raw) || !/^\d+$/.test((raw as string).trim())) return DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  const value = Number((raw as string).trim());
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_WEBHOOK_TOLERANCE_SECONDS ? value : DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
}

export function loadMoonPayWebhookConfig(env: EnvLike = process.env): MoonPayWebhookConfig {
  return {
    webhookKey: blank(env.MOONPAY_WEBHOOK_KEY) ? null : (env.MOONPAY_WEBHOOK_KEY as string).trim(),
    toleranceSeconds: parseToleranceSeconds(env.MOONPAY_WEBHOOK_TOLERANCE_SECONDS),
  };
}
