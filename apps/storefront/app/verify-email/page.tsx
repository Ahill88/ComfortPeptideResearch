import { VerifyEmailForm } from '../../components/auth/access-forms';
export const metadata = { title: 'Verify email', referrer: 'no-referrer' as const, robots: { index: false, follow: false } };
export default async function VerifyEmail({ searchParams }: { searchParams: Promise<{ token?: string | string[]; next?: string | string[] }> }) {
  const { token, next } = await searchParams;
  return <VerifyEmailForm token={typeof token === 'string' ? token : undefined} next={typeof next === 'string' ? next : undefined} />;
}
