import { clearSessionCookie } from '../../../lib/server/session';

export const dynamic = 'force-dynamic';

/**
 * Server components cannot modify cookies, so they redirect here when the API answers 401. This handler clears the
 * session cookie and continues to the sign-in page. A relative Location avoids trusting the Host header.
 * (Forcing a sign-out this way is harmless: it only ever clears the caller's own cookie.)
 */
export async function GET() {
  await clearSessionCookie();
  return new Response(null, { status: 303, headers: { Location: '/sign-in?reason=expired', 'Cache-Control': 'no-store' } });
}
