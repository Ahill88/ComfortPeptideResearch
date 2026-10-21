'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ENTITY_ID, LOT_CODE, SHA256_HEX } from '../../lib/coa';
import type { AdminCoa, AdminLotDetail, AdminLotSummary, AdminProduct, AnchorKind } from '../../lib/types';
import { actionApi, guardAction } from '../../lib/server/action-guard';
import { callApi } from '../../lib/server/api';
import { clearSessionCookie, loadSession } from '../../lib/server/session';

// Mutations return the fresh lot (when it can be re-read) so the screen always shows what the API now holds.
export type CoaActionResult =
  | { ok: true; message: string; detail: AdminLotDetail | null; coa: AdminCoa | null }
  | { ok: false; message: string; detail?: AdminLotDetail | null };

async function readLot(lotId: string): Promise<AdminLotDetail | null> {
  const fresh = await callApi<AdminLotDetail>(`/admin/lots/${encodeURIComponent(lotId)}`);
  return fresh.ok ? fresh.data : null;
}

async function mutateCoa(lotId: string, call: () => Promise<{ ok: true; data: AdminCoa | undefined } | { ok: false; kind: string; message: string }>, success: string): Promise<CoaActionResult> {
  const result = await call();
  if (result.ok) return { ok: true, message: success, detail: await readLot(lotId), coa: result.data ?? null };
  // After a conflict or validation failure the screen may be stale: hand back fresh state.
  if (result.kind === 'conflict' || result.kind === 'invalid' || result.kind === 'not-found') return { ok: false, message: result.message, detail: await readLot(lotId) };
  return { ok: false, message: result.message };
}

export async function publishCoa(lotId: string, coaId: string, confirmSha256: string): Promise<CoaActionResult> {
  const guard = await guardAction('OWNER');
  if (!guard.ok) return guard;
  if (!ENTITY_ID.test(lotId) || !ENTITY_ID.test(coaId)) return { ok: false, message: 'Invalid request.' };
  if (!SHA256_HEX.test(confirmSha256)) return { ok: false, message: 'The stored hash is not a valid SHA-256. Reload the page.' };
  return mutateCoa(lotId, () => actionApi<AdminCoa>(`/admin/coas/${encodeURIComponent(coaId)}/publish`, { method: 'POST', body: { confirmSha256 } }),
    'Published. The COA is now public and an anchor was requested.');
}

export async function revokeCoa(lotId: string, coaId: string, reason: string): Promise<CoaActionResult> {
  const guard = await guardAction('OWNER');
  if (!guard.ok) return guard;
  if (!ENTITY_ID.test(lotId) || !ENTITY_ID.test(coaId)) return { ok: false, message: 'Invalid request.' };
  const clean = reason.trim();
  if (!clean) return { ok: false, message: 'Enter the reason for the revocation.' };
  if (clean.length > 500) return { ok: false, message: 'The reason is limited to 500 characters.' };
  return mutateCoa(lotId, () => actionApi<AdminCoa>(`/admin/coas/${encodeURIComponent(coaId)}/revoke`, { method: 'POST', body: { reason: clean } }),
    'Revoked. The reason is public and a revoke anchor was requested.');
}

export async function retryAnchor(lotId: string, coaId: string, kind: AnchorKind): Promise<CoaActionResult> {
  const guard = await guardAction('OWNER');
  if (!guard.ok) return guard;
  if (!ENTITY_ID.test(lotId) || !ENTITY_ID.test(coaId) || (kind !== 'PUBLISH' && kind !== 'REVOKE')) return { ok: false, message: 'Invalid request.' };
  return mutateCoa(lotId, () => actionApi<AdminCoa>(`/admin/coas/${encodeURIComponent(coaId)}/anchor/retry`, { method: 'POST', body: { kind } }),
    `${kind === 'PUBLISH' ? 'Publish' : 'Revoke'} anchor requested again.`);
}

/** DRAFT only; the API allows an owner or the uploader, so no role gate here: its 403 message is shown. */
export async function deleteDraft(lotId: string, coaId: string): Promise<CoaActionResult> {
  const guard = await guardAction();
  if (!guard.ok) return guard;
  if (!ENTITY_ID.test(lotId) || !ENTITY_ID.test(coaId)) return { ok: false, message: 'Invalid request.' };
  return mutateCoa(lotId, async () => {
    const r = await actionApi<void>(`/admin/coas/${encodeURIComponent(coaId)}`, { method: 'DELETE' });
    return r.ok ? { ok: true as const, data: undefined } : r;
  }, 'Draft deleted.');
}

export type LotRefresh = { ok: true; detail: AdminLotDetail } | { ok: false; message: string };

/** Read-only refresh used by the anchor poll and after uploads. */
export async function refreshLot(lotId: string): Promise<LotRefresh> {
  const s = await loadSession();
  if (s.state === 'none') redirect('/sign-in');
  if (s.state === 'expired') { await clearSessionCookie(); redirect('/sign-in?reason=expired'); }
  if (s.state !== 'ok') return { ok: false, message: 'The admin API could not be reached.' };
  if (!ENTITY_ID.test(lotId)) return { ok: false, message: 'Invalid lot.' };
  const result = await actionApi<AdminLotDetail>(`/admin/lots/${encodeURIComponent(lotId)}`);
  return result.ok ? { ok: true, detail: result.data } : { ok: false, message: result.message };
}

// ---- lots
export type CreateLotResult = { ok: true; lot: AdminLotSummary } | { ok: false; message: string; field?: 'productId' | 'code' };

export async function createLot(input: { productId: string; code: string }): Promise<CreateLotResult> {
  const guard = await guardAction();
  if (!guard.ok) return guard;
  const code = String(input.code ?? '').trim();
  if (!ENTITY_ID.test(String(input.productId ?? ''))) return { ok: false, message: 'Choose a product.', field: 'productId' };
  if (!LOT_CODE.test(code)) return { ok: false, message: 'Lot code must match the allowed pattern.', field: 'code' };
  const result = await actionApi<AdminLotSummary>('/admin/lots', { method: 'POST', body: { productId: input.productId, code } });
  if (result.ok) { revalidatePath('/lots'); return { ok: true, lot: result.data }; }
  return { ok: false, message: result.message, field: result.kind === 'conflict' || result.kind === 'invalid' ? 'code' : undefined };
}

export type LoadMoreLotsResult = { ok: true; items: AdminLotSummary[]; nextCursor: string | null } | { ok: false; message: string };

export async function loadMoreLots(input: { productId: string; q: string; cursor: string }): Promise<LoadMoreLotsResult> {
  const s = await loadSession();
  if (s.state === 'none') redirect('/sign-in');
  if (s.state === 'expired') { await clearSessionCookie(); redirect('/sign-in?reason=expired'); }
  if (s.state !== 'ok') return { ok: false, message: 'The admin API could not be reached.' };
  if (!input.cursor || input.cursor.length > 500 || (input.productId && !ENTITY_ID.test(input.productId)) || input.q.length > 100) return { ok: false, message: 'Invalid request.' };
  const result = await actionApi<{ items: AdminLotSummary[]; nextCursor: string | null }>('/admin/lots', { query: { productId: input.productId, q: input.q.trim(), limit: 25, cursor: input.cursor } });
  if (!result.ok) return { ok: false, message: result.message };
  return { ok: true, items: result.data.items, nextCursor: result.data.nextCursor ?? null };
}

// ---- products
export type ProductActionResult = { ok: true; message: string; product: AdminProduct } | { ok: false; message: string };

export async function setProductPublished(productId: string, publish: boolean): Promise<ProductActionResult> {
  const guard = await guardAction('OWNER');
  if (!guard.ok) return guard;
  if (!ENTITY_ID.test(productId)) return { ok: false, message: 'Invalid product.' };
  const result = await actionApi<AdminProduct>(`/admin/catalog/products/${encodeURIComponent(productId)}/${publish ? 'publish' : 'unpublish'}`, { method: 'POST', body: {} });
  if (!result.ok) return { ok: false, message: result.message };
  revalidatePath('/products');
  return { ok: true, message: publish ? 'Product published (active).' : 'Product unpublished (inactive).', product: result.data };
}

export async function refreshProducts(): Promise<{ ok: true; items: AdminProduct[] } | { ok: false; message: string }> {
  const s = await loadSession();
  if (s.state === 'none') redirect('/sign-in');
  if (s.state === 'expired') { await clearSessionCookie(); redirect('/sign-in?reason=expired'); }
  if (s.state !== 'ok') return { ok: false, message: 'The admin API could not be reached.' };
  const result = await actionApi<{ items: AdminProduct[] }>('/admin/catalog/products');
  return result.ok ? { ok: true, items: result.data.items } : { ok: false, message: result.message };
}
