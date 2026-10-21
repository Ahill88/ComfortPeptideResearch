import { HttpException } from '@nestjs/common';
import { EMAIL_PATTERN, PASSWORD_MAX_LENGTH, normalizeEmail, passwordPolicyError } from '../admin/auth/credentials';

/** Every auth error body is exactly `{message}` or `{code, message}`; nothing else leaks. */
export const authError = (status: number, message: string, code?: string): HttpException => new HttpException(code ? { code, message } : { message }, status);

export const INVALID_LINK = 'Invalid or expired link.';
export const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const record = (input: unknown): Record<string, unknown> => (typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {});

export function parseEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = normalizeEmail(value);
  return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null;
}

function requireEmail(value: unknown): string {
  const email = parseEmail(value);
  if (!email) throw authError(400, 'A valid email is required.');
  return email;
}

function parseName(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw authError(400, 'Name must be text.');
  const name = value.trim();
  if (name.length > 120 || CONTROL.test(name)) throw authError(400, 'Name must be at most 120 characters.');
  return name || null;
}

export function parseRegister(input: unknown): { email: string; password: string; name: string | null } {
  const body = record(input);
  const email = requireEmail(body.email);
  const policy = passwordPolicyError(body.password);
  if (policy) throw authError(400, policy);
  return { email, password: body.password as string, name: parseName(body.name) };
}

/** Login never explains: the caller turns null into the generic 401. */
export function parseLogin(input: unknown): { email: string; password: string; totp: string | null } | null {
  const body = record(input);
  const email = parseEmail(body.email);
  if (!email || typeof body.password !== 'string' || body.password.length === 0 || body.password.length > PASSWORD_MAX_LENGTH) return null;
  if (body.totp !== undefined && body.totp !== null && typeof body.totp !== 'string') return null;
  return { email, password: body.password, totp: typeof body.totp === 'string' && body.totp !== '' ? body.totp.trim() : null };
}

export function parseToken(input: unknown): string {
  const token = record(input).token;
  if (typeof token !== 'string' || !TOKEN_FORMAT.test(token)) throw authError(400, INVALID_LINK);
  return token;
}

export const parseResetRequest = (input: unknown): { email: string } => ({ email: requireEmail(record(input).email) });

export function parseResetConfirm(input: unknown): { token: string; newPassword: string } {
  const body = record(input);
  const policy = passwordPolicyError(body.newPassword);
  const token = typeof body.token === 'string' && TOKEN_FORMAT.test(body.token) ? body.token : null;
  if (!token) throw authError(400, INVALID_LINK);
  if (policy) throw authError(400, policy);
  return { token, newPassword: body.newPassword as string };
}

export function parseCode(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{6}$/.test(value.trim())) throw authError(400, 'Enter the 6-digit code.');
  return value.trim();
}

export function parseMfaDisable(input: unknown): { password: string; code: string } {
  const body = record(input);
  if (typeof body.password !== 'string' || body.password.length === 0 || body.password.length > PASSWORD_MAX_LENGTH) throw authError(400, 'Password is required.');
  return { password: body.password, code: parseCode(body.code) };
}

export function parseProfile(input: unknown): { name: string | null } {
  const body = record(input);
  if (!('name' in body)) throw authError(400, 'name is required.');
  return { name: parseName(body.name) };
}

export interface AddressInput {
  label: string | null;
  recipient: string;
  line1: string;
  line2: string | null;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  isDefault: boolean | undefined;
}

function text(body: Record<string, unknown>, field: string, max: number, required: boolean): string | null {
  const value = body[field];
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    if (required) throw authError(400, `${field} is required.`);
    return null;
  }
  if (typeof value !== 'string' || CONTROL.test(value) || value.trim().length > max) throw authError(400, `${field} must be at most ${max} characters.`);
  return value.trim();
}

/** Full address (POST) or partial (PATCH: only the keys present are validated and returned). */
export function parseAddress(input: unknown, partial: boolean): Partial<AddressInput> {
  const body = record(input);
  const out: Partial<AddressInput> = {};
  const has = (field: string) => !partial || field in body;
  if (has('label')) out.label = text(body, 'label', 80, false);
  if (has('recipient')) out.recipient = text(body, 'recipient', 120, true) as string;
  if (has('line1')) out.line1 = text(body, 'line1', 160, true) as string;
  if (has('line2')) out.line2 = text(body, 'line2', 160, false);
  if (has('city')) out.city = text(body, 'city', 100, true) as string;
  if (has('region')) out.region = text(body, 'region', 100, true) as string;
  if (has('postalCode')) out.postalCode = text(body, 'postalCode', 32, true) as string;
  if (has('country')) {
    const country = typeof body.country === 'string' ? body.country.trim().toUpperCase() : '';
    if (!/^[A-Z]{2}$/.test(country)) throw authError(400, 'country must be a 2-letter ISO code.');
    out.country = country;
  }
  if ('isDefault' in body) {
    if (typeof body.isDefault !== 'boolean') throw authError(400, 'isDefault must be true or false.');
    out.isDefault = body.isDefault;
  }
  if (partial && Object.keys(out).length === 0) throw authError(400, 'Nothing to update.');
  return out;
}
