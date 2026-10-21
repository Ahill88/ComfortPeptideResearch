'use server';

import { CARRIERS, type AdminOrderDetail, type AdminOrderSummary, type Carrier } from '../../lib/types';
import { actionApi, guardAction } from '../../lib/server/action-guard';
import { callApi } from '../../lib/server/api';
import { clearSessionCookie, loadSession } from '../../lib/server/session';
import { redirect } from 'next/navigation';
import { QUEUE_TABS, ORDER_ID, queueQuery } from '../../lib/queue';

export type OrderActionResult =
  | { ok: true; order: AdminOrderDetail; message: string }
  | { ok: false; message: string; order?: AdminOrderDetail };

export type ActionName = 'start-packing' | 'ship' | 'mark-delivered' | 'cancel' | 'notes';

export interface ActionInput {
  action: ActionName;
  carrier?: string;
  trackingNumber?: string;
  note?: string;
  reason?: string;
}

const TRACKING = /^[A-Za-z0-9-]{6,40}$/;

const SUCCESS: Record<ActionName, string> = {
  'start-packing': 'Order moved to Packing.',
  ship: 'Order marked as shipped.',
  'mark-delivered': 'Order marked as delivered.',
  cancel: 'Order cancelled.',
  notes: 'Note added.',
};

/** Validates input, then calls the order action endpoint. The API remains the authority on allowed transitions. */
export async function runOrderAction(orderId: string, input: ActionInput): Promise<OrderActionResult> {
  const guard = await guardAction();
  if (!guard.ok) return guard;
  if (!ORDER_ID.test(orderId)) return { ok: false, message: 'Invalid order.' };

  let body: Record<string, unknown> = {};
  if (input.action === 'ship') {
    const carrier = input.carrier as Carrier;
    const trackingNumber = String(input.trackingNumber ?? '').replace(/\s+/g, '');
    const note = String(input.note ?? '').trim();
    if (!CARRIERS.includes(carrier)) return { ok: false, message: 'Choose a carrier.' };
    if (!TRACKING.test(trackingNumber)) return { ok: false, message: 'Tracking number must be 6 to 40 letters, digits or dashes.' };
    if (note.length > 500) return { ok: false, message: 'Shipment note is limited to 500 characters.' };
    body = note ? { carrier, trackingNumber, note } : { carrier, trackingNumber };
  } else if (input.action === 'cancel') {
    const reason = String(input.reason ?? '').trim();
    if (reason.length < 3) return { ok: false, message: 'Enter a reason for the cancellation.' };
    if (reason.length > 500) return { ok: false, message: 'Reason is limited to 500 characters.' };
    body = { reason };
  } else if (input.action === 'notes') {
    const note = String(input.note ?? '').trim();
    if (!note) return { ok: false, message: 'Enter a note.' };
    if (note.length > 1000) return { ok: false, message: 'Notes are limited to 1000 characters.' };
    body = { note };
  } else if (input.action !== 'start-packing' && input.action !== 'mark-delivered') {
    return { ok: false, message: 'Unknown action.' };
  }

  const result = await actionApi<AdminOrderDetail>(`/admin/orders/${encodeURIComponent(orderId)}/${input.action}`, { method: 'POST', body });
  if (result.ok) return { ok: true, order: result.data, message: SUCCESS[input.action] };

  // After a conflict the screen is stale: hand back fresh state so the action panel matches reality.
  if (result.kind === 'conflict' || result.kind === 'invalid') {
    const fresh = await callApi<AdminOrderDetail>(`/admin/orders/${encodeURIComponent(orderId)}`);
    if (fresh.ok) return { ok: false, message: result.message, order: fresh.data };
  }
  return { ok: false, message: result.message };
}

export type LoadMoreResult = { ok: true; items: AdminOrderSummary[]; nextCursor: string | null } | { ok: false; message: string };

export async function loadMoreOrders(input: { tab: string; q: string; cursor: string }): Promise<LoadMoreResult> {
  const s = await loadSession();
  if (s.state === 'none') redirect('/sign-in');
  if (s.state === 'expired') { await clearSessionCookie(); redirect('/sign-in?reason=expired'); }
  if (s.state !== 'ok') return { ok: false, message: 'The admin API could not be reached.' };
  if (!QUEUE_TABS.some((t) => t.slug === input.tab) || input.cursor.length > 500 || input.cursor.length === 0) return { ok: false, message: 'Invalid request.' };
  const result = await actionApi<{ items: AdminOrderSummary[]; nextCursor: string | null }>('/admin/orders', { query: { ...queueQuery(input.tab, input.q), cursor: input.cursor } });
  if (!result.ok) return { ok: false, message: result.message };
  return { ok: true, items: result.data.items, nextCursor: result.data.nextCursor ?? null };
}
