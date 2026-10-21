import { Shell } from '../../../components/console/shell';
import { PasswordForm } from '../../../components/team/password-form';
import { requireSession } from '../../../lib/server/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Change password - Helix & Field Operations' };

export default async function PasswordPage() {
  const auth = await requireSession();
  return (
    <Shell auth={auth} active="account">
      <div className="page-head"><div><h1>Change password</h1><p>For {auth.admin.email}.</p></div></div>
      <section className="panel" style={{ maxWidth: 520 }} aria-label="Change password">
        <PasswordForm />
      </section>
    </Shell>
  );
}
