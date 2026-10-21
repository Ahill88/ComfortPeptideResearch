import { ENTITY_ID } from '../../../../lib/coa';
import { fetchStream } from '../../../../lib/server/api';
import { loadSession } from '../../../../lib/server/session';

export const dynamic = 'force-dynamic';

const plain = (status: number, text: string) =>
  new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
const to = (location: string) => new Response(null, { status: 303, headers: { Location: location, 'cache-control': 'no-store' } });

/** Streams the stored PDF (any status) to the signed-in admin. The bearer token is attached server-side only. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await loadSession();
  if (session.state === 'none') return to('/sign-in');
  if (session.state === 'expired') return to('/session/expired');
  if (session.state !== 'ok') return plain(503, 'The admin API could not be reached.');
  const { id } = await params;
  if (!ENTITY_ID.test(id)) return plain(404, 'Not found.');

  const upstream = await fetchStream(`/admin/coas/${encodeURIComponent(id)}/file`);
  if (!upstream.ok) {
    if (upstream.kind === 'unauthorized') return to('/session/expired');
    return plain(upstream.kind === 'not-found' ? 404 : upstream.kind === 'forbidden' ? 403 : 502, upstream.kind === 'not-found' ? 'Not found.' : upstream.message);
  }
  const headers = new Headers({
    // We set the type ourselves: whatever the upstream claims, this route only ever serves a PDF, inline, unsniffed.
    'content-type': 'application/pdf',
    'content-disposition': 'inline; filename="certificate-of-analysis.pdf"',
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-store',
  });
  const length = upstream.response.headers.get('content-length');
  if (length && /^\d+$/.test(length) && !upstream.response.headers.get('content-encoding')) headers.set('content-length', length);
  return new Response(upstream.response.body, { status: 200, headers });
}
