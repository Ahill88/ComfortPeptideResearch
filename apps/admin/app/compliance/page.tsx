import { Shell } from '../../components/console/shell';
import { CompliancePanel } from '../../components/operations/compliance-panel';
import { callApi } from '../../lib/server/api';
import { expireOnUnauthorized, requireSession } from '../../lib/server/session';
import type { SanctionsStatus } from '../../lib/types';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Compliance - Helix & Field Operations' };
export default async function CompliancePage() {
  const auth = await requireSession();
  const result = await callApi<SanctionsStatus>('/admin/compliance/sanctions');
  expireOnUnauthorized(result);
  return <Shell auth={auth} active="compliance">
    <div className="page-head"><div><h1>Compliance</h1><p>Sanctions address screening status.</p></div></div>
    <p className="msg msg-info">This checks wallet addresses against one list: OFAC SDN digital currency addresses. It supports a compliance programme; it does not replace one. It does not screen names, countries or shipping addresses, or monitor transactions.</p>
    <CompliancePanel initial={result.ok ? result.data : null} initialError={result.ok ? '' : result.message} isOwner={auth.admin.role === 'OWNER'} />
  </Shell>;
}
