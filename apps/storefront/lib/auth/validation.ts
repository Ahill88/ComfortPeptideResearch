import type { Address, AddressInput, Customer, EligibilityStatus, MfaEnrollment } from './types';

const CONTROL = /[\u0000-\u001f\u007f]/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,63}$/;
export const PASSWORD_HINT = 'Use 12–256 characters.';

export function normalizeEmail(value: string): string { return value.trim().toLowerCase(); }
export function validEmail(value: unknown): value is string {
  return typeof value === 'string' && normalizeEmail(value).length <= 254 && EMAIL.test(normalizeEmail(value));
}
export function passwordError(value: unknown): string | null {
  return typeof value === 'string' && value.length >= 12 && value.length <= 256 ? null : 'Password must be 12–256 characters.';
}
export function validCode(value: string): boolean { return /^\d{6}$/.test(value.trim()); }
export function validToken(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value); }
export function nameError(value: string): string | null {
  return value.trim().length > 120 || CONTROL.test(value) ? 'Name must be at most 120 characters, without control characters.' : null;
}

export class InvalidAuthResponse extends Error {
  constructor() { super('Account service returned an unexpected response. Please try again.'); this.name = 'InvalidAuthResponse'; }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidAuthResponse();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max || CONTROL.test(value)) throw new InvalidAuthResponse();
  return value;
}
function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new InvalidAuthResponse();
  return value;
}
export function parseCustomer(value: unknown): Customer {
  const r = record(value);
  if (!validEmail(r.email)) throw new InvalidAuthResponse();
  return { id: text(r.id, 200)!, email: normalizeEmail(r.email), name: text(r.name, 120, true), emailVerified: flag(r.emailVerified), mfaEnabled: flag(r.mfaEnabled) };
}
export function parseSession(value: unknown): Customer { return parseCustomer(record(value).customer); }
export function parseEligibility(value: unknown): EligibilityStatus {
  const status = record(value).status;
  if (status !== 'NOT_REQUESTED' && status !== 'PENDING' && status !== 'APPROVED' && status !== 'REJECTED') throw new InvalidAuthResponse();
  return status;
}
export function parseAddress(value: unknown): Address {
  const r = record(value);
  if (typeof r.country !== 'string' || !/^[A-Z]{2}$/.test(r.country)) throw new InvalidAuthResponse();
  return {
    id: text(r.id, 200)!, label: text(r.label, 80, true), recipient: text(r.recipient, 120)!,
    line1: text(r.line1, 160)!, line2: text(r.line2, 160, true), city: text(r.city, 100)!,
    region: text(r.region, 100)!, postalCode: text(r.postalCode, 32)!, country: r.country, isDefault: flag(r.isDefault),
  };
}
export function parseAddresses(value: unknown): Address[] {
  const items = record(value).items;
  if (!Array.isArray(items) || items.length > 20) throw new InvalidAuthResponse();
  const addresses = items.map(parseAddress);
  if (new Set(addresses.map((a) => a.id)).size !== addresses.length || (addresses.length > 0 && addresses.filter((a) => a.isDefault).length !== 1)) throw new InvalidAuthResponse();
  return addresses;
}
export function parseEnrollment(value: unknown): MfaEnrollment {
  const r = record(value);
  if (typeof r.seedBase32 !== 'string' || !/^[A-Z2-7]{16,128}$/.test(r.seedBase32) || typeof r.otpauthUri !== 'string' || r.otpauthUri.length > 2048) throw new InvalidAuthResponse();
  try {
    const uri = new URL(r.otpauthUri);
    if (uri.protocol !== 'otpauth:' || uri.hostname !== 'totp' || uri.searchParams.get('secret') !== r.seedBase32) throw new InvalidAuthResponse();
  } catch { throw new InvalidAuthResponse(); }
  return { seedBase32: r.seedBase32, otpauthUri: r.otpauthUri };
}
export function parseAccepted(value: unknown): void { text(record(value).message, 500); }

export const ADDRESS_FIELDS = [
  { key: 'label', label: 'Label (optional)', max: 80, autoComplete: 'off', required: false },
  { key: 'recipient', label: 'Recipient', max: 120, autoComplete: 'shipping name', required: true },
  { key: 'line1', label: 'Address line 1', max: 160, autoComplete: 'shipping address-line1', required: true },
  { key: 'line2', label: 'Address line 2 (optional)', max: 160, autoComplete: 'shipping address-line2', required: false },
  { key: 'city', label: 'City', max: 100, autoComplete: 'shipping address-level2', required: true },
  { key: 'region', label: 'State / region', max: 100, autoComplete: 'shipping address-level1', required: true },
  { key: 'postalCode', label: 'Postal code', max: 32, autoComplete: 'shipping postal-code', required: true },
  { key: 'country', label: 'Country (2-letter code)', max: 2, autoComplete: 'shipping country', required: true },
] as const;

export function addressError(address: AddressInput): string | null {
  for (const { key, label, max, required } of ADDRESS_FIELDS) {
    const value = address[key] ?? '';
    if (required && !value.trim()) return `${label} is required.`;
    if (value.trim().length > max || CONTROL.test(value)) return `${label} must be at most ${max} characters, without control characters.`;
  }
  if (!/^[A-Z]{2}$/.test(address.country.trim().toUpperCase())) return 'Country must be a 2-letter ISO code, such as US.';
  return null;
}
