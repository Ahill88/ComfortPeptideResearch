import { EnvLike, describeNodeEnv, isProductionLikeRuntime } from '../config/runtime';
import { createSolanaChain, assertSandboxChainAllowed } from '../wallet/chain/chain.factory';
import { assertHeaderIdentityClosedInProductionLike } from '../wallet/customer-identity';
import { resolvePreparedStoreMode } from '../wallet/stores/prepared-store.factory';
import { loadRuntimeConfig } from '../wallet/wallet.config';

/**
 * Production startup gate for authentication.
 *
 * Email verification, password reset, and MFA are NOT implemented: AuthService answers 503 for all of
 * them and there is no credential, token, or MFA persistence. The API therefore refuses to boot in any
 * production-like runtime (anything except exactly NODE_ENV=development|test, so also unset, "staging",
 * "prod", "Production") unless the operator explicitly asserts, via AUTH_BACKEND=configured, that a
 * server-backed email verification, password reset, and MFA implementation is deployed.
 *
 * INTENDED BEHAVIOR TODAY: production-like startup always throws, because nothing can honestly back that
 * assertion. This is deliberate fail-closed behavior; remove it only when those features exist.
 * (Even if the flag is set, SessionGuard still denies every account request in production-like runtimes
 * until a real server-issued session validator is added.)
 *
 * It also runs {@link assertSandboxGatesClosed}, so a weakened identity/sandbox gate fails startup.
 */
export const AUTH_BACKEND_ENV = 'AUTH_BACKEND';
export const AUTH_BACKEND_CONFIGURED = 'configured';

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
  if (isProductionLikeRuntime(env) && env[AUTH_BACKEND_ENV] !== AUTH_BACKEND_CONFIGURED) {
    throw new Error(`Refusing to start in a production-like runtime (NODE_ENV=${describeNodeEnv(env)}; only exactly "development" or "test" is non-production): server-backed email verification, password reset, and MFA are not configured (AUTH_BACKEND=configured required; not yet implemented).`);
  }
}
