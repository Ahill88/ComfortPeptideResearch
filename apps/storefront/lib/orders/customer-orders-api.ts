import { apiRequest } from '../wallet/api';
import { isOrderCursor, isOrderId, parseCustomerOrderDetail, parseCustomerOrderPage } from './customer-orders';

export const CUSTOMER_ORDERS_PAGE_SIZE = 20;
export const CUSTOMER_ORDERS_REFRESH_MS = 60_000;

export class CustomerOrdersError extends Error {
  constructor(readonly status: number | null = null) {
    super('Order information is unavailable.');
    this.name = 'CustomerOrdersError';
  }
}

export function customerOrdersErrorStatus(error: unknown): number | null {
  return error !== null && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : null;
}

/** Identity is the httpOnly session cookie supplied by apiRequest, never a browser-provided customer email. */
export async function fetchCustomerOrders(cursor: string | null, signal?: AbortSignal) {
  if (cursor !== null && !isOrderCursor(cursor)) throw new CustomerOrdersError(400);
  const query = new URLSearchParams({ limit: String(CUSTOMER_ORDERS_PAGE_SIZE) });
  if (cursor) query.set('cursor', cursor);
  const page = parseCustomerOrderPage(await apiRequest<unknown>(`/orders?${query}`, { signal }));
  if (!page || (cursor !== null && page.nextCursor === cursor)) throw new CustomerOrdersError();
  return page;
}

export async function fetchCustomerOrder(id: string, signal?: AbortSignal) {
  if (!isOrderId(id)) throw new CustomerOrdersError(404);
  const order = parseCustomerOrderDetail(await apiRequest<unknown>(`/orders/${encodeURIComponent(id)}`, { signal }));
  if (!order || order.id !== id) throw new CustomerOrdersError();
  return order;
}
