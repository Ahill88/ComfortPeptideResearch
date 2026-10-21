import { Shell } from '../../components/console/shell';
import { Forbidden } from '../../components/console/forbidden';
import { EmailOutbox } from '../../components/operations/email-outbox';
import { callApi } from '../../lib/server/api';
import { expireOnUnauthorized, requireSession } from '../../lib/server/session';
import { EMAIL_STATUSES, type EmailOutboxItem, type Page } from '../../lib/types';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Email outbox - Helix & Field Operations' };
export default async function EmailPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const auth = await requireSession();
  if (auth.admin.role !== 'OWNER') return <Shell auth={auth} active="email"><Forbidden what="Email outbox" /></Shell>;
  const params = await searchParams;
  const status = typeof params.status === 'string' && (EMAIL_STATUSES as readonly string[]).includes(params.status) ? params.status : '';
  const result = await callApi<Page<EmailOutboxItem>>('/admin/email/outbox', { query: { status, limit: 50 } });
  expireOnUnauthorized(result);
  return <Shell auth={auth} active="email">
    <div className="page-head"><div><h1>Email outbox</h1><p>Delivery status and retries. Recipient domains only; message bodies and links are not returned.</p></div></div>
    <form className="filters" action="/email"><div className="field"><label htmlFor="email-status">Delivery status</label><select id="email-status" name="status" defaultValue={status}><option value="">All statuses</option>{EMAIL_STATUSES.map((s) => <option key={s}>{s}</option>)}</select></div><button className="btn-primary">Apply filter</button></form>
    {result.ok ? <EmailOutbox key={status} initial={result.data} status={status} /> : <p className="msg msg-error" role="alert">Outbox could not be loaded: {result.message}</p>}
  </Shell>;
}
