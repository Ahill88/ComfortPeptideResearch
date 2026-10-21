import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { ADMIN_ROLES_KEY } from './admin.decorators';
import { ADMIN_SESSION_ABSOLUTE_MS, ADMIN_SESSION_IDLE_MS, type AdminRequest, type AdminRoleName } from './admin.types';

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Authenticates a back-office request from `Authorization: Bearer <session token>`. Fails closed: every failure is the same
 * 401 'Admin sign-in required.' (no hint which check failed). A valid session must be unrevoked, inside both the idle and
 * absolute lifetimes, and belong to an ACTIVE admin. lastSeenAt is refreshed at most once a minute. Roles are checked against
 * @AdminRoles (403 when the admin's role is not allowed).
 */
@Injectable()
export class AdminSessionGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService, private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const header = request.headers?.authorization;
    const match = typeof header === 'string' ? /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(header) : null;
    if (!match) throw new UnauthorizedException('Admin sign-in required.');

    const session = await this.prisma.adminSession.findUnique({ where: { tokenHash: hashSessionToken(match[1]) }, include: { admin: true } });
    const now = Date.now();
    if (
      !session || session.revokedAt || !session.admin.active ||
      session.expiresAt.getTime() <= now ||
      now - session.createdAt.getTime() > ADMIN_SESSION_ABSOLUTE_MS ||
      now - session.lastSeenAt.getTime() > ADMIN_SESSION_IDLE_MS
    ) {
      throw new UnauthorizedException('Admin sign-in required.');
    }
    if (now - session.lastSeenAt.getTime() > 60_000) {
      await this.prisma.adminSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date(now) } });
    }

    const allowed = this.reflector.getAllAndOverride<AdminRoleName[] | undefined>(ADMIN_ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (allowed && allowed.length > 0 && !allowed.includes(session.admin.role)) throw new ForbiddenException('Not permitted for this admin role.');

    request.admin = { id: session.admin.id, email: session.admin.email, name: session.admin.name, role: session.admin.role };
    request.adminSessionId = session.id;
    return true;
  }
}
