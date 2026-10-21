'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { formatUsd } from '../lib/money';
import { useCart } from './cart-provider';
import { CartThumbnail } from './cart-contents';
import { ProductPreviewLabel } from './product-price';
import { CreditsCheckoutSection, type CreditsCheckoutRequest } from './wallet/credits-checkout';
import { useCartQuote } from '../lib/orders/quote/use-cart-quote';
import { cartKey, lineAvailability, type CartQuote, type CreatedOrder } from '../lib/orders/quote/model';
import type { StockConflict } from '../lib/orders/quote/client';
import { OrderTotals, QuoteStatus } from '../lib/orders/quote/summary';

type FormErrors = { email?: string; address?: string; acknowledgement?: string };

export function CheckoutForm() {
  const { items, isReady, updateQuantity, removeItem } = useCart();
  const lines = items.map(({ product, quantity }) => ({ slug: product.slug, quantity }));
  const currentCartKey = cartKey(lines);
  const quote = useCartQuote(lines, isReady);
  const [errors, setErrors] = useState<FormErrors>({});
  const [paymentPrepared, setPaymentPrepared] = useState(false);
  const [creditsRequest, setCreditsRequest] = useState<(CreditsCheckoutRequest & { reviewed: CartQuote }) | null>(null);
  const [created, setCreated] = useState<{ cartKey: string; order: CreatedOrder } | null>(null);
  const [stockFailure, setStockFailure] = useState<CartQuote | null>(null);
  const activeRequest = creditsRequest?.reviewed.cartKey === currentCartKey ? creditsRequest : null;
  const order = activeRequest && created?.cartKey === currentCartKey ? created.order : null;
  const availabilityQuote = quote.snapshot ?? (stockFailure?.cartKey === currentCartKey ? stockFailure : null);
  const formRef = useRef<HTMLFormElement>(null);
  const creditsRequestCount = useRef(0);

  useEffect(() => {
    // A cross-tab cart edit must not resurrect an older payment panel when quantities later return to their old values.
    setCreditsRequest(null); setCreated(null); setStockFailure(null); setPaymentPrepared(false);
  }, [currentCartKey]);

  const validate = (data: FormData): FormErrors => {
    const nextErrors: FormErrors = {};
    if (!/^\S+@\S+\.\S+$/.test(String(data.get('email') ?? ''))) nextErrors.email = 'Enter a valid email address.';
    if (String(data.get('address') ?? '').trim().length < 8) nextErrors.address = 'Enter a complete shipping address.';
    if (String(data.get('address') ?? '').trim().length > 500) nextErrors.address = 'Use at most 500 characters for the shipping address.';
    if (data.get('researchAcknowledgement') !== 'on') nextErrors.acknowledgement = 'Research-use acknowledgement is required.';
    return nextErrors;
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = validate(new FormData(event.currentTarget));
    setErrors(nextErrors);
    setPaymentPrepared(!Object.keys(nextErrors).length && items.length > 0);
  };

  // Additive: same validation as the mock path, then opens the Research Credits panel. Does not touch the mock flow.
  const startCreditsPayment = () => {
    if (!formRef.current || !quote.canCheckout || !quote.snapshot || activeRequest) return;
    const data = new FormData(formRef.current);
    const nextErrors = validate(data);
    setErrors(nextErrors);
    setPaymentPrepared(false);
    if (Object.keys(nextErrors).length || items.length === 0) { setCreditsRequest(null); return; }
    creditsRequestCount.current += 1;
    setCreated(null);
    setStockFailure(null);
    setCreditsRequest({ id: creditsRequestCount.current, email: String(data.get('email') ?? ''), shippingAddress: String(data.get('address') ?? ''), reviewed: quote.snapshot });
  };

  const closeCredits = () => { setCreditsRequest(null); setCreated(null); quote.refresh(); };
  const handleStockConflict = (stock: StockConflict) => {
    if (activeRequest?.reviewed.quote) setStockFailure({ ...activeRequest.reviewed, quote: { ...activeRequest.reviewed.quote, unavailable: [{ ...stock, reason: 'out_of_stock' }] } });
    closeCredits();
  };

  if (!isReady) return <div role="status" className="rounded-2xl bg-slate-50 p-8 text-center text-sm text-slate-600">Loading your order summary.</div>;
  if (!items.length) return <div className="rounded-2xl border border-slate-200 bg-slate-50 p-8 text-center font-sans text-[#0B1220]"><p>Your research bag is empty.</p><Link className="mt-5 inline-block rounded-full bg-[#0B1220] px-6 py-3 text-sm text-white" href="/catalog">Explore catalog</Link></div>;

  return <div className="space-y-8 font-sans text-[#0B1220]">
    <section className="rounded-2xl border border-slate-200 bg-slate-50 p-5 sm:p-7" aria-labelledby="order-summary">
      <div className="flex items-center justify-between gap-4"><h2 id="order-summary" className="text-lg font-semibold tracking-tight">{order ? 'Created order summary' : 'Order summary'}</h2><Link href="/cart" className="text-xs text-slate-600 underline underline-offset-4">Edit bag</Link></div>
      <div className="mt-5 divide-y divide-slate-200">{items.map(({ product, quantity }) => {
        const resolved = (activeRequest?.reviewed ?? quote.snapshot)?.lines.find((line) => line.slug === product.slug);
        const priced = (order?.items ?? quote.snapshot?.quote?.lines)?.find((line) => line.productId === resolved?.productId && line.lotCode === resolved.lotCode);
        const availability = !order ? lineAvailability(availabilityQuote, product.slug) : null;
        return <div className="flex items-start gap-4 py-4 text-sm" key={product.slug}><CartThumbnail product={product} /><div className="min-w-0 flex-1"><p className="font-medium">{product.name}</p><p className="mt-1 text-xs text-slate-600"><ProductPreviewLabel product={product} /></p><p className="mt-1 text-xs text-slate-600">Quantity {quantity}{priced ? ` · ${formatUsd(priced.unitCents)} each · Lot ${priced.lotCode}` : ''}</p>
          {availability ? <div role="status" className="mt-2 text-amber-900"><p>{availability.message}</p>{availability.reduceTo !== null ? <button type="button" className="min-h-11 underline underline-offset-4" onClick={() => { closeCredits(); setStockFailure(null); updateQuantity(product.slug, availability.reduceTo!); }}>Reduce {product.name} to {availability.reduceTo}</button> : null}<button type="button" className="ml-3 min-h-11 underline underline-offset-4" onClick={() => { closeCredits(); setStockFailure(null); removeItem(product.slug); }}>Remove {product.name}</button></div> : null}
        </div><span className="font-medium tabular-nums">{priced ? formatUsd(priced.lineCents) : 'Price unavailable'}</span></div>;
      })}</div>
      <div className="mt-5 border-t border-slate-200 pt-5"><OrderTotals totals={order ?? quote.snapshot?.quote ?? null} partial={!order && !!quote.snapshot && (quote.snapshot.issues.length > 0 || quote.snapshot.quote?.unavailable.some((u) => u.reason !== 'out_of_stock'))} /></div>
      {order ? <p className="mt-3 text-xs text-slate-600">Order {order.id}. These are the order&apos;s stored totals.</p> : activeRequest ? <p className="mt-3 text-xs text-slate-600">Reviewing this quote for payment. Close the payment panel to edit details or refresh.</p> : <QuoteStatus state={quote.state} onRefresh={quote.refresh} />}
      {stockFailure?.cartKey === currentCartKey ? <p role="alert" className="mt-3 text-sm text-amber-900">Stock changed before the order was placed. No payment was requested. Review availability and quantities before trying again.</p> : null}
    </section>
    <form ref={formRef} className="space-y-6" noValidate onSubmit={submit}>
      <fieldset disabled={!!activeRequest} className="space-y-6">
      <div><h2 className="text-xl font-medium tracking-tight">Checkout details</h2><p className="mt-2 text-sm text-slate-600">Preview environment. Use test details.</p></div>
      <div><label htmlFor="checkout-email" className="mb-2 block text-sm font-medium">Email address</label><input id="checkout-email" className="w-full rounded-xl border border-slate-300 bg-white p-3.5 text-sm outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-sky-100" aria-invalid={Boolean(errors.email)} aria-describedby={errors.email ? 'email-error' : undefined} name="email" placeholder="researcher@example.com" type="email" autoComplete="email" />{errors.email && <p role="alert" className="mt-2 text-xs text-red-700" id="email-error">{errors.email}</p>}</div>
      <div><label htmlFor="checkout-address" className="mb-2 block text-sm font-medium">Shipping address</label><input id="checkout-address" className="w-full rounded-xl border border-slate-300 bg-white p-3.5 text-sm outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-sky-100" aria-invalid={Boolean(errors.address)} aria-describedby={errors.address ? 'address-error' : undefined} name="address" placeholder="Street, city, region, postal code, country" autoComplete="street-address" />{errors.address && <p role="alert" className="mt-2 text-xs text-red-700" id="address-error">{errors.address}</p>}</div>
      <div><label className="flex gap-3 rounded-xl border border-slate-200 p-4 text-sm leading-6"><input className="mt-1 h-4 w-4 shrink-0 accent-[#0B1220]" name="researchAcknowledgement" type="checkbox" aria-invalid={Boolean(errors.acknowledgement)} aria-describedby={errors.acknowledgement ? 'acknowledgement-error' : undefined} /> I confirm these materials are for lawful research use only and not for human or veterinary use.</label>{errors.acknowledgement && <p role="alert" id="acknowledgement-error" className="mt-2 text-xs text-red-700">{errors.acknowledgement}</p>}</div>
      </fieldset>
      <div className="rounded-xl border border-sky-100 bg-sky-50/60 p-5"><p className="text-xs font-semibold uppercase tracking-[.15em] text-slate-600">Payment environment · preview</p><p className="mt-2 text-sm leading-6 text-slate-600">Devnet/mock payment placeholder only. Preparing this request does not transfer funds, place an order, or confirm payment.</p></div>
      <button disabled={!!activeRequest} className="w-full rounded-full bg-[#0B1220] px-6 py-4 text-sm font-medium text-white transition hover:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 disabled:opacity-50" type="submit">Prepare mock devnet payment</button>{paymentPrepared && <p role="status" className="rounded-xl border border-slate-200 bg-slate-50 p-5 text-sm leading-6">Mock payment request prepared for review. No payment has been sent and no order has been completed.</p>}
      <div className="border-t border-slate-200 pt-6"><p className="mb-3 text-sm leading-6 text-slate-600">Or pay from your own wallet balance. This is a separate devnet sandbox path that needs your signature.</p><button disabled={!quote.canCheckout || !!activeRequest} className="min-h-11 w-full rounded-full border border-[#0B1220] bg-white px-6 py-4 text-sm font-medium text-[#0B1220] transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-not-allowed disabled:opacity-50" type="button" onClick={startCreditsPayment}>Pay with Research Credits</button>{!quote.canCheckout && !order ? <p className="mt-3 text-xs text-slate-600">Payment requires a current quote with every item available. The mock demo above never creates an order.</p> : null}</div>
      {activeRequest && <CreditsCheckoutSection key={activeRequest.id} request={activeRequest} items={lines} reviewedQuote={activeRequest.reviewed} onOrderCreated={(next) => setCreated({ cartKey: currentCartKey, order: next })} onStockConflict={handleStockConflict} onClose={closeCredits} />}
    </form>
  </div>;
}
