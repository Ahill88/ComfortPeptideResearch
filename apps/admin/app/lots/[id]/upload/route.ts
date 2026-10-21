import { ENTITY_ID, MAX_PDF_BYTES } from '../../../../lib/coa';
import type { AdminCoa } from '../../../../lib/types';
import { callApi } from '../../../../lib/server/api';
import { sameOriginError } from '../../../../lib/server/origin';
import { clearSessionCookie, loadSession } from '../../../../lib/server/session';

export const dynamic = 'force-dynamic';

// Server actions are capped at 1 MB and next.config.ts is not ours to change, so the PDF upload is a same-origin route
// handler. It enforces what a server action would: same Origin, a live session, and the contract's file/field rules
// before anything is forwarded. The API re-validates everything and computes the SHA-256.
const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const TEXT_FIELDS = ['labName', 'labReportId', 'testedAt', 'method', 'purityPercent', 'notes'] as const;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const origin = await sameOriginError();
  if (origin) return reply(403, { ok: false, message: origin });
  const session = await loadSession();
  if (session.state === 'none') return reply(401, { ok: false, message: 'Sign in again to continue.', redirect: '/sign-in' });
  if (session.state === 'expired') {
    await clearSessionCookie();
    return reply(401, { ok: false, message: 'Your session expired. Nothing was uploaded.', redirect: '/sign-in?reason=expired' });
  }
  if (session.state !== 'ok') return reply(503, { ok: false, message: 'The admin API could not be reached. Nothing was uploaded.' });

  const { id } = await params;
  if (!ENTITY_ID.test(id)) return reply(400, { ok: false, message: 'Invalid lot.' });

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_PDF_BYTES + 256 * 1024) return reply(413, { ok: false, message: 'The upload is larger than 10 MB. Nothing was uploaded.' });

  let incoming: FormData;
  try {
    incoming = await request.formData();
  } catch {
    return reply(400, { ok: false, message: 'The upload could not be read. Choose the PDF again.' });
  }
  const file = incoming.get('file');
  if (!(file instanceof File) || file.size === 0) return reply(400, { ok: false, message: 'Choose the lab\'s PDF file.' });
  if (file.size > MAX_PDF_BYTES) return reply(400, { ok: false, message: 'The PDF is larger than 10 MB.' });
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder('latin1').decode(bytes.subarray(0, 5)) !== '%PDF-') return reply(400, { ok: false, message: 'That file is not a PDF (it does not start with %PDF-).' });

  const outgoing = new FormData();
  const name = (file.name || 'certificate.pdf').split(/[\\/]/).pop()!.replace(/[\u0000-\u001f"]/g, '').slice(0, 200) || 'certificate.pdf';
  outgoing.append('file', new Blob([bytes], { type: 'application/pdf' }), name);
  for (const key of TEXT_FIELDS) {
    const value = incoming.get(key);
    if (typeof value === 'string' && (value.trim() || key !== 'notes')) outgoing.append(key, value.trim());
  }

  const result = await callApi<AdminCoa>(`/admin/lots/${encodeURIComponent(id)}/coas`, { method: 'POST', form: outgoing, timeoutMs: 60000 });
  if (result.ok) return reply(201, { ok: true, coa: result.data });
  if (result.kind === 'unauthorized') {
    await clearSessionCookie();
    return reply(401, { ok: false, message: 'Your session expired. Nothing was uploaded.', redirect: '/sign-in?reason=expired' });
  }
  return reply(result.status >= 400 && result.status < 600 ? result.status : 502, { ok: false, message: result.message });
}
