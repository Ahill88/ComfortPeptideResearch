import { RegisterForm } from '../../components/auth/access-forms';
export const metadata = { title: 'Create account', robots: { index: false, follow: false } };
export default async function Register({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  return <RegisterForm next={typeof next === 'string' ? next : undefined} />;
}
