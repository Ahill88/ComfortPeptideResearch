import { redirect } from 'next/navigation';
import { loadSession } from '../../lib/server/session';
import SignInForm from './sign-in-form';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sign in - Helix & Field Operations' };

const NOTICES: Record<string, { kind: 'info' | 'warn'; text: string }> = {
  expired: { kind: 'warn', text: 'Your session expired. Sign in again to continue.' },
  'signed-out': { kind: 'info', text: 'You have been signed out.' },
};

export default async function SignIn({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if ((await loadSession()).state === 'ok') redirect('/');
  const reason = (await searchParams).reason;
  const notice = typeof reason === 'string' ? NOTICES[reason] : undefined;

  return (
    <main className="access-page">
      <section className="access-panel" aria-labelledby="access-title">
        <p className="eyebrow">Helix &amp; Field / Operations</p>
        <h1 id="access-title">Sign in</h1>
        {notice && <p className={`msg msg-${notice.kind}`} role="status">{notice.text}</p>}
        <SignInForm />
        <p className="access-note">Staff and owner accounts only. Accounts are created by an owner.</p>
      </section>
    </main>
  );
}
