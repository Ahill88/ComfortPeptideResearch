'use server';

import { actionApi, guardAction } from '../../lib/server/action-guard';
import type { ApiResult } from '../../lib/server/api';
import { EMAIL_STATUSES, type EmailOutboxItem, type InventoryItem, type InventoryMovement, type Page, type SanctionsStatus } from '../../lib/types';

type Result<T> = { ok: true; data: T } | { ok: false; message: string; data?: T };
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const validCursor = (cursor: string) => typeof cursor === 'string' && cursor.length <= 200;

export async function listInventory(q: string, lowStockOnly: boolean, cursor = ''): Promise<Result<Page<InventoryItem>>> {
  const guard = await guardAction();
  if (!guard.ok) return guard;
  if (typeof q !== 'string' || q.length > 100 || typeof lowStockOnly !== 'boolean' || !validCursor(cursor)) return { ok: false, message: 'Invalid inventory filters.' };
  return actionApi<Page<InventoryItem>>('/admin/inventory', { query: { q: q.trim(), lowStockOnly: String(lowStockOnly), limit: 25, cursor } });
}

// There is no GET /inventory/:id. Find the exact product in the API's SKU search, following its opaque cursors.
async function inventoryItem(productId: string, sku: string): Promise<Result<InventoryItem>> {
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let i = 0; i < 20; i += 1) {
    const result: ApiResult<Page<InventoryItem>> = await actionApi<Page<InventoryItem>>('/admin/inventory', { query: { q: sku, limit: 100, cursor } });
    if (!result.ok) return result;
    const item = result.data.items.find((p) => p.productId === productId);
    if (item) return { ok: true, data: item };
    cursor = result.data.nextCursor;
    if (!cursor || seen.has(cursor)) break;
    seen.add(cursor);
  }
  return { ok: false, message: 'The product could not be found in the current inventory search. Refresh the list.' };
}

export async function readInventoryItem(productId: string, sku: string): Promise<Result<InventoryItem>> {
  const guard = await guardAction();
  if (!guard.ok) return guard;
  if (!ID.test(productId) || typeof sku !== 'string' || sku.length > 200) return { ok: false, message: 'Invalid product.' };
  return inventoryItem(productId, sku);
}

export async function inventoryLedger(productId: string, cursor = ''): Promise<Result<Page<InventoryMovement>>> {
  const guard = await guardAction();
  if (!guard.ok) return guard;
  if (!ID.test(productId) || !validCursor(cursor)) return { ok: false, message: 'Invalid ledger request.' };
  return actionApi<Page<InventoryMovement>>(`/admin/inventory/${encodeURIComponent(productId)}/ledger`, { query: { limit: 50, cursor } });
}

export async function adjustInventory(productId: string, sku: string, delta: number, reason: string): Promise<Result<InventoryItem>> {
  const guard = await guardAction();
  if (!guard.ok) return guard;
  if (!ID.test(productId) || typeof sku !== 'string' || sku.length > 200) return { ok: false, message: 'Invalid product.' };
  if (!Number.isInteger(delta) || !delta || Math.abs(delta) > 100000) return { ok: false, message: 'Enter a non-zero whole number from -100000 to 100000.' };
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 200) return { ok: false, message: 'Enter a reason (1 to 200 characters).' };
  const result = await actionApi<InventoryItem>(`/admin/inventory/${encodeURIComponent(productId)}/adjust`, { method: 'POST', body: { delta, reason: reason.trim() } });
  if (result.ok) return result;
  const fresh = await inventoryItem(productId, sku);
  return { ok: false, message: result.message, ...(fresh.ok ? { data: fresh.data } : {}) };
}

export async function setInventoryThreshold(productId: string, lowStockThreshold: number | null): Promise<Result<InventoryItem>> {
  const guard = await guardAction('OWNER');
  if (!guard.ok) return guard;
  if (!ID.test(productId)) return { ok: false, message: 'Invalid product.' };
  if (lowStockThreshold !== null && (!Number.isInteger(lowStockThreshold) || lowStockThreshold < 0 || lowStockThreshold > 2147483647)) return { ok: false, message: 'Enter a whole number from 0 to 2147483647, or leave blank to clear.' };
  return actionApi<InventoryItem>(`/admin/inventory/${encodeURIComponent(productId)}/threshold`, { method: 'POST', body: { lowStockThreshold } });
}

export async function readSanctions(): Promise<Result<SanctionsStatus>> {
  const guard = await guardAction();
  if (!guard.ok) return guard;
  return actionApi<SanctionsStatus>('/admin/compliance/sanctions');
}

export async function refreshSanctions(force: boolean): Promise<Result<SanctionsStatus>> {
  const guard = await guardAction('OWNER');
  if (!guard.ok) return guard;
  if (typeof force !== 'boolean') return { ok: false, message: 'Invalid refresh option.' };
  // Download (60 s) and storage may take longer than the normal 10 s API deadline.
  const result = await actionApi<SanctionsStatus>('/admin/compliance/sanctions/refresh', { method: 'POST', body: force ? { force: true } : {}, timeoutMs: 140000 });
  if (result.ok) return result;
  const fresh = await actionApi<SanctionsStatus>('/admin/compliance/sanctions');
  return { ok: false, message: result.message, ...(fresh.ok ? { data: fresh.data } : {}) };
}

export async function listEmailOutbox(status: string, cursor = ''): Promise<Result<Page<EmailOutboxItem>>> {
  const guard = await guardAction('OWNER');
  if (!guard.ok) return guard;
  if ((status !== '' && !(EMAIL_STATUSES as readonly string[]).includes(status)) || !validCursor(cursor)) return { ok: false, message: 'Invalid outbox filters.' };
  return actionApi<Page<EmailOutboxItem>>('/admin/email/outbox', { query: { status, limit: 50, cursor } });
}

export async function retryEmail(id: string): Promise<Result<EmailOutboxItem>> {
  const guard = await guardAction('OWNER');
  if (!guard.ok) return guard;
  if (!ID.test(id)) return { ok: false, message: 'Invalid email.' };
  return actionApi<EmailOutboxItem>(`/admin/email/outbox/${encodeURIComponent(id)}/retry`, { method: 'POST', body: {} });
}
