import { ResetPasswordForm } from '../../components/auth/access-forms';
export const metadata = { title: 'Choose a new password', referrer: 'no-referrer' as const, robots: { index: false, follow: false } };
export default async function ResetPassword({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const { token } = await searchParams;
  return <ResetPasswordForm token={typeof token === 'string' ? token : undefined} />;
}
