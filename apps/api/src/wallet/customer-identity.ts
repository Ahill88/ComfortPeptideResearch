import { UnauthorizedException, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { EnvLike, isNonProductionRuntime } from '../config/runtime';

export const CUSTOMER_EMAIL_HEADER = 'x-customer-email';
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const DENIED = 'Authentication required';

export type HeadersLike = Record<string, unknown>;

/**
 * THE single gate for header ("sandbox") identity. True ONLY when NODE_ENV is exactly "development"
 * or "test" (allowlist). Unset, empty, "staging", "prod", "Production", "production " ... are all denied.
 * There is no production authentication in this phase, so every production-like runtime gets 401.
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
 * Back-compat wrapper used by @CustomerEmail. Pass a nodeEnv explicitly (even `undefined`) to evaluate a
 * specific runtime; omit it to use process.env.
 */
export function readCustomerEmail(headers: HeadersLike, ...nodeEnv: [] | [string | undefined]): string {
  const env: EnvLike = nodeEnv.length ? { NODE_ENV: nodeEnv[0] } : process.env;
  return resolveHeaderEmail(headers, env);
}

export const CustomerEmail = createParamDecorator((_data: unknown, ctx: ExecutionContext): string =>
  readCustomerEmail(ctx.switchToHttp().getRequest().headers),
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
