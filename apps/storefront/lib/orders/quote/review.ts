import { isCents, orderNeedsReview, type CreatedOrder, type OrderQuote } from './model';

/** Both preparation and top-up pass this gate; retry paths cannot bypass a changed-order review. */
export function createOrderReview() {
  let pending: { id: string; totalCents: number } | null = null;
  let approved: { id: string; totalCents: number } | null = null;
  return {
    record(quote: OrderQuote, order: CreatedOrder) {
      pending = { id: order.id, totalCents: order.totalCents };
      const changed = orderNeedsReview(quote, order);
      approved = changed ? null : pending;
      return changed;
    },
    accept(id: string) {
      if (!pending || pending.id !== id) return false;
      approved = pending;
      return true;
    },
    allows(id: string, totalCents: number) { return !!approved && approved.id === id && approved.totalCents === totalCents; },
    // Existing top-up consent binds an exact order and amount. It never approves a newly created order.
    restoreConsent(id: string, totalCents: number) {
      if (!id || !isCents(totalCents)) return false;
      pending = approved = { id, totalCents };
      return true;
    },
  };
}
