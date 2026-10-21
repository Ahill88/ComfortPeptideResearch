import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CUSTOMER_EMAIL_HEADER, resolveHeaderCustomer, resolveRequestIdentity, type IdentityRequest } from '../wallet/customer-identity';

export { CUSTOMER_EMAIL_HEADER };

/** The authenticated principal attached to the request by SessionGuard. */
export interface AuthenticatedSession {
  customerId: string;
  email: string;
  /** 'session' = a valid hf_session cookie (any runtime); 'development-identity' = the x-customer-email header (development/test only). */
  source: 'development-identity' | 'session';
  /** CustomerSession id; only present when source is 'session'. */
  sessionId?: string;
}

type RequestLike = IdentityRequest & { session?: AuthenticatedSession };

/**
 * Server-side session guard for account routes, on top of the shared identity resolver (../wallet/customer-identity):
 *  - a valid `hf_session` cookie (resolved by CustomerSessionMiddleware) works in every runtime; state-changing requests
 *    identified this way also need an allow-listed Origin (403 otherwise);
 *  - the `x-customer-email` development identity is accepted ONLY when NODE_ENV is exactly development|test, and only for a
 *    customer row that already exists. Nothing is auto-created. In every other runtime the header is never read.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestLike>();
    const identity = resolveRequestIdentity(request);
    if (identity.source === 'session') {
      request.session = { customerId: identity.customerId, email: identity.email, source: 'session', sessionId: identity.sessionId };
      return true;
    }

    const { email, customer } = await resolveHeaderCustomer(request.headers, (value) =>
      this.prisma.customer.findUnique({ where: { email: value }, select: { id: true } }),
    );
    request.session = { customerId: customer.id, email, source: 'development-identity' };
    return true;
  }
}

export const CurrentSession = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthenticatedSession => {
  const session = ctx.switchToHttp().getRequest<RequestLike>().session;
  if (!session) throw new UnauthorizedException('Authentication required');
  return session;
});
