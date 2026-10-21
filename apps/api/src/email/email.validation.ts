import { EmailValidationError } from './email.errors';
import { EMAIL_TEMPLATES, type EmailTemplate } from './email.types';

export const MAX_ADDRESS_LENGTH = 254;
const MAX_LOCAL_LENGTH = 64;
export const MAX_URL_LENGTH = 2048;
export const MAX_DEDUPE_KEY_LENGTH = 200;
const MAX_NAME_LENGTH = 100;
const MAX_CARRIER_LENGTH = 60;
const MAX_TRACKING_LENGTH = 64;
const MAX_ORDER_ID_LENGTH = 64;
/** Int32 ceiling (Order totals are Int32 safe). */
export const MAX_TOTAL_CENTS = 2_147_483_647;

// C0/C1 controls, DEL, line/paragraph separators and every Unicode space: none of them may appear in a header-ish value.
const CONTROL_OR_SPACE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]/;
const CONTROL_ONLY = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// Letters/digits plus the RFC 5322 "atext" specials. ASCII only: internationalised addresses are refused (fail closed).
const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** RFC-ish single mailbox: `local@domain.tld`, ASCII, <= 254 chars, no whitespace/controls/quotes/angle brackets/commas. */
export function isValidEmailAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ADDRESS_LENGTH) return false;
  if (CONTROL_OR_SPACE.test(value)) return false; // also rejects CR/LF, so no trimming is attempted
  const at = value.indexOf('@');
  if (at < 1 || at !== value.lastIndexOf('@')) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > MAX_LOCAL_LENGTH || !LOCAL_PART.test(local)) return false;
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((label) => DOMAIN_LABEL.test(label))) return false;
  return !/^\d+$/.test(labels[labels.length - 1]);
}

/** Domain part only (lower-cased). Used wherever the full address must not be shown or logged. */
export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return (at < 0 ? '' : address.slice(at + 1)).toLowerCase();
}

/** `a@b.co` or `Display Name <a@b.co>` (the forms Resend accepts for `from`). Returns false for anything else. */
export function isValidSender(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 320) return false;
  if (isValidEmailAddress(value)) return true;
  const match = /^([^<>"@\u0000-\u001f\u007f-\u009f]{1,100}?) <([^<>\s]+)>$/.exec(value);
  return Boolean(match && match[1].trim() === match[1] && match[1].trim().length > 0 && isValidEmailAddress(match[2]));
}

function fail(reason: string): never {
  throw new EmailValidationError(reason);
}

/** A single-line text value: no CR/LF or other controls (checked on the raw value, before trimming). Returns the trimmed text. */
export function requireText(label: string, value: unknown, max: number): string {
  if (typeof value !== 'string' || CONTROL_ONLY.test(value)) return fail(`${label} is not a valid single-line text`);
  const text = value.trim();
  if (text.length === 0 || text.length > max) return fail(`${label} is not a valid single-line text`);
  return text;
}

/** An http(s) URL without credentials. `javascript:`, `data:`, relative and protocol-relative values are refused. */
export function requireHttpUrl(label: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH || CONTROL_OR_SPACE.test(value)) fail(`${label} is not a valid URL`);
  let url: URL;
  try {
    url = new URL(value as string);
  } catch {
    return fail(`${label} is not a valid URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail(`${label} must be an http(s) URL`);
  if (url.username || url.password || !url.hostname) fail(`${label} must not carry credentials`);
  // The string is rendered as written: it must already be in canonical-enough form (no backslashes, no quote/angle characters).
  if (/[\\"'<>`]/.test(value as string)) fail(`${label} contains characters that are not allowed in a link`);
  return value as string;
}

function requireOrderId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value) || value.length > MAX_ORDER_ID_LENGTH) fail('orderId is not valid');
  return value as string;
}

function rejectUnknownKeys(data: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(data)) if (!allowed.includes(key)) fail(`unexpected data key "${key.slice(0, 40).replace(CONTROL_ONLY, '?')}"`);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function isKnownTemplate(value: unknown): value is EmailTemplate {
  return typeof value === 'string' && (EMAIL_TEMPLATES as readonly string[]).includes(value);
}

/**
 * Validates `data` for `template` and returns a NEW object holding only the known keys, normalised (optional keys present as
 * null). Throws EmailValidationError (reason names the field, never the value).
 */
export function validateTemplateData(template: EmailTemplate, input: unknown): Record<string, unknown> {
  if (!isRecord(input)) return fail('data must be an object');
  switch (template) {
    case 'email_verification': {
      rejectUnknownKeys(input, ['link', 'name']);
      const name = input.name === undefined || input.name === null ? null : requireText('name', input.name, MAX_NAME_LENGTH);
      return { link: requireHttpUrl('link', input.link), name };
    }
    case 'password_reset': {
      rejectUnknownKeys(input, ['link']);
      return { link: requireHttpUrl('link', input.link) };
    }
    case 'order_confirmation': {
      rejectUnknownKeys(input, ['orderId', 'totalCents', 'currency']);
      const total = input.totalCents;
      if (typeof total !== 'number' || !Number.isInteger(total) || total < 0 || total > MAX_TOTAL_CENTS) fail('totalCents must be an integer number of cents');
      if (typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency)) fail('currency must be a 3-letter upper-case code');
      return { orderId: requireOrderId(input.orderId), totalCents: total, currency: input.currency };
    }
    case 'order_shipped': {
      rejectUnknownKeys(input, ['orderId', 'carrier', 'trackingNumber', 'trackingUrl']);
      const trackingUrl = input.trackingUrl === undefined || input.trackingUrl === null ? null : requireHttpUrl('trackingUrl', input.trackingUrl);
      return {
        orderId: requireOrderId(input.orderId),
        carrier: requireText('carrier', input.carrier, MAX_CARRIER_LENGTH),
        trackingNumber: requireText('trackingNumber', input.trackingNumber, MAX_TRACKING_LENGTH),
        trackingUrl,
      };
    }
    default:
      return fail('unknown template');
  }
}

export function validateDedupeKey(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_DEDUPE_KEY_LENGTH || CONTROL_ONLY.test(value)) fail('dedupeKey is not valid');
  return value as string;
}
