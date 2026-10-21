import { requireSession } from '../../lib/server/session';

/**
 * Every wallet page calls this before fetching or rendering any operational data.
 * It verifies the httpOnly session cookie through GET /admin/auth/me (no cookie -> /sign-in, expired -> cleared and
 * /sign-in?reason=expired). The wallet pages' own data fetching (x-admin-token endpoints) is unchanged.
 */
export async function requireAdminSession(): Promise<void> {
  await requireSession();
}
