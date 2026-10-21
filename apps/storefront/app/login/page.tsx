import { LoginForm } from '../../components/auth/access-forms';
export const metadata = { title: 'Sign in', robots: { index: false, follow: false } };
export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  return <LoginForm next={typeof next === 'string' ? next : undefined} />;
}
