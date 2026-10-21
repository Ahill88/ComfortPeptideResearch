import { headers } from 'next/headers';

/**
 * CSRF defence in depth for server actions (Next also compares Origin with Host itself, and the session cookie is
 * SameSite=Strict). Browsers always send Origin on cross-origin and same-origin POSTs; a missing or mismatching
 * Origin is refused. Returns an error message, or null when the request is same-origin.
 */
export async function sameOriginError(): Promise<string | null> {
  const h = await headers();
  const origin = h.get('origin');
  const host = h.get('x-forwarded-host') ?? h.get('host');
  if (!origin || !host) return 'The request was blocked because its origin could not be verified.';
  try {
    if (new URL(origin).host !== host) return 'The request was blocked because it came from a different origin.';
  } catch {
    return 'The request was blocked because its origin could not be verified.';
  }
  return null;
}
