'use client';

import Link from 'next/link';
import { FormEvent, useRef, useState } from 'react';
import { formatUsd } from '../lib/money';
import { useCart } from './cart-provider';
import { CartThumbnail } from './cart-contents';
import { ProductPrice, ProductPreviewLabel } from './product-price';
import { CreditsCheckoutSection, type CreditsCheckoutRequest } from './wallet/credits-checkout';

type FormErrors = { email?: string; address?: string; acknowledgement?: string };

export function CheckoutForm() {
  const { items, subtotalCents, isReady } = useCart();
  const [errors, setErrors] = useState<FormErrors>({});
  const [paymentPrepared, setPaymentPrepared] = useState(false);
  const [creditsRequest, setCreditsRequest] = useState<CreditsCheckoutRequest | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const creditsRequestCount = useRef(0);

  const validate = (data: FormData): FormErrors => {
    const nextErrors: FormErrors = {};
    if (!/^\S+@\S+\.\S+$/.test(String(data.get('email') ?? ''))) nextErrors.email = 'Enter a valid email address.';
    if (String(data.get('address') ?? '').trim().length < 8) nextErrors.address = 'Enter a complete shipping address.';
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
    if (!formRef.current) return;
    const data = new FormData(formRef.current);
    const nextErrors = validate(data);
    setErrors(nextErrors);
    setPaymentPrepared(false);
    if (Object.keys(nextErrors).length || items.length === 0) { setCreditsRequest(null); return; }
    creditsRequestCount.current += 1;
    setCreditsRequest({ id: creditsRequestCount.current, email: String(data.get('email') ?? ''), shippingAddress: String(data.get('address') ?? '') });
  };

  if (!isReady) return <div role="status" className="rounded-2xl bg-slate-50 p-8 text-center text-sm text-slate-600">Loading your order summary.</div>;
  if (!items.length) return <div className="rounded-2xl border border-slate-200 bg-slate-50 p-8 text-center font-sans text-[#0B1220]"><p>Your research bag is empty.</p><Link className="mt-5 inline-block rounded-full bg-[#0B1220] px-6 py-3 text-sm text-white" href="/catalog">Explore catalog</Link></div>;

  return <div className="space-y-8 font-sans text-[#0B1220]">
    <section className="rounded-2xl border border-slate-200 bg-slate-50 p-5 sm:p-7" aria-labelledby="order-summary"><div className="flex items-center justify-between gap-4"><h2 id="order-summary" className="text-lg font-semibold tracking-tight">Order summary</h2><Link href="/cart" className="text-xs text-slate-600 underline underline-offset-4">Edit bag</Link></div><div className="mt-5 divide-y divide-slate-200">{items.map(({ product, quantity }) => <div className="flex items-center gap-4 py-4 text-sm" key={product.slug}><CartThumbnail product={product} /><div className="min-w-0 flex-1"><p className="font-medium">{product.name}</p><p className="mt-1 text-xs text-slate-600"><ProductPreviewLabel product={product} /></p><p className="mt-1 text-xs text-slate-600">Quantity {quantity} · <ProductPrice product={product} /> each</p></div><span className="font-medium tabular-nums"><ProductPrice product={product} quantity={quantity} /></span></div>)}</div><div className="mt-5 flex justify-between border-t border-slate-200 pt-5 text-sm font-semibold"><span>Materials subtotal</span><span className="tabular-nums">{formatUsd(subtotalCents)}</span></div><p className="mt-3 text-xs leading-5 text-slate-600">USD. Taxes and shipping are not calculated in this mock checkout.</p></section>
    <form ref={formRef} className="space-y-6" noValidate onSubmit={submit}>
      <div><h2 className="text-xl font-medium tracking-tight">Checkout details</h2><p className="mt-2 text-sm text-slate-600">Preview environment. Use test details.</p></div>
      <div><label htmlFor="checkout-email" className="mb-2 block text-sm font-medium">Email address</label><input id="checkout-email" className="w-full rounded-xl border border-slate-300 bg-white p-3.5 text-sm outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-sky-100" aria-invalid={Boolean(errors.email)} aria-describedby={errors.email ? 'email-error' : undefined} name="email" placeholder="researcher@example.com" type="email" autoComplete="email" />{errors.email && <p role="alert" className="mt-2 text-xs text-red-700" id="email-error">{errors.email}</p>}</div>
      <div><label htmlFor="checkout-address" className="mb-2 block text-sm font-medium">Shipping address</label><input id="checkout-address" className="w-full rounded-xl border border-slate-300 bg-white p-3.5 text-sm outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-sky-100" aria-invalid={Boolean(errors.address)} aria-describedby={errors.address ? 'address-error' : undefined} name="address" placeholder="Street, city, region, postal code, country" autoComplete="street-address" />{errors.address && <p role="alert" className="mt-2 text-xs text-red-700" id="address-error">{errors.address}</p>}</div>
      <div><label className="flex gap-3 rounded-xl border border-slate-200 p-4 text-sm leading-6"><input className="mt-1 h-4 w-4 shrink-0 accent-[#0B1220]" name="researchAcknowledgement" type="checkbox" aria-invalid={Boolean(errors.acknowledgement)} aria-describedby={errors.acknowledgement ? 'acknowledgement-error' : undefined} /> I confirm these materials are for lawful research use only and not for human or veterinary use.</label>{errors.acknowledgement && <p role="alert" id="acknowledgement-error" className="mt-2 text-xs text-red-700">{errors.acknowledgement}</p>}</div>
      <div className="rounded-xl border border-sky-100 bg-sky-50/60 p-5"><p className="text-xs font-semibold uppercase tracking-[.15em] text-slate-600">Payment environment · preview</p><p className="mt-2 text-sm leading-6 text-slate-600">Devnet/mock payment placeholder only. Preparing this request does not transfer funds, place an order, or confirm payment.</p></div>
      <button className="w-full rounded-full bg-[#0B1220] px-6 py-4 text-sm font-medium text-white transition hover:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4" type="submit">Prepare mock devnet payment</button>{paymentPrepared && <p role="status" className="rounded-xl border border-slate-200 bg-slate-50 p-5 text-sm leading-6">Mock payment request prepared for review. No payment has been sent and no order has been completed.</p>}
      <div className="border-t border-slate-200 pt-6"><p className="mb-3 text-sm leading-6 text-slate-600">Or pay from your own wallet balance. This is a separate devnet sandbox path that needs your signature.</p><button className="min-h-11 w-full rounded-full border border-[#0B1220] bg-white px-6 py-4 text-sm font-medium text-[#0B1220] transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4" type="button" onClick={startCreditsPayment}>Pay with Research Credits</button></div>
      {creditsRequest && <CreditsCheckoutSection key={creditsRequest.id} request={creditsRequest} items={items.map(({ product, quantity }) => ({ slug: product.slug, quantity }))} subtotalCents={subtotalCents} onClose={() => setCreditsRequest(null)} />}
    </form>
  </div>;
}
