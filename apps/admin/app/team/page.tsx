import { Forbidden } from '../../components/console/forbidden';
import { Shell } from '../../components/console/shell';
import { TeamManager } from '../../components/team/team-manager';
import { callApi } from '../../lib/server/api';
import { expireOnUnauthorized, requireSession } from '../../lib/server/session';
import type { AdminUserRow } from '../../lib/types';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Team - Helix & Field Operations' };

export default async function Team() {
  const auth = await requireSession();
  if (auth.admin.role !== 'OWNER') return <Shell auth={auth} active="team"><Forbidden what="Team management" /></Shell>;
  const result = await callApi<{ items: AdminUserRow[] }>('/admin/users');
  expireOnUnauthorized(result);
  return (
    <Shell auth={auth} active="team">
      <div className="page-head"><div><h1>Team</h1><p>Admin accounts. Owners can create and deactivate accounts.</p></div></div>
      {!result.ok ? (
        result.kind === 'forbidden' ? <Forbidden what="Team management" /> : <p className="msg msg-error" role="alert">The team list could not be loaded: {result.message}</p>
      ) : (
        <TeamManager users={result.data.items} selfId={auth.admin.id} />
      )}
    </Shell>
  );
}
