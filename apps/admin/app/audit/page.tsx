import { Forbidden } from '../../components/console/forbidden';
import { LocalTime } from '../../components/console/local-time';
import { Shell } from '../../components/console/shell';
import { Pager } from '../../components/wallets/ui';
import { callApi } from '../../lib/server/api';
import { expireOnUnauthorized, requireSession } from '../../lib/server/session';
import type { AuditRow } from '../../lib/types';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Audit log - Helix & Field Operations' };

const CURSOR = /^[A-Za-z0-9_=.-]{1,200}$/;
const pick = (v: string | string[] | undefined) => (typeof v === 'string' ? v.trim().slice(0, 100) : '');

function detailText(detail: unknown): string {
  if (detail === null || detail === undefined || detail === '') return '-';
  if (typeof detail === 'string') return detail;
  try { return JSON.stringify(detail); } catch { return '-'; }
}

export default async function Audit({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const auth = await requireSession();
  if (auth.admin.role !== 'OWNER') return <Shell auth={auth} active="audit"><Forbidden what="The audit log" /></Shell>;
  const params = await searchParams;
  const targetType = pick(params.targetType);
  const targetId = pick(params.targetId);
  const rawCursor = pick(params.cursor);
  const cursor = CURSOR.test(rawCursor) ? rawCursor : undefined;

  const result = await callApi<{ items: AuditRow[]; nextCursor: string | null }>('/admin/audit', { query: { limit: 50, cursor, targetType, targetId } });
  expireOnUnauthorized(result);
  const filtered = Boolean(targetType || targetId);

  return (
    <Shell auth={auth} active="audit">
      <div className="page-head"><div><h1>Audit log</h1><p>Admin actions, newest first.</p></div></div>

      <form className="filters" method="get" action="/audit" role="search" aria-label="Filter audit log">
        <div className="field"><label htmlFor="targetType">Target type</label><input id="targetType" name="targetType" type="text" defaultValue={targetType} placeholder="e.g. Order" autoComplete="off" /></div>
        <div className="field"><label htmlFor="targetId">Target ID</label><input id="targetId" name="targetId" type="text" defaultValue={targetId} autoComplete="off" /></div>
        <button className="btn-primary" type="submit">Apply filters</button>
        {filtered && <a className="btn" href="/audit">Clear</a>}
      </form>

      {!result.ok ? (
        result.kind === 'forbidden' ? <Forbidden what="The audit log" /> : <p className="msg msg-error" role="alert">The audit log could not be loaded: {result.message}</p>
      ) : result.data.items.length === 0 ? (
        <p className="empty" role="status">{filtered ? 'No audit entries match these filters.' : 'No audit entries yet.'}</p>
      ) : (
        <>
          <div className="table-wrap" role="region" aria-label="Audit entries" tabIndex={0}>
            <table className="data">
              <caption className="sr-only">Audit entries, newest first</caption>
              <thead><tr><th scope="col">When</th><th scope="col">Admin</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Detail</th><th scope="col">IP</th></tr></thead>
              <tbody>
                {result.data.items.map((row) => (
                  <tr key={row.id}>
                    <td className="nowrap"><LocalTime iso={row.createdAt} withSeconds /></td>
                    <td style={{ overflowWrap: 'anywhere' }}>{row.adminEmail ?? <span className="muted">System / unknown</span>}</td>
                    <td className="mono">{row.action}</td>
                    <td className="mono" style={{ overflowWrap: 'anywhere' }}>{row.targetType}{row.targetId ? `: ${row.targetId}` : ''}</td>
                    <td className="mono" style={{ overflowWrap: 'anywhere', maxWidth: 420 }}>{detailText(row.detail)}</td>
                    <td className="mono">{row.ip ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager base="/audit" current={cursor} next={result.data.nextCursor ?? null} keep={{ targetType, targetId }} label="Audit log" />
        </>
      )}
    </Shell>
  );
}
