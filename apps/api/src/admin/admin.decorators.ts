import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AdminPrincipal, AdminRequest, AdminRoleName } from './admin.types';

export const ADMIN_ROLES_KEY = 'admin:roles';

/** Restrict a route (after AdminSessionGuard) to these roles. No decorator = any active admin. */
export const AdminRoles = (...roles: AdminRoleName[]) => SetMetadata(ADMIN_ROLES_KEY, roles);

/** The authenticated admin (set by AdminSessionGuard). Never undefined on a guarded route. */
export const CurrentAdmin = createParamDecorator((_data: unknown, context: ExecutionContext): AdminPrincipal => {
  const request = context.switchToHttp().getRequest<AdminRequest>();
  if (!request.admin) throw new Error('CurrentAdmin used on a route without AdminSessionGuard');
  return request.admin;
});

/** Client IP as Express resolved it (honours TRUST_PROXY). */
export const RequestIp = createParamDecorator((_data: unknown, context: ExecutionContext): string | null => {
  return context.switchToHttp().getRequest<AdminRequest>().ip ?? null;
});
