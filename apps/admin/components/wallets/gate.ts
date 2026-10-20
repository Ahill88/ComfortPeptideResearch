import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

/**
 * Identical gating to apps/admin/app/page.tsx: development-only session, otherwise redirect to /sign-in.
 * Every wallet page must call this before fetching or rendering any operational data.
 */
export async function requireAdminSession(): Promise<void> {
  const developmentSessionEnabled =
    process.env.NODE_ENV === 'development' &&
    process.env.ADMIN_DEV_SESSION === 'enabled';
  const cookieStore = await cookies();

  // Production must integrate an identity provider that verifies an admin role
  // and MFA server-side before rendering any operational data or actions.
  if (!developmentSessionEnabled || cookieStore.get('admin_dev_session')?.value !== 'active') {
    redirect('/sign-in');
  }
}
