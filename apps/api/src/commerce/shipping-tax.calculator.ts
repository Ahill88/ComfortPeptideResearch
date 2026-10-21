import { INT32_MAX, type CommerceConfig } from './commerce.config';

export interface OrderTotals {
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
}

/** Thrown when subtotal + shipping + tax would not fit the Int32 cents columns. Callers map it to a 400. */
export class OrderTotalTooLargeError extends RangeError {
  constructor() {
    super('Order total is too large');
    this.name = 'OrderTotalTooLargeError';
  }
}

export type ShippingTaxRules = Pick<CommerceConfig, 'shippingFlatCents' | 'shippingFreeOverCents' | 'taxRateBps'>;

/**
 * Pure shipping + tax arithmetic in integer cents. No I/O, no clock, no globals: the same input always gives the same totals,
 * which is what lets POST /v1/orders/quote and POST /v1/orders agree.
 *
 *   shipping = 0 when a free-over threshold is set and subtotal > threshold, else the flat charge
 *   tax      = round-half-up(subtotal x bps / 10000)      (flat placeholder rate on the subtotal; shipping is not taxed)
 *   total    = subtotal + shipping + tax                  (must be <= 2,147,483,647)
 */
export class ShippingTaxCalculator {
  constructor(private readonly rules: ShippingTaxRules) {}

  compute(subtotalCents: number): OrderTotals {
    if (!Number.isSafeInteger(subtotalCents) || subtotalCents < 0 || subtotalCents > INT32_MAX) throw new OrderTotalTooLargeError();
    const { shippingFlatCents, shippingFreeOverCents, taxRateBps } = this.rules;
    const shippingCents = shippingFreeOverCents !== null && subtotalCents > shippingFreeOverCents ? 0 : shippingFlatCents;
    // subtotal <= 2^31 and bps <= 10000, so the product is below 2^45: exact in a double. Integer half-up division.
    const taxCents = Math.floor((subtotalCents * taxRateBps + 5_000) / 10_000);
    const totalCents = subtotalCents + shippingCents + taxCents;
    if (!Number.isSafeInteger(totalCents) || totalCents > INT32_MAX) throw new OrderTotalTooLargeError();
    return { subtotalCents, shippingCents, taxCents, totalCents };
  }
}
