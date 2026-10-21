import { EnvLike, blank, describeNodeEnv, isNonProductionRuntime, isProductionLikeRuntime } from '../config/runtime';
import { parseCorsOrigins } from '../config/http-options';
import { createSolanaChain, assertSandboxChainAllowed } from '../wallet/chain/chain.factory';
import { assertHeaderIdentityClosedInProductionLike } from '../wallet/customer-identity';
import { resolvePreparedStoreMode } from '../wallet/stores/prepared-store.factory';
import { loadRuntimeConfig } from '../wallet/wallet.config';
import { CUSTOMER_MFA_KEY_ENV, CUSTOMER_MFA_KEY_MIN_LENGTH, loadCustomerMfaKey, parseStorefrontUrl } from './auth.config';

/**
 * Production startup gate for authentication.
 *
 * Customer email verification, password reset and MFA are implemented and persisted server-side (AuthService, CustomerToken,
 * CustomerSession, Customer.mfaSeedEnc), so a production-like runtime no longer refuses to boot just because they are missing.
 * What startup still enforces, fail-closed, is that the email verification, password reset and MFA configuration is not silently broken:
 * with NODE_ENV === 'production' (and with every other production-like value: unset, "staging", "prod", "Production") startup fails when the email link base URL
 * (STOREFRONT_PUBLIC_URL) is set but invalid, or when the MFA encryption key (CUSTOMER_MFA_ENCRYPTION_KEY) is
 * set but shorter than 32 characters. Unset values do not block boot: registration then answers 503 "Account email is not
 * configured." and MFA enrolment answers 503, see {@link authStartupWarnings}. The check itself uses the allowlist helper
 * (isProductionLikeRuntime), never a NODE_ENV denylist comparison.
 *
 * It also runs {@link assertSandboxGatesClosed}, so a weakened identity/sandbox gate fails startup.
 */

/**
 * Startup self-test. In a production-like runtime, probes the REAL gates and throws if any of them would
 * let sandbox behaviour through: x-customer-email identity, the in-memory chain, mock-complete's runtime
 * flag, and the in-memory prepared store. By construction it never throws; it guards against regressions.
 */
export function assertSandboxGatesClosed(env: EnvLike = process.env): void {
  if (!isProductionLikeRuntime(env)) return;
  assertHeaderIdentityClosedInProductionLike(env);

  const config = loadRuntimeConfig({ ...env, WALLET_CHAIN_MODE: 'sandbox' } as NodeJS.ProcessEnv);
  if (!config.isProductionLike) throw new Error(`Refusing to start: wallet runtime config treats NODE_ENV=${describeNodeEnv(env)} as non-production.`);
  const refused = (probe: () => unknown): boolean => {
    try {
      probe();
      return false;
    } catch {
      return true;
    }
  };
  if (!refused(() => assertSandboxChainAllowed(config)) || !refused(() => createSolanaChain({} as never, config))) {
    throw new Error(`Refusing to start: the in-memory sandbox chain is reachable with NODE_ENV=${describeNodeEnv(env)}.`);
  }
  if (!refused(() => resolvePreparedStoreMode({ ...env, WALLET_PREPARED_STORE: 'memory' } as NodeJS.ProcessEnv))) {
    throw new Error(`Refusing to start: the in-memory prepared store is reachable with NODE_ENV=${describeNodeEnv(env)}.`);
  }
}

export function assertAuthReadyForEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  assertSandboxGatesClosed(env);
  if (!isProductionLikeRuntime(env)) return;
  const where = `NODE_ENV=${describeNodeEnv(env)}`;
  if (!blank(env.STOREFRONT_PUBLIC_URL) && parseStorefrontUrl(env.STOREFRONT_PUBLIC_URL) === null) {
    throw new Error(`Refusing to start in a production-like runtime (${where}): STOREFRONT_PUBLIC_URL is not a valid http(s) URL without credentials, query or fragment, so verification and password-reset links would be broken.`);
  }
  if (!blank(env[CUSTOMER_MFA_KEY_ENV]) && loadCustomerMfaKey(env) === null) {
    throw new Error(`Refusing to start in a production-like runtime (${where}): ${CUSTOMER_MFA_KEY_ENV} must be at least ${CUSTOMER_MFA_KEY_MIN_LENGTH} characters (unset it to disable customer MFA, but never run with a weak key).`);
  }
}

/** Non-fatal configuration findings, logged once at startup (never contains a value). */
export function authStartupWarnings(env: NodeJS.ProcessEnv = process.env, emailPortBound = true): string[] {
  const warnings: string[] = [];
  const productionLike = isProductionLikeRuntime(env);
  if (productionLike && blank(env.STOREFRONT_PUBLIC_URL)) warnings.push('STOREFRONT_PUBLIC_URL is unset: POST /v1/auth/register and /v1/auth/password-reset/request answer 503 "Account email is not configured."');
  if (productionLike && parseStorefrontUrl(env.STOREFRONT_PUBLIC_URL)?.startsWith('http:')) warnings.push('STOREFRONT_PUBLIC_URL is plain http in a production-like runtime');
  if (blank(env[CUSTOMER_MFA_KEY_ENV])) warnings.push(`${CUSTOMER_MFA_KEY_ENV} is unset: customer MFA enrolment answers 503 (sign-in for customers without MFA is unaffected)`);
  if (parseCorsOrigins(env.STOREFRONT_ORIGIN).origins.length === 0) warnings.push('STOREFRONT_ORIGIN is unset: every state-changing /v1/auth request is refused (403) because the CSRF Origin allow-list is empty');
  if (!emailPortBound) warnings.push('No email port is bound: verification and password-reset emails are not sent' + (isNonProductionRuntime(env) ? '' : ' (customers cannot complete registration)'));
  return warnings;
}
