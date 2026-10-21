import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { assertAllowedOrigin, type HeadersLike, type IdentityRequest } from '../wallet/customer-identity';
import { authError } from './auth.validation';

type Req = IdentityRequest & { headers: HeadersLike };
type Res = { setHeader: (name: string, value: string) => void };

/**
 * Applied to the whole /auth controller. Marks every response no-store and enforces the CSRF rule on every
 * state-changing /auth route (cookie or not): the request must carry an allow-listed Origin. Safe methods pass untouched.
 */
@Injectable()
export class AuthRequestGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const req = http.getRequest<Req>();
    http.getResponse<Res>().setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes((req.method ?? 'POST').toUpperCase())) assertAllowedOrigin(req.headers);
    return true;
  }
}

/** Requires a valid `hf_session` cookie (the identity attached by CustomerSessionMiddleware). The dev/test email header is NOT accepted on /auth. */
@Injectable()
export class CookieSessionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Req>();
    if (!req.customerSession) throw authError(401, 'Authentication required.');
    return true;
  }
}
