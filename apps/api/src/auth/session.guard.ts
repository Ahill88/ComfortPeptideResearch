import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CUSTOMER_EMAIL_HEADER, resolveHeaderCustomer } from '../wallet/customer-identity';

export { CUSTOMER_EMAIL_HEADER };

/** The authenticated principal attached to the request by SessionGuard. */
export interface AuthenticatedSession {
  customerId: string;
  email: string;
  /** Always 'development-identity' today: there is no credential store or server-issued session yet. */
  source: 'development-identity';
}

type RequestLike = { headers?: Record<string, string | string[] | undefined>; session?: AuthenticatedSession };

/**
 * Server-side session guard for account routes.
 *
 * There is no credential store, so no server-issued session can exist yet; `validateIssuedSession`
 * is the single seam where one will be verified once login is built. Until then:
 *  - every runtime except exactly NODE_ENV=development|test (production, unset, staging, ...): ALWAYS 401
 *    (fail closed). Client-supplied identity headers are never trusted.
 *  - development/test only: the `x-customer-email` development identity is accepted via the shared
 *    resolver (../wallet/customer-identity), but only for a customer row that already exists. Nothing is
 *    auto-created. This is a restricted development identity, not authentication.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestLike>();

    const issued = await this.validateIssuedSession(request);
    if (issued) {
      request.session = issued;
      return true;
    }

    // Development identity: the shared resolver evaluates the allowlist gate per request (deny by default).
    const { email, customer } = await resolveHeaderCustomer(request?.headers, (value) =>
      this.prisma.customer.findUnique({ where: { email: value }, select: { id: true } }),
    );

    request.session = { customerId: customer.id, email, source: 'development-identity' };
    return true;
  }

  /** No session store exists yet, so there is never a valid server-issued session. */
  protected async validateIssuedSession(_request: RequestLike): Promise<AuthenticatedSession | null> {
    return null;
  }
}

export const CurrentSession = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthenticatedSession => {
  const session = ctx.switchToHttp().getRequest<RequestLike>().session;
  if (!session) throw new UnauthorizedException('Authentication required');
  return session;
});
