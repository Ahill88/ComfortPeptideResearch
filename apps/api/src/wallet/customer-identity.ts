import { ForbiddenException, UnauthorizedException, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { parseCorsOrigins } from '../config/http-options';
import { EnvLike, isNonProductionRuntime } from '../config/runtime';

export const CUSTOMER_EMAIL_HEADER = 'x-customer-email';
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const DENIED = 'Authentication required';

export type HeadersLike = Record<string, unknown>;

/**
 * THE single gate for header ("sandbox") identity. True ONLY when NODE_ENV is exactly "development"
 * or "test" (allowlist). Unset, empty, "staging", "prod", "Production", "production " ... are all denied.
 * In a production-like runtime the header is never read; only a valid `hf_session` cookie (see
 * resolveRequestIdentity) identifies a customer.
 */
export function isHeaderIdentityAllowed(env: EnvLike = process.env): boolean {
  return isNonProductionRuntime(env);
}

/**
 * Shared resolver, step 1 (synchronous): gate + parse. Returns the normalised (trimmed, lower-cased)
 * x-customer-email value or throws 401. Repeated headers (arrays) are rejected as ambiguous. The gate is
 * evaluated BEFORE the header is even read, so in a production-like runtime the header has no effect.
 */
export function resolveHeaderEmail(headers: HeadersLike | undefined, env: EnvLike = process.env): string {
  if (!isHeaderIdentityAllowed(env)) throw new UnauthorizedException(DENIED);
  const raw = headers?.[CUSTOMER_EMAIL_HEADER];
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || value.length > 254 || !EMAIL.test(value)) throw new UnauthorizedException(DENIED);
  return value.toLowerCase();
}

/**
 * Shared resolver, step 2: map the header email to an EXISTING customer via `lookup` (nothing is ever
 * auto-created). Used by SessionGuard and CheckoutController so there is exactly one identity code path.
 */
export async function resolveHeaderCustomer<T>(
  headers: HeadersLike | undefined,
  lookup: (email: string) => Promise<T | null | undefined>,
  env: EnvLike = process.env,
): Promise<{ email: string; customer: T }> {
  const email = resolveHeaderEmail(headers, env);
  const customer = await lookup(email);
  if (!customer) throw new UnauthorizedException(DENIED);
  return { email, customer };
}

/**
 * Header-only wrapper (no cookie, no CSRF check); @CustomerEmail uses resolveRequestIdentity instead. Pass a nodeEnv explicitly (even `undefined`) to evaluate a
 * specific runtime; omit it to use process.env.
 */
export function readCustomerEmail(headers: HeadersLike, ...nodeEnv: [] | [string | undefined]): string {
  const env: EnvLike = nodeEnv.length ? { NODE_ENV: nodeEnv[0] } : process.env;
  return resolveHeaderEmail(headers, env);
}

/* ----------------------------------------------------------------------------------- cookie (session) identity */

/** Name of the httpOnly session cookie issued by POST /v1/auth/login (docs/api/customer-auth.md). */
export const CUSTOMER_SESSION_COOKIE = 'hf_session';
const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The customer a valid session cookie resolved to. Attached to the request by CustomerSessionMiddleware (never by the client). */
export interface SessionIdentity {
  customerId: string;
  email: string;
  sessionId: string;
}

export interface IdentityRequest {
  method?: string;
  headers?: HeadersLike;
  customerSession?: SessionIdentity;
}

export type RequestIdentity = { source: 'header'; email: string } | ({ source: 'session' } & SessionIdentity);

/**
 * The raw session token from the Cookie header, or null. A cookie that appears more than once, is malformed, or is not
 * exactly 43 base64url characters (32 random bytes) is treated as absent; it is never trusted partially.
 */
export function readSessionCookieToken(headers: HeadersLike | undefined): string | null {
  const raw = headers?.cookie;
  const header = Array.isArray(raw) ? raw.join('; ') : typeof raw === 'string' ? raw : '';
  if (!header || header.length > 8192) return null;
  const values: string[] = [];
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === CUSTOMER_SESSION_COOKIE) values.push(part.slice(index + 1).trim());
  }
  if (values.length !== 1) return null;
  return SESSION_TOKEN.test(values[0]) ? values[0] : null;
}

/**
 * CSRF defence: the request must carry exactly one `Origin` header equal to an entry of the STOREFRONT_ORIGIN allow-list
 * (the same list CORS uses). A missing Origin is refused: browsers always send it on cross-site POST/PATCH/DELETE.
 */
export function assertAllowedOrigin(headers: HeadersLike | undefined, env: EnvLike = process.env): void {
  const raw = headers?.origin;
  const origin = typeof raw === 'string' ? raw.trim() : '';
  if (!origin || !parseCorsOrigins(env.STOREFRONT_ORIGIN).origins.includes(origin)) throw new ForbiddenException({ message: 'Origin not allowed.' });
}

/**
 * THE shared identity resolver for every customer-facing route (wallet, checkout, orders, account).
 *  1. development/test only: a present `x-customer-email` header decides (strictly parsed; unchanged behaviour). In every other
 *     runtime the header is not even read.
 *  2. any runtime: the customer resolved from a valid `hf_session` cookie. When that is the source and the method changes state,
 *     an allow-listed Origin is required (403 otherwise). Requests identified by the header are not subject to this check.
 *  3. otherwise 401.
 */
export function resolveRequestIdentity(req: IdentityRequest | undefined, env: EnvLike = process.env): RequestIdentity {
  const headers = req?.headers;
  if (isHeaderIdentityAllowed(env) && headers?.[CUSTOMER_EMAIL_HEADER] !== undefined) {
    return { source: 'header', email: resolveHeaderEmail(headers, env) };
  }
  const session = req?.customerSession;
  if (!session) throw new UnauthorizedException(DENIED);
  if (!SAFE_METHODS.has((req?.method ?? 'POST').toUpperCase())) assertAllowedOrigin(headers, env);
  return { source: 'session', customerId: session.customerId, email: session.email, sessionId: session.sessionId };
}

/** Like resolveHeaderCustomer, but accepts the header (development/test) or a session cookie (any runtime). */
export async function resolveRequestCustomer<T>(
  req: IdentityRequest | undefined,
  lookup: (email: string) => Promise<T | null | undefined>,
  env: EnvLike = process.env,
): Promise<{ email: string; customer: T }> {
  const { email } = resolveRequestIdentity(req, env);
  const customer = await lookup(email);
  if (!customer) throw new UnauthorizedException(DENIED);
  return { email, customer };
}

export const CustomerEmail = createParamDecorator((_data: unknown, ctx: ExecutionContext): string =>
  resolveRequestIdentity(ctx.switchToHttp().getRequest<IdentityRequest>()).email,
);

/**
 * Startup self-test: proves header identity is unreachable in a production-like runtime by probing the
 * real gate with a well-formed header. By construction this never throws; it exists so that a future edit
 * that weakens the gate fails startup instead of silently shipping.
 */
export function assertHeaderIdentityClosedInProductionLike(
  env: EnvLike = process.env,
  /** Test seam: the gate under test. Defaults to the real shared resolver. */
  resolve: typeof resolveHeaderEmail = resolveHeaderEmail,
): void {
  if (isNonProductionRuntime(env)) return;
  try {
    resolve({ [CUSTOMER_EMAIL_HEADER]: 'startup-probe@example.com' }, env);
  } catch (error) {
    if (error instanceof UnauthorizedException) return;
    throw error;
  }
  throw new Error('Refusing to start: x-customer-email header identity is reachable in a production-like runtime.');
}
