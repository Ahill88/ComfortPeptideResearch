import { EnvLike, isNonProductionRuntime } from './runtime';

interface Req {
  path?: string;
  url?: string;
}
interface Res {
  setHeader(name: string, value: string): unknown;
}

/** Swagger UI needs inline scripts/styles, so it is exempt from the API-only CSP. */
const DOCS_PATH = /^\/docs(?:[/-]|$)/;

/**
 * Helmet-equivalent headers for a JSON API, set manually to avoid a new dependency. Controllers may still
 * override any of them (they are set before the route handler runs).
 */
export function securityHeaders(env: EnvLike = process.env) {
  const hsts = !isNonProductionRuntime(env);
  return (req: Req, res: Res, next: (err?: unknown) => void): void => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    if (!DOCS_PATH.test(req.path ?? req.url ?? '')) {
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    }
    if (hsts) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    next();
  };
}
