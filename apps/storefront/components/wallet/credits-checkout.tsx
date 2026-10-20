'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useAuth } from '../auth-provider';
import { WalletProvider, useWallet } from './wallet-provider';
import { buttonClass, eyebrowClass, Notice, primaryButtonClass, SANDBOX_NOTE, Spinner } from './ui';
import {
  apiRequest, errorMessage, fetchCheckoutStatus, prepareCheckout, submitCheckout, WalletApiError,
  type CheckoutPreparation,
} from '../../lib/wallet/api';
import { centsToAtomic, formatCents, formatSol, formatUsdc, formatWholeNumber, researchCredits } from '../../lib/wallet/credits';
import { referenceKeyFor, verifyUsdcTransfer } from '../../lib/wallet/tx';

export type CreditsCheckoutRequest = { id: number; email: string; shippingAddress: string };
export type CreditsCheckoutItem = { slug: string; quantity: number };

type Stage =
  | { kind: 'review' }
  | { kind: 'working'; label: string }
  | { kind: 'order-unavailable'; detail: string }
  | { kind: 'authorize'; prep: CheckoutPreparation }
  | { kind: 'signing' }
  | { kind: 'rejected' }
  | { kind: 'submitted'; statusNote: string | null }
  | { kind: 'finalized' }
  | { kind: 'failed'; message: string };

const STATUS_POLL_MS = 4000;
const newOrderKey = () => `hf-${crypto.randomUUID()}`;

type CatalogProduct = { id: string; lots: { code: string }[] };
const STAGE_GROUP: Record<Stage['kind'], string> = { review: 'review', working: 'working', 'order-unavailable': 'unavailable', authorize: 'authorize', signing: 'working', rejected: 'rejected', submitted: 'submitted', finalized: 'finalized', failed: 'failed' };

/** Mounted lazily when the customer clicks "Pay with Research Credits" so no wallet is opened just by viewing checkout. */
export function CreditsCheckoutSection(props: { request: CreditsCheckoutRequest; items: CreditsCheckoutItem[]; subtotalCents: number; onClose: () => void }) {
  const { session, isReady } = useAuth();
  if (!isReady) return null;
  if (!session) return <section aria-label="Pay with Research Credits" className="rounded-xl border border-silver bg-porcelain p-5 text-sm leading-6"><p className="font-semibold">Sign in to pay with Research Credits.</p><p className="mt-1 text-slate-600">Research Credits live in your own wallet, which is opened after you sign in.</p><div className="mt-4 flex flex-wrap gap-3"><Link className={primaryButtonClass} href="/login">Sign in</Link><button type="button" className={buttonClass} onClick={props.onClose}>Close</button></div></section>;
  return <WalletProvider><Panel {...props} /></WalletProvider>;
}

function Panel({ request, items, subtotalCents, onClose }: { request: CreditsCheckoutRequest; items: CreditsCheckoutItem[]; subtotalCents: number; onClose: () => void }) {
  const wallet = useWallet();
  const reduce = useReducedMotion();
  const [stage, setStage] = useState<Stage>({ kind: 'review' });
  const [orderId, setOrderId] = useState<string | null>(null);
  const [orderTotalCents, setOrderTotalCents] = useState<number | null>(null);
  const keyRef = useRef<string>(newOrderKey());
  const headingRef = useRef<HTMLHeadingElement>(null);

  // A stale or unreachable balance is unknown, never 0 (the API reports stale:true with spendable 0).
  const spendable = wallet.balanceFresh && wallet.balance ? wallet.balance.spendableAtomic : null;
  const localTotalAtomic = centsToAtomic(subtotalCents);
  const stale = wallet.service === 'unavailable' || wallet.balance?.stale === true;
  const emailMismatch = wallet.email !== null && request.email.trim().toLowerCase() !== wallet.email;
  const insufficient = spendable !== null && spendable < localTotalAtomic;

  // Move focus to the panel heading whenever the stage group changes (keyboard / screen reader users).
  const group = STAGE_GROUP[stage.kind];
  useEffect(() => { headingRef.current?.focus(); }, [group]);

  const prepare = useCallback(async (id: string, expectedCents: number) => {
    if (!wallet.email || !wallet.signer) return;
    setStage({ kind: 'working', label: 'Preparing your payment authorization...' });
    try {
      const prep = await prepareCheckout(wallet.email, id);
      const problems: string[] = [];
      if (prep.network !== 'solana-devnet') problems.push(`Network "${prep.network}" is not supported by the sandbox wallet (Solana devnet only).`);
      if (prep.amountAtomic !== centsToAtomic(expectedCents)) problems.push('The payment amount does not match your order total.');
      if (prep.expiresAt && Date.parse(prep.expiresAt) <= Date.now()) problems.push('This payment request has already expired.');
      if (spendable !== null && prep.amountAtomic > spendable) problems.push('Your spendable balance is lower than the payment amount.');
      // Exactly what the API builds: one TransferChecked (customer ATA -> merchant ATA) plus one read-only reference account = sha256(paymentReference).
      const referenceKey = await referenceKeyFor(prep.paymentReference);
      problems.push(...verifyUsdcTransfer(prep.unsignedTransactionBase64, { signer: wallet.signer.address, destinationOwner: prep.merchant, amountAtomic: prep.amountAtomic, purpose: 'checkout', referenceKey: referenceKey ?? undefined }));
      if (problems.length) { setStage({ kind: 'failed', message: `Nothing was signed. ${problems.join(' ')}` }); return; }
      setStage({ kind: 'authorize', prep });
    } catch (e) {
      if (e instanceof WalletApiError && e.status === 409 && /in flight|finalized payment/i.test(e.message)) {
        // A payment for this order already exists server-side: do not claim anything, just follow its real status.
        setStage({ kind: 'submitted', statusNote: 'This order already has a payment in progress. Following its status.' });
        return;
      }
      setStage({ kind: 'failed', message: errorMessage(e, 'Wallet service unavailable') });
    }
  }, [spendable, wallet.email, wallet.signer]);

  const createOrderAndPrepare = async () => {
    if (!wallet.email) return;
    setStage({ kind: 'working', label: 'Creating your order...' });
    let order: { id: string; totalCents: number };
    try {
      const resolved: { productId: string; lotCode: string; quantity: number }[] = [];
      for (const item of items) {
        const product = await apiRequest<CatalogProduct>(`/products/${encodeURIComponent(item.slug)}`);
        const lot = product?.lots?.[0];
        if (!product?.id || !lot?.code) throw new WalletApiError('No released lot', 404, true);
        resolved.push({ productId: product.id, lotCode: lot.code, quantity: item.quantity });
      }
      const created = await apiRequest<{ id?: unknown; totalCents?: unknown }>('/orders', {
        method: 'POST', headers: { 'Idempotency-Key': keyRef.current },
        body: { email: request.email.trim(), shippingAddress: request.shippingAddress.trim(), items: resolved, researchUseAcknowledged: true, idempotencyKey: keyRef.current },
      });
      if (typeof created?.id !== 'string' || typeof created.totalCents !== 'number' || !Number.isSafeInteger(created.totalCents)) throw new WalletApiError('Unexpected order response', null, true);
      order = { id: created.id, totalCents: created.totalCents };
    } catch (e) {
      const catalogMiss = e instanceof WalletApiError && (e.status === 404 || e.unavailable);
      setStage(catalogMiss
        ? { kind: 'order-unavailable', detail: 'The preview catalog items could not be matched to products in the order service (or the service is not running), so no order was created and nothing was charged.' }
        : { kind: 'failed', message: errorMessage(e, 'The order could not be created.') });
      return;
    }
    setOrderId(order.id); setOrderTotalCents(order.totalCents);
    if (spendable !== null && spendable < centsToAtomic(order.totalCents)) { setStage({ kind: 'failed', message: `The order service total is $${formatCents(order.totalCents)}, which is more than your spendable ${formatUsdc(spendable)} USDC. Nothing was signed.` }); return; }
    await prepare(order.id, order.totalCents);
  };

  const authorize = async (prep: CheckoutPreparation) => {
    if (!wallet.email || !wallet.signer || !orderId) return;
    if (prep.expiresAt && Date.parse(prep.expiresAt) <= Date.now()) { setStage({ kind: 'failed', message: 'This payment request expired before it was authorized. Nothing was signed.' }); return; }
    setStage({ kind: 'signing' });
    try {
      const signed = await wallet.signer.signTransaction(prep.unsignedTransactionBase64);
      await submitCheckout(wallet.email, orderId, signed);
      setStage({ kind: 'submitted', statusNote: null });
    } catch (e) {
      const lostConnection = e instanceof WalletApiError && e.unavailable;
      setStage({ kind: 'failed', message: `${errorMessage(e, 'Authorization could not be completed.')}${lostConnection ? ' The payment may or may not have been submitted. "Try again" will report an existing payment instead of creating a second one.' : ''}` });
    }
  };

  // Poll the order status endpoint until it reports finalized/paid or failed/expired.
  const polling = stage.kind === 'submitted';
  useEffect(() => {
    if (!polling || !wallet.email || !orderId) return;
    const email = wallet.email;
    let cancelled = false;
    const tick = async () => {
      if (cancelled || document.visibilityState !== 'visible') return;
      try {
        const status = await fetchCheckoutStatus(email, orderId);
        if (cancelled) return;
        if (status.phase === 'finalized') { setStage({ kind: 'finalized' }); void wallet.refresh(); }
        else if (status.phase === 'failed') setStage({ kind: 'failed', message: `Payment ${status.rawStatus}. Your order is not paid.` });
        else setStage((current) => current.kind === 'submitted' ? { kind: 'submitted', statusNote: null } : current);
      } catch {
        if (!cancelled) setStage((current) => current.kind === 'submitted' ? { kind: 'submitted', statusNote: 'Status check unavailable. Retrying...' } : current);
      }
    };
    void tick();
    const timer = window.setInterval(tick, STATUS_POLL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [polling, wallet.email, orderId, wallet.refresh]);

  const startOver = () => { keyRef.current = newOrderKey(); setOrderId(null); setOrderTotalCents(null); setStage({ kind: 'review' }); };
  const motionProps = reduce ? {} : { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -8 }, transition: { duration: 0.2 } };

  const gateMessage = wallet.phase === 'loading' ? 'Opening your wallet...'
    : wallet.phase !== 'ready' ? 'No usable wallet in this browser. Open your wallet page to create one.'
    : wallet.linkProblem ? `This browser's wallet is not the wallet linked to your account (${wallet.linkProblem.message}). Research Credits cannot be used from this browser.`
    : wallet.balance === null ? (wallet.service === 'unavailable' ? 'Wallet service unavailable. Your balance could not be loaded, so Research Credits cannot be used right now.' : 'Loading your balance...')
    : null;

  return <section aria-label="Pay with Research Credits" className="rounded-2xl border border-midnight/20 bg-white p-5 sm:p-7">
    <div className="flex items-start justify-between gap-4"><div><p className={eyebrowClass}>RESEARCH CREDITS / SOLANA DEVNET SANDBOX</p><h3 ref={headingRef} tabIndex={-1} className="mt-2 text-xl font-medium tracking-tight outline-none">Pay with Research Credits</h3></div>
      {stage.kind !== 'submitted' && stage.kind !== 'signing' ? <button type="button" className={buttonClass} onClick={onClose}>Close</button> : null}</div>
    <p className="mt-3 text-xs leading-6 text-slate-500">{SANDBOX_NOTE}</p>
    <div className="mt-5" aria-live="polite">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={group} {...motionProps}>
          {stage.kind === 'review' ? <div className="space-y-4">
            <dl className="divide-y divide-silver border-y border-silver text-sm">
              <div className="flex justify-between gap-4 py-3"><dt className="text-slate-600">Order total</dt><dd className="font-mono">{formatUsdc(localTotalAtomic)} USDC (${formatCents(subtotalCents)})</dd></div>
              <div className="flex justify-between gap-4 py-3"><dt className="text-slate-600">Spendable credits</dt><dd className="font-mono">{spendable !== null ? `${formatWholeNumber(researchCredits(spendable))} credits (${formatUsdc(spendable)} USDC)` : 'Not available'}</dd></div>
            </dl>
            {gateMessage ? <Notice tone={wallet.service === 'unavailable' ? 'warn' : 'info'} title={wallet.service === 'unavailable' ? 'Wallet service unavailable' : undefined}>{gateMessage}</Notice> : null}
            {emailMismatch ? <Notice tone="error" title="Email does not match your account">Research Credits can only pay for orders placed with your signed-in account email ({wallet.email}). Update the email field above, then try again.</Notice> : null}
            {insufficient ? <Notice tone="error" title="Not enough Research Credits">This order needs {formatUsdc(localTotalAtomic)} USDC but you have {formatUsdc(spendable)} USDC spendable. Credits = whole USDC available; nothing was charged. <Link className="font-semibold underline underline-offset-4" href="/account/wallet/add">Add credits</Link></Notice> : null}
            {stale && wallet.balance ? <Notice tone="warn" title="Balance may be out of date">Wait for the balance to refresh before paying.</Notice> : null}
            <p className="text-xs leading-6 text-slate-500">Paying creates an order, then asks you to authorize one USDC transfer from your own wallet. Your order is not marked paid until the transfer is finalized on-chain.</p>
            <button type="button" className={primaryButtonClass} disabled={Boolean(gateMessage) || emailMismatch || insufficient || stale || wallet.balance === null} onClick={createOrderAndPrepare}>Create order and review authorization</button>
          </div>
          : stage.kind === 'working' ? <Spinner label={stage.label} />
          : stage.kind === 'signing' ? <Spinner label="Signing in this browser and submitting..." />
          : stage.kind === 'order-unavailable' ? <div className="space-y-4"><Notice tone="warn" title="Order service unavailable in preview">{stage.detail}</Notice><div className="flex flex-wrap gap-3"><button type="button" className={buttonClass} onClick={startOver}>Back</button><button type="button" className={buttonClass} onClick={onClose}>Close</button></div></div>
          : stage.kind === 'authorize' ? <AuthorizePanel prep={stage.prep} orderId={orderId} orderTotalCents={orderTotalCents} subtotalCents={subtotalCents} onAuthorize={() => authorize(stage.prep)} onReject={() => setStage({ kind: 'rejected' })} />
          : stage.kind === 'rejected' ? <div className="space-y-4"><Notice tone="info" title="Authorization rejected">Nothing was signed or sent from your wallet, so you were not charged. {orderId ? `Order ${orderId} remains unpaid.` : ''}</Notice><div className="flex flex-wrap gap-3"><button type="button" className={primaryButtonClass} onClick={() => orderId && orderTotalCents !== null ? void prepare(orderId, orderTotalCents) : startOver()}>Review authorization again</button><button type="button" className={buttonClass} onClick={onClose}>Close</button></div></div>
          : stage.kind === 'submitted' ? <div className="space-y-4"><Notice tone="info" title="Submitted - waiting for finalization">Your authorization was sent. Your order is <b>not paid yet</b>: we show payment only after the order status reports it finalized. This can take a minute.{stage.statusNote ? <> {stage.statusNote}</> : null}</Notice><Spinner label="Checking order status..." /></div>
          : stage.kind === 'finalized' ? <Notice tone="success" title="Payment finalized">The order status endpoint reports your order as paid and the USDC transfer as finalized.{orderId ? ` Order reference: ${orderId}.` : ''}</Notice>
          : <div className="space-y-4"><Notice tone="error" title="Payment not completed">{stage.message}</Notice><div className="flex flex-wrap gap-3">{orderId && orderTotalCents !== null ? <button type="button" className={primaryButtonClass} onClick={() => void prepare(orderId, orderTotalCents)}>Try again</button> : null}<button type="button" className={buttonClass} onClick={startOver}>Start over</button><button type="button" className={buttonClass} onClick={onClose}>Close</button></div></div>}
        </motion.div>
      </AnimatePresence>
    </div>
  </section>;
}

function AuthorizePanel({ prep, orderId, orderTotalCents, subtotalCents, onAuthorize, onReject }: { prep: CheckoutPreparation; orderId: string | null; orderTotalCents: number | null; subtotalCents: number; onAuthorize: () => void; onReject: () => void }) {
  return <div className="space-y-5">
    <p className="rounded-xl bg-midnight p-4 text-sm font-medium leading-6 text-porcelain">You are authorizing a USDC transfer from your wallet.</p>
    <dl className="divide-y divide-silver border-y border-silver text-sm">
      <div className="flex justify-between gap-4 py-3"><dt className="text-slate-600">Price</dt><dd className="text-right font-mono">{formatUsdc(prep.amountAtomic)} USDC{prep.amountUsd ? ` (USD ${prep.amountUsd})` : ''}</dd></div>
      <div className="flex justify-between gap-4 py-3"><dt className="text-slate-600">Estimated network fee</dt><dd className="font-mono">{prep.feeLamports !== null ? `${formatSol(prep.feeLamports)} SOL` : 'Not provided'}</dd></div>
      <div className="grid gap-1 py-3"><dt className="text-slate-600">Merchant address</dt><dd className="break-all font-mono text-xs">{prep.merchant}</dd></div>
      <div className="flex justify-between gap-4 py-3"><dt className="text-slate-600">Network</dt><dd>Solana devnet</dd></div>
      {orderId ? <div className="flex justify-between gap-4 py-3"><dt className="text-slate-600">Order</dt><dd className="break-all text-right font-mono text-xs">{orderId}</dd></div> : null}
      {prep.expiresAt ? <div className="flex justify-between gap-4 py-3"><dt className="text-slate-600">Request expires</dt><dd>{new Date(prep.expiresAt).toLocaleTimeString()}</dd></div> : null}
    </dl>
    {orderTotalCents !== null && orderTotalCents !== subtotalCents ? <Notice tone="warn" title="Total differs from your bag">The order service priced this order at ${formatCents(orderTotalCents)}; your bag preview showed ${formatCents(subtotalCents)}. The amount above is what you would authorize.</Notice> : null}
    {prep.disclosures.length ? <ul className="space-y-2 text-xs leading-6 text-slate-700">{prep.disclosures.map((d) => <li key={d} className="rounded-lg bg-porcelain p-3">{d}</li>)}</ul> : null}
    <p className="text-xs leading-6 text-slate-600">The network fee is paid in SOL from your wallet. Blockchain transfers may be irreversible. The platform servers hold no key for your wallet; this signature is created in this browser with your sandbox key.</p>
    <div className="flex flex-wrap gap-3"><button type="button" className={primaryButtonClass} onClick={onAuthorize}>Authorize {formatUsdc(prep.amountAtomic)} USDC payment</button><button type="button" className={buttonClass} onClick={onReject}>Cancel - no charge</button></div>
  </div>;
}
