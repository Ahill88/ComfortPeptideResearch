import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerModuleOptions, ThrottlerOptions, ThrottlerRequest } from '@nestjs/throttler';
import { createHash } from 'node:crypto';
import { EnvLike, blank } from './runtime';

/**
 * Global, route-pattern-aware rate limiting. Controllers are owned by other engineers and carry no
 * @Throttle decorators, so limits are chosen centrally from the request path.
 *
 * Every request counts against the "default" bucket (per client IP, shared across all routes). Requests to
 * money-moving or credential/enumeration-prone routes ALSO count against a stricter named bucket, again per
 * client IP and shared across the routes of that class. Exceeding any bucket yields HTTP 429 + Retry-After.
 *
 * Storage is the in-process memory store: counters are per API instance and reset on restart. Behind N
 * replicas the effective limit is up to N times higher until a shared (Redis) store is plugged in.
 */

export const DEFAULT_BUCKET = 'default';
export type StrictBucketName = 'money' | 'auth';
export type BucketName = typeof DEFAULT_BUCKET | StrictBucketName;

export interface BucketLimit {
  limit: number;
  /** Window length in milliseconds. */
  ttl: number;
}
export type RateLimitConfig = Record<BucketName, BucketLimit>;

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  default: { limit: 120, ttl: 60_000 },
  money: { limit: 10, ttl: 60_000 },
  auth: { limit: 20, ttl: 60_000 },
};

/** Env var names that override each bucket's per-minute limit. */
export const RATE_LIMIT_ENV: Record<BucketName, string> = {
  default: 'THROTTLE_DEFAULT_LIMIT',
  money: 'THROTTLE_MONEY_LIMIT',
  auth: 'THROTTLE_AUTH_LIMIT',
};

export function parsePositiveInt(raw: string | undefined): number | null {
  if (blank(raw) || !/^\d+$/.test((raw as string).trim())) return null;
  const value = Number((raw as string).trim());
  return Number.isSafeInteger(value) && value >= 1 && value <= 1_000_000 ? value : null;
}

/** Invalid overrides fall back to the safe built-in default; validateEnv reports them as startup errors. */
export function loadRateLimitConfig(env: EnvLike = process.env): RateLimitConfig {
  const pick = (name: BucketName): BucketLimit => ({
    ttl: DEFAULT_RATE_LIMITS[name].ttl,
    limit: parsePositiveInt(env[RATE_LIMIT_ENV[name]]) ?? DEFAULT_RATE_LIMITS[name].limit,
  });
  return { default: pick('default'), money: pick('money'), auth: pick('auth') };
}

/**
 * Canonical form used for matching: no query string, percent-decoded (malformed escapes keep the raw text),
 * lower-cased (Express routing is case-insensitive), duplicate/trailing slashes removed, and the optional
 * version prefix ("/v1") dropped. Returns the remaining path segments.
 */
export function routeSegments(rawPath: string | undefined): string[] {
  let path = (rawPath ?? '').split('?')[0].split('#')[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep raw */
  }
  const segments = path.toLowerCase().split('/').filter(Boolean);
  if (segments.length && /^v\d+$/.test(segments[0])) segments.shift();
  return segments;
}

/**
 * Which strict bucket (if any) a request path belongs to. HTTP method is deliberately ignored so a verb
 * switch cannot dodge the limit.
 *   money: wallet/transfers/**, wallet/checkout/:orderId/submit, wallet/onramp/**
 *   auth : auth/**, admin/auth/login, admin/auth/change-password
 */
export function selectRateLimitBucket(rawPath: string | undefined): StrictBucketName | null {
  const [a, b, c, d, ...rest] = routeSegments(rawPath);
  if (a === 'auth') return 'auth';
  // Back-office sign-in and password change: guessable credentials, same strict per-IP bucket as customer auth.
  if (a === 'admin' && b === 'auth' && (c === 'login' || c === 'change-password')) return 'auth';
  if (a === 'wallet') {
    if (b === 'transfers') return 'money';
    if (b === 'onramp') return 'money';
    if (b === 'checkout' && c !== undefined && d === 'submit' && rest.length === 0) return 'money';
  }
  return null;
}

export function buildThrottlers(config: RateLimitConfig): ThrottlerOptions[] {
  return (Object.keys(config) as BucketName[]).map((name) => ({ name, limit: config[name].limit, ttl: config[name].ttl }));
}

export function buildThrottlerModuleOptions(env: EnvLike = process.env): ThrottlerModuleOptions {
  return {
    throttlers: buildThrottlers(loadRateLimitConfig(env)),
    errorMessage: 'Too many requests. Please slow down and retry later.',
  };
}

interface RequestLike {
  path?: string;
  url?: string;
  method?: string;
  ip?: string;
  socket?: { remoteAddress?: string };
}

@Injectable()
export class RouteAwareThrottlerGuard extends ThrottlerGuard {
  /** CORS preflights carry no credentials or side effects and are answered by the CORS middleware first. */
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    const { req } = this.getRequestResponse(context);
    return (req as RequestLike).method === 'OPTIONS';
  }

  protected async handleRequest(props: ThrottlerRequest): Promise<boolean> {
    const { req } = this.getRequestResponse(props.context);
    const request = req as RequestLike;
    const bucket = selectRateLimitBucket(request.path ?? request.url);
    const name = props.throttler.name ?? DEFAULT_BUCKET;
    // Strict buckets only apply to their own routes; the default bucket applies to everything.
    if (name !== DEFAULT_BUCKET && name !== bucket) return true;
    return super.handleRequest(props);
  }

  /**
   * req.ip only. Express derives it from the socket unless `trust proxy` was configured (TRUST_PROXY), so a
   * client-supplied X-Forwarded-For is never read here. IPv6 is grouped by /64 by the base class.
   */
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const request = req as RequestLike;
    return super.getTracker({ ip: request.ip || request.socket?.remoteAddress || 'unknown' });
  }

  /** One counter per bucket+client (not per handler), so the limit cannot be multiplied by spreading across routes. */
  protected generateKey(_context: ExecutionContext, tracker: string, name: string): string {
    return createHash('sha256').update(`${name}:${tracker}`).digest('hex');
  }

  /** Expose the standard Retry-After header regardless of which named bucket tripped. */
  protected setResponseHeader(res: Record<string, any>, name: string, value: string | number): void {
    super.setResponseHeader(res, name.startsWith('Retry-After-') ? 'Retry-After' : name, value);
  }
}
