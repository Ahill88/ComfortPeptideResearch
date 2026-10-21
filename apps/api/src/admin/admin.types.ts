/**
 * Shared back-office types. FIXED CONTRACT: other modules (admin auth, admin orders, ...) code against exactly these.
 *
 * Admin identity is a server-side session: an opaque random token (32 bytes, base64url) sent as `Authorization: Bearer <token>`.
 * Only the token's SHA-256 (hex) is stored (AdminSession.tokenHash). A session ends after ADMIN_SESSION_IDLE_MS without use,
 * after ADMIN_SESSION_ABSOLUTE_MS from creation, on logout (revokedAt), or when the admin account is deactivated.
 */
export type AdminRoleName = 'OWNER' | 'STAFF';

export interface AdminPrincipal {
  id: string;
  email: string;
  name: string;
  role: AdminRoleName;
}

export const ADMIN_SESSION_IDLE_MS = 30 * 60 * 1000;
export const ADMIN_SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;

/** Request shape after AdminSessionGuard has run. */
export interface AdminRequest {
  admin?: AdminPrincipal;
  adminSessionId?: string;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface AdminAuditInput {
  adminId: string | null;
  action: string; // e.g. 'order.ship', 'admin.login'
  targetType: string; // e.g. 'order', 'admin'
  targetId?: string | null;
  detail?: Record<string, unknown>;
  ip?: string | null;
}
