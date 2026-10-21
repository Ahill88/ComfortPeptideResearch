import { parseCorsOrigins, parseTrustProxy } from './http-options';
import { RATE_LIMIT_ENV, parsePositiveInt } from './rate-limit';
import { EnvLike, blank, describeNodeEnv, isKnownNodeEnv, isNonProductionRuntime } from './runtime';

/** Must be set verbatim, alongside a live-funds flag, for the API to start with that flag on. */
export const LIVE_FUNDS_ACK_VALUE = 'I_ACCEPT_LIVE_FUNDS_RISK';
export const LIVE_FUNDS_FLAGS = ['ENABLE_SOLANA_MAINNET', 'ENABLE_LIVE_CRYPTO_PAYMENTS'] as const;
export const MIN_ADMIN_TOKEN_LENGTH = 32;

export interface EnvValidationResult {
  /** Startup must be refused when non-empty. Messages never contain secret values. */
  errors: string[];
  warnings: string[];
}

export class EnvValidationError extends Error {
  constructor(readonly errors: string[]) {
    super(`Invalid environment configuration:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Decodes base58 to bytes, or returns null if any character is outside the Bitcoin/Solana alphabet. */
export function decodeBase58(text: string): Uint8Array | null {
  let value = 0n;
  for (const char of text) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  let leadingZeros = 0;
  while (leadingZeros < text.length && text[leadingZeros] === '1') leadingZeros += 1;
  return Uint8Array.from([...new Array<number>(leadingZeros).fill(0), ...bytes]);
}

/** A Solana public key: base58 text that decodes to exactly 32 bytes. */
export function isValidSolanaAddress(text: string): boolean {
  if (text.length < 32 || text.length > 44) return false;
  return decodeBase58(text)?.length === 32;
}

/** The runtime only treats the exact string "true" as on; this is deliberately broader so " TRUE" or "1" cannot slip past the ACK gate. */
const looksEnabled = (value: string | undefined) => /^(true|1|yes|on)$/i.test((value ?? '').trim());

const hostOf = (url: URL) => url.hostname.toLowerCase();

/**
 * Network-correctness checks for the wallet stack. Switching to mainnet is a configuration change guarded by loud checks: every
 * requirement below must hold or the API refuses to start. Messages name variables, never values (an RPC URL may embed a provider key).
 * The boot-time chain preflight (wallet/chain/chain-preflight.ts) then proves against the live RPC that the cluster and mint are right.
 */
function validateSolanaNetworkEnv(env: EnvLike, productionLike: boolean, errors: string[], warnings: string[]): void {
  const networkRaw = blank(env.SOLANA_NETWORK) ? 'solana-devnet' : (env.SOLANA_NETWORK as string).trim();
  if (networkRaw !== 'solana-devnet' && networkRaw !== 'solana-mainnet') {
    errors.push('SOLANA_NETWORK must be "solana-devnet" or "solana-mainnet"');
    return;
  }
  const mainnet = networkRaw === 'solana-mainnet';
  const mode = blank(env.WALLET_CHAIN_MODE) ? 'sandbox' : (env.WALLET_CHAIN_MODE as string).trim();
  if (mode !== 'sandbox' && mode !== 'devnet') errors.push('WALLET_CHAIN_MODE must be "sandbox" or "devnet"');

  // One mint source: SOLANA_USDC_MINT. Devnet may rely on the built-in devnet mint; mainnet must name it.
  const mint = blank(env.SOLANA_USDC_MINT) ? null : (env.SOLANA_USDC_MINT as string).trim();
  if (mint !== null && !isValidSolanaAddress(mint)) errors.push('SOLANA_USDC_MINT is not a valid base58-encoded 32-byte Solana public key');
  if (mint !== null && !blank(env.SOLANA_USDC_TREASURY) && (env.SOLANA_USDC_TREASURY as string).trim() === mint) {
    errors.push('SOLANA_USDC_TREASURY must be the treasury owner address, not the USDC mint');
  }
  const legacy = blank(env.SOLANA_USDC_MAINNET_MINT) ? null : (env.SOLANA_USDC_MAINNET_MINT as string).trim();
  if (legacy !== null && legacy !== mint) {
    warnings.push('SOLANA_USDC_MAINNET_MINT is deprecated and IGNORED (it differs from, or is set without, SOLANA_USDC_MINT): the one mint source is SOLANA_USDC_MINT');
  }

  // RPC endpoint. The unset default is the devnet endpoint, which is never acceptable for mainnet.
  let rpc: URL | null = null;
  if (!blank(env.SOLANA_RPC_URL)) {
    try {
      rpc = new URL((env.SOLANA_RPC_URL as string).trim());
      if (rpc.protocol !== 'https:' && rpc.protocol !== 'http:') throw new Error('protocol');
    } catch {
      rpc = null;
      errors.push('SOLANA_RPC_URL is not a valid http(s) URL');
    }
  }
  if (rpc && !mainnet && /mainnet/i.test(rpc.href)) {
    errors.push('SOLANA_RPC_URL looks like a mainnet endpoint but SOLANA_NETWORK is solana-devnet');
  }

  // MoonPay key environment must match the network: a live key delivers real USDC, a test key delivers fake funds.
  const moonpayKey = blank(env.MOONPAY_PUBLISHABLE_KEY) ? null : (env.MOONPAY_PUBLISHABLE_KEY as string).trim();
  if (moonpayKey !== null) {
    if (moonpayKey.startsWith('pk_live_')) {
      if (!mainnet) errors.push('MOONPAY_PUBLISHABLE_KEY is a live key (pk_live_) but SOLANA_NETWORK is solana-devnet: live keys are allowed only with solana-mainnet');
    } else if (moonpayKey.startsWith('pk_test_')) {
      if (mainnet) errors.push('MOONPAY_PUBLISHABLE_KEY is a test key (pk_test_) but SOLANA_NETWORK is solana-mainnet: test keys are allowed only with solana-devnet');
    } else {
      errors.push('MOONPAY_PUBLISHABLE_KEY must start with pk_test_ or pk_live_');
    }
  }

  const liveFlags = LIVE_FUNDS_FLAGS.filter((flag) => looksEnabled(env[flag]));
  if (liveFlags.length && !productionLike) {
    errors.push(`${liveFlags.join(' and ')} (live funds) are refused outside a production-like runtime; development and test never run live funds, set NODE_ENV=production for a real deployment`);
  }

  if (!mainnet) {
    // Devnet must never look live.
    if (liveFlags.length) errors.push(`${liveFlags.join(' and ')} must not be enabled while SOLANA_NETWORK is solana-devnet (live flags are for solana-mainnet only)`);
    return;
  }

  // ---- mainnet: every requirement is explicit ----
  if (!productionLike) errors.push('SOLANA_NETWORK=solana-mainnet requires a production-like runtime (NODE_ENV=production); development and test never touch mainnet');
  if (mode !== 'devnet') errors.push('SOLANA_NETWORK=solana-mainnet requires WALLET_CHAIN_MODE=devnet (the real RPC adapter; "sandbox" is an in-memory mock)');
  for (const flag of LIVE_FUNDS_FLAGS) {
    if (env[flag] !== 'true') errors.push(`SOLANA_NETWORK=solana-mainnet requires ${flag} to be exactly "true"`);
  }
  if (!liveFlags.length && env.WALLET_LIVE_ACKNOWLEDGED !== LIVE_FUNDS_ACK_VALUE) {
    errors.push(`SOLANA_NETWORK=solana-mainnet requires WALLET_LIVE_ACKNOWLEDGED=${LIVE_FUNDS_ACK_VALUE}`);
  }
  if (mint === null) errors.push('SOLANA_USDC_MINT is required for solana-mainnet (copy it from Circle\'s official USDC contract-address page; there is no built-in mainnet mint)');
  if (blank(env.SOLANA_RPC_URL)) {
    errors.push('SOLANA_RPC_URL is required for solana-mainnet (there is no default: an unset value would silently use the devnet endpoint)');
  } else if (rpc) {
    if (rpc.protocol !== 'https:') errors.push('SOLANA_RPC_URL must be https for solana-mainnet');
    const host = hostOf(rpc);
    if (/devnet|testnet/.test(host) || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
      errors.push('SOLANA_RPC_URL must be an explicit non-default, non-devnet, non-local endpoint for solana-mainnet');
    }
  }
}

/**
 * Pure environment validation. Performs no I/O and never logs.
 *
 * Production-like means anything other than exactly NODE_ENV=development|test (see isNonProductionRuntime).
 * "Admin wallet API enabled" means ADMIN_API_TOKEN is set: the admin guard fails closed when it is unset,
 * so a set token is the only way that surface is reachable.
 */
export function validateEnv(env: EnvLike): EnvValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const productionLike = !isNonProductionRuntime(env);

  // --- NODE_ENV -----------------------------------------------------------------------------------------
  if (!isKnownNodeEnv(env)) {
    const shown = env.NODE_ENV === undefined ? '<unset>' : JSON.stringify(env.NODE_ENV);
    warnings.push(
      `NODE_ENV is ${shown}, not one of development|test|production. It is treated as production-like (strict) for every safety gate; set NODE_ENV=development for local runs.`,
    );
  }

  // --- Production requirements ----------------------------------------------------------------------------
  if (productionLike) {
    // Production-like is exactly "production" or an unrecognised value; only the latter needs spelling out.
    const hint = isKnownNodeEnv(env) ? '' : ` (NODE_ENV=${describeNodeEnv(env)} is production-like)`;
    if (blank(env.DATABASE_URL)) {
      errors.push(`DATABASE_URL is required in production${hint}`);
    } else if (!/^postgres(ql)?:\/\//i.test((env.DATABASE_URL as string).trim())) {
      errors.push('DATABASE_URL must be a postgres:// or postgresql:// connection string');
    }

    const treasury = env.SOLANA_USDC_TREASURY?.trim();
    if (!treasury) {
      errors.push(`SOLANA_USDC_TREASURY is required in production and must be a base58 Solana public key${hint}`);
    } else if (!isValidSolanaAddress(treasury)) {
      errors.push('SOLANA_USDC_TREASURY is not a valid base58-encoded 32-byte Solana public key');
    } else if (/^1+$/.test(treasury)) {
      errors.push('SOLANA_USDC_TREASURY must not be the all-zero system address');
    }

    const mode = blank(env.WALLET_CHAIN_MODE) ? 'sandbox' : (env.WALLET_CHAIN_MODE as string).trim();
    if (mode === 'sandbox') {
      errors.push('WALLET_CHAIN_MODE must be set explicitly and must not be "sandbox" in production (unset defaults to the in-memory mock chain)');
    } else if (mode !== 'devnet') {
      errors.push(`WALLET_CHAIN_MODE "${mode}" is not supported (expected "devnet" outside sandbox)`);
    }

    const adminToken = env.ADMIN_API_TOKEN;
    if (adminToken && adminToken.trim().length < MIN_ADMIN_TOKEN_LENGTH) {
      errors.push(`ADMIN_API_TOKEN must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters when the admin wallet API is enabled (token is set; length ${adminToken.trim().length})`);
    }

    if (blank(env.STOREFRONT_ORIGIN)) {
      warnings.push('STOREFRONT_ORIGIN is unset: CORS will reject every browser origin');
    }
    if (env.ENABLE_API_DOCS === 'true') {
      warnings.push('ENABLE_API_DOCS=true: Swagger UI is exposed at /docs in a production-like runtime');
    }
  } else if (env.ADMIN_API_TOKEN && env.ADMIN_API_TOKEN.trim().length < MIN_ADMIN_TOKEN_LENGTH) {
    warnings.push(`ADMIN_API_TOKEN is shorter than ${MIN_ADMIN_TOKEN_LENGTH} characters; this would be refused in production`);
  }

  // --- Live-funds ACK (every environment) -----------------------------------------------------------------
  const liveFlags = LIVE_FUNDS_FLAGS.filter((flag) => looksEnabled(env[flag]));
  const acknowledged = env.WALLET_LIVE_ACKNOWLEDGED === LIVE_FUNDS_ACK_VALUE;
  if (liveFlags.length && !acknowledged) {
    errors.push(
      `${liveFlags.join(' and ')} ${liveFlags.length === 1 ? 'enables' : 'enable'} live funds and ${liveFlags.length === 1 ? 'requires' : 'require'} WALLET_LIVE_ACKNOWLEDGED=${LIVE_FUNDS_ACK_VALUE} to be set explicitly`,
    );
  } else if (liveFlags.length) {
    warnings.push(`LIVE FUNDS ENABLED (${liveFlags.join(', ')}) with explicit acknowledgement`);
  } else if (!blank(env.WALLET_LIVE_ACKNOWLEDGED)) {
    warnings.push('WALLET_LIVE_ACKNOWLEDGED is set but no live-funds flag is enabled; remove it to avoid pre-authorising a later flag change');
  }

  // --- Solana network / mint / RPC / MoonPay consistency ------------------------------------------------
  validateSolanaNetworkEnv(env, productionLike, errors, warnings);

  // --- HTTP surface ---------------------------------------------------------------------------------------
  const cors = parseCorsOrigins(env.STOREFRONT_ORIGIN);
  for (const { entry, reason } of cors.invalid) errors.push(`STOREFRONT_ORIGIN entry ${JSON.stringify(entry)} rejected: ${reason}`);
  if (productionLike) {
    for (const origin of cors.origins) {
      const { protocol, hostname } = new URL(origin);
      if (protocol === 'http:' && hostname !== 'localhost' && hostname !== '127.0.0.1') {
        warnings.push(`STOREFRONT_ORIGIN ${origin} is plain http in a production-like runtime`);
      }
    }
  }

  const proxy = parseTrustProxy(env.TRUST_PROXY);
  if (proxy.error) errors.push(proxy.error);

  if (!blank(env.PORT)) {
    const port = parsePositiveInt(env.PORT);
    if (port === null || port > 65535) errors.push('PORT must be an integer between 1 and 65535');
  }

  for (const name of Object.values(RATE_LIMIT_ENV)) {
    if (!blank(env[name]) && parsePositiveInt(env[name]) === null) errors.push(`${name} must be a positive integer (requests per minute)`);
  }

  return { errors, warnings };
}

/** validateEnv, then throw EnvValidationError listing every problem. Returns the warnings for the caller to log. */
export function assertValidEnv(env: EnvLike): string[] {
  const { errors, warnings } = validateEnv(env);
  if (errors.length) throw new EnvValidationError(errors);
  return warnings;
}
