import { notFound } from 'next/navigation';
import { Shell } from '../../../components/console/shell';
import { LotDetail } from '../../../components/coa/lot-detail';
import { callApi } from '../../../lib/server/api';
import { expireOnUnauthorized, requireSession } from '../../../lib/server/session';
import { storefrontBase } from '../../../lib/server/storefront';
import { ENTITY_ID } from '../../../lib/coa';
import type { AdminLotDetail } from '../../../lib/types';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Lot - Helix & Field Operations' };

export default async function LotPage({ params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSession();
  const { id } = await params;
  if (!ENTITY_ID.test(id)) notFound();
  const result = await callApi<AdminLotDetail>(`/admin/lots/${encodeURIComponent(id)}`);
  expireOnUnauthorized(result);
  if (!result.ok && result.kind === 'not-found') notFound();

  return (
    <Shell auth={auth} active="lots">
      {result.ok ? (
        <LotDetail key={result.data.lot.id} initial={result.data} role={auth.admin.role} verifyBase={storefrontBase()} />
      ) : (
        <div className="panel panel-error" role="alert">
          <h1>Lot unavailable</h1>
          <p>{result.message}</p>
          <p><a className="btn" href={`/lots/${encodeURIComponent(id)}`}>Retry</a> <a className="btn" href="/lots">Back to lots</a></p>
        </div>
      )}
    </Shell>
  );
}
