'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useAuth } from '../auth-provider';
import { WalletProvider, useWallet } from './wallet-provider';
import { ManualDevnetFunding } from './manual-devnet-funding';
import { buttonClass, eyebrowClass, Notice, primaryButtonClass, SANDBOX_NOTE, Spinner } from './ui';
import {
  apiRequest, createOrderTopUp, errorMessage, fetchCheckoutStatus, mockCompleteOnramp, prepareCheckout, submitCheckout, WalletApiError,
  type CheckoutPreparation, type OrderTopUp,
} from '../../lib/wallet/api';
import { ATOMIC_PER_CENT, centsToAtomic, formatCents, formatSol, formatUsdc, formatWholeNumber, researchCredits } from '../../lib/wallet/credits';
import { checkoutPreparationProblems, signingOptionsFor } from '../../lib/wallet/tx';
import {
  createTopUpRun, createTopUpStore, DEFAULT_TOPUP_OPTIONS, findResumableTopUp, fundingOf, quoteFundingMode, safeWidgetUrl,
  type FundingMode, type TopUpDeps, type TopUpPlan, type TopUpRun, type TopUpState, type TopUpStore, type WidgetOpenResult,
} from '../../lib/wallet/topup-flow';

export type CreditsCheckoutRequest = { id: number; email: string; shippingAddress: string };
export type CreditsCheckoutItem = { slug: string; quantity: number };

type Stage =
  | { kind: 'review' }
  | { kind: 'working'; label: string }
  | { kind: 'order-unavailable'; detail: string }
  | { kind: 'topup-offer'; offer: TopUpOffer }
  | { kind: 'topup-run'; funding: FundingMode }
  | { kind: 'topup-cancelled' }
  | { kind: 'authorize'; prep: CheckoutPreparation }
  | { kind: 'signing' }
  | { kind: 'rejected' }
  | { kind: 'submitted'; statusNote: string | null }
  | { kind: 'finalized' }
  | { kind: 'failed'; message: string };

type TopUpOffer = Extract<OrderTopUp, { topUpNeeded: true }>;
const DEFAULT_TIMEOUT_MINUTES = DEFAULT_TOPUP_OPTIONS.timeoutMs / 60_000;

const STATUS_POLL_MS = 4000;
const newOrderKey = () => `hf-${crypto.randomUUID()}`;

type CatalogProduct = { id: string; lots: { code: string }[] };
const STAGE_GROUP: Record<Stage['kind'], string> = { review: 'review', working: 'working', 'order-unavailable': 'unavailable', 'topup-offer': 'topup-offer', 'topup-run': 'topup-run', 'topup-cancelled': 'topup-cancelled', authorize: 'authorize', signing: 'working', rejected: 'rejected', submitted: 'submitted', finalized: 'finalized', failed: 'failed' };

function openSessionStore(): TopUpStore | null {
  try { return typeof window === 'undefined' ? null : createTopUpStore(window.sessionStorage); } catch { return null; }
}

/** Opens the provider widget from inside the customer's click. No `noopener` feature (that would hide whether a popup blocker stopped it); the opener link is cut right after instead. */
function openProviderWindow(widgetUrl: string): WidgetOpenResult {
  const safe = safeWidgetUrl(widgetUrl);
  if (!safe) return { status: 'unavailable' };
  const opened = window.open(safe, '_blank');
  if (!opened) return { status: 'blocked' };
  try { opened.opener = null; } catch { /* the window is still usable */ }
  return { status: 'opened', isClosed: () => opened.closed };
}

const abortableSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) { resolve(); return; }
  const done = () => { window.clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
  const timer = window.setTimeout(done, ms);
  signal.addEventListener('abort', done, { once: true });
});

/** Everything that must hold before this browser may sign, other than amount/recipient/expiry (the run checks those itself). Includes the fee-payer rules when the platform sponsors the network fee. */
const transactionProblems = (prep: CheckoutPreparation, signerAddress: string): Promise<string[]> => checkoutPreparationProblems(prep, signerAddress);

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
  const [notice, setNotice] = useState<string | null>(null);
  const [runState, setRunState] = useState<TopUpState>({ kind: 'idle' });
  const [simulation, setSimulation] = useState<{ busy: boolean; requested: boolean; error: string | null }>({ busy: false, requested: false, error: null });
  const runRef = useRef<TopUpRun | null>(null);
  const runWidgetUrl = useRef<string | null>(null);
  const runIntentId = useRef<string | null>(null);
  const orderRef = useRef<{ id: string; totalCents: number } | null>(null);
  const walletRef = useRef(wallet);
  walletRef.current = wallet;
  const latest = useRef<{ handleRunState: (next: TopUpState, plan: TopUpPlan) => void }>({ handleRunState: () => undefined });

  // A stale or unreachable balance is unknown, never 0 (the API reports stale:true with spendable 0).
  const spendable = wallet.balanceFresh && wallet.balance ? wallet.balance.spendableAtomic : null;
  const localTotalAtomic = centsToAtomic(subtotalCents);
  const stale = wallet.service === 'unavailable' || wallet.balance?.stale === true;
  const emailMismatch = wallet.email !== null && request.email.trim().toLowerCase() !== wallet.email;
  const insufficient = spendable !== null && spendable < localTotalAtomic;

  // Move focus to the panel heading whenever the stage group changes (keyboard / screen reader users).
  const group = stage.kind === 'topup-run' ? `topup-run-${runState.kind}` : STAGE_GROUP[stage.kind];
  useEffect(() => { headingRef.current?.focus(); }, [group]);

  /** Fetch, verify and (only on the customer's click) authorize the payment. `allowTopUp` is false when we got here from a top-up result, so the two can never ping-pong. */
  const prepare = async (id: string, expectedCents: number, allowTopUp = true) => {
    if (!wallet.email || !wallet.signer) return;
    setStage({ kind: 'working', label: 'Preparing your payment authorization...' });
    try {
      const prep = await prepareCheckout(wallet.email, id);
      const problems: string[] = [];
      if (prep.amountAtomic !== centsToAtomic(expectedCents)) problems.push('The payment amount does not match your order total.');
      if (prep.expiresAt && Date.parse(prep.expiresAt) <= Date.now()) problems.push('This payment request has already expired.');
      if (spendable !== null && prep.amountAtomic > spendable) problems.push('Your spendable balance is lower than the payment amount.');
      problems.push(...await transactionProblems(prep, wallet.signer.address));
      if (problems.length) { setStage({ kind: 'failed', message: `Nothing was signed. ${problems.join(' ')}` }); return; }
      setStage({ kind: 'authorize', prep });
    } catch (e) {
      if (e instanceof WalletApiError && e.status === 409 && /in flight|finalized payment/i.test(e.message)) {
        // A payment for this order already exists server-side: do not claim anything, just follow its real status.
        setStage({ kind: 'submitted', statusNote: 'This order already has a payment in progress. Following its status.' });
        return;
      }
      if (allowTopUp && e instanceof WalletApiError && e.status === 402 && /Insufficient Research Credits/i.test(e.message)) { await requestTopUp(id, expectedCents); return; }
      setStage({ kind: 'failed', message: errorMessage(e, 'Wallet service unavailable') });
    }
  };

  /** Asks the API what this order still needs. Moves no money: it only returns a quote to show. */
  const requestTopUp = async (id: string, totalCents: number) => {
    if (!wallet.email) return;
    runRef.current?.suspend();
    setStage({ kind: 'working', label: 'Checking what this order needs...' });
    try {
      const result = await createOrderTopUp(wallet.email, id);
      if (result.requiredAtomic !== centsToAtomic(totalCents)) { setStage({ kind: 'failed', message: 'Nothing was signed or bought. The top-up service reports a different order total than the order itself.' }); return; }
      if (!result.topUpNeeded) { await prepare(id, totalCents, false); return; }
      setStage({ kind: 'topup-offer', offer: result });
    } catch (e) {
      setStage({ kind: 'failed', message: `Nothing was signed or bought. ${errorMessage(e, 'Wallet service unavailable')}` });
    }
  };

  /** Builds a run whose pay step is the EXISTING authorization flow (prepare, verify, sign with this browser's wallet, submit). */
  const startRun = (plan: TopUpPlan, mode: 'start' | 'resume') => {
    const w = walletRef.current;
    if (!w.email || !w.signer) return;
    const email = w.email;
    const signer = w.signer;
    runWidgetUrl.current = plan.widgetUrl;
    runIntentId.current = plan.intentId;
    setSimulation({ busy: false, requested: false, error: null });
    const deps: TopUpDeps<CheckoutPreparation> = {
      // A null refresh (service down) is "unknown". The run never reads it as 0.
      fetchBalance: async () => { const next = await walletRef.current.refresh(); if (!next) throw new WalletApiError('Balance unavailable', null, true); return { spendableAtomic: next.spendableAtomic, stale: next.stale }; },
      openWidget: openProviderWindow,
      sleep: abortableSleep,
      now: () => Date.now(),
      prepare: () => prepareCheckout(email, plan.orderId),
      validate: (prep) => transactionProblems(prep, signer.address),
      sign: (prep) => signer.signTransaction(prep.unsignedTransactionBase64, signingOptionsFor(prep)),
      submit: (_prep, signed) => submitCheckout(email, plan.orderId, signed),
      store: openSessionStore(),
    };
    const run = createTopUpRun(plan, deps, email, {}, (next) => {
      if (runRef.current !== run) return;
      setRunState(next);
      latest.current.handleRunState(next, plan);
    });
    runRef.current?.suspend();
    runRef.current = run;
    setStage({ kind: 'topup-run', funding: fundingOf(plan) });
    if (mode === 'start') run.start(); else run.resume();
  };

  /** Hands a finished run back to the existing stages. Nothing here signs. */
  const handleRunState = (next: TopUpState, plan: TopUpPlan) => {
    const cents = Number(plan.requiredAtomic / ATOMIC_PER_CENT);
    if (next.kind === 'submitted') setStage({ kind: 'submitted', statusNote: null });
    else if (next.kind === 'cancelled') setStage({ kind: 'topup-cancelled' });
    else if (next.kind === 'widget-unavailable') setStage({ kind: 'failed', message: 'Nothing was bought or signed. The provider did not return a secure (https) payment link, so it was not opened. Your order remains awaiting payment.' });
    else if (next.kind === 'blocked') setStage({ kind: 'failed', message: `Nothing was signed. ${next.reason === 'consent-expired' ? 'Your earlier consent is too old to pay automatically.' : 'Automatic payment needs your explicit consent first.'} Your order remains awaiting payment; "Try again" asks for a fresh authorization.` });
    else if (next.kind === 'manual-required') void prepare(plan.orderId, cents);
    else if (next.kind === 'pay-failed') {
      const e = next.error;
      if (e instanceof WalletApiError && e.status === 409 && /in flight|finalized payment/i.test(e.message)) { setStage({ kind: 'submitted', statusNote: 'This order already has a payment in progress. Following its status.' }); return; }
      const detail = next.reasons.length ? next.reasons.join(' ') : errorMessage(e, 'Authorization could not be completed.');
      const maybe = next.mayHaveSubmitted ? ' The payment may or may not have been submitted. "Try again" will report an existing payment instead of creating a second one.' : '';
      setStage({ kind: 'failed', message: `${next.mayHaveSubmitted ? '' : 'Nothing was signed or sent. '}${detail}${maybe} Your order remains awaiting payment and is not paid.` });
    }
  };

  latest.current = { handleRunState };

  const confirmTopUp = (offer: TopUpOffer) => {
    // Called directly from the confirm click so the browser allows the provider window to open.
    orderRef.current = { id: offer.orderId, totalCents: Number(offer.requiredAtomic / ATOMIC_PER_CENT) };
    startRun({
      orderId: offer.orderId, intentId: offer.intentId, requiredAtomic: offer.requiredAtomic, baselineSpendableAtomic: offer.spendableAtomic,
      consentedAt: Date.now(), widgetUrl: offer.quote.widgetUrl, sandbox: offer.quote.sandbox, funding: quoteFundingMode(offer.quote), merchant: offer.merchant,
    }, 'start');
  };

  const cancelTopUp = () => {
    const run = runRef.current;
    if (run && run.cancel()) return;
    openSessionStore()?.clear();
    setStage({ kind: 'topup-cancelled' });
  };

  const simulateDeposit = async () => {
    if (!wallet.email || !runIntentId.current) return;
    setSimulation({ busy: true, requested: false, error: null });
    try { await mockCompleteOnramp(wallet.email, runIntentId.current); setSimulation({ busy: false, requested: true, error: null }); runRef.current?.nudge(); }
    catch (e) { setSimulation({ busy: false, requested: false, error: errorMessage(e, 'Wallet service unavailable') }); }
  };

  // Stop watching (never signing) if the panel goes away. The sessionStorage record stays so the order can be resumed in this tab.
  useEffect(() => () => { runRef.current?.suspend(); runRef.current = null; orderRef.current = null; }, []);
  // Re-check immediately when this tab comes back to the front (the provider window is usually in front while the customer pays).
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') runRef.current?.nudge(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // Resume a top-up this tab left behind (reload, closed popup, navigated away). Uses the stored consent only if it is recent.
  const walletReady = wallet.phase === 'ready' && wallet.signer !== null && wallet.linkProblem === null;
  useEffect(() => {
    if (!walletReady || !wallet.email || runRef.current || orderRef.current) return;
    const store = openSessionStore();
    if (!store) return;
    const found = findResumableTopUp(store, wallet.email, Date.now());
    if (found.kind === 'none') return;
    if (found.kind === 'expired') { store.clear(); setNotice(`An earlier top-up for order ${found.record.orderId} was too old to continue automatically, so nothing was signed. That order is still awaiting payment.`); return; }
    const cents = found.plan.requiredAtomic % ATOMIC_PER_CENT === 0n ? Number(found.plan.requiredAtomic / ATOMIC_PER_CENT) : null;
    if (cents === null) { store.clear(); return; }
    orderRef.current = { id: found.plan.orderId, totalCents: cents };
    setOrderId(found.plan.orderId); setOrderTotalCents(cents);
    if (found.plan.payStartedAt) {
      setNotice(`Order ${found.plan.orderId}: this page reloaded while a payment was being authorized, so nothing is signed automatically. Checking where that payment stands.`);
      void prepare(found.plan.orderId, cents);
      return;
    }
    setNotice(`Resuming your top-up for order ${found.plan.orderId}. Your earlier consent is still valid; you can cancel at any time and nothing is signed until funds arrive.`);
    startRun(found.plan, 'resume');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletReady, wallet.email]);

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
    orderRef.current = { id: order.id, totalCents: order.totalCents };
    // Short on credits: offer the inline top-up (the API sizes it from the real order total). Otherwise go straight to authorization.
    if (spendable !== null && spendable < centsToAtomic(order.totalCents)) { await requestTopUp(order.id, order.totalCents); return; }
    await prepare(order.id, order.totalCents);
  };

  const authorize = async (prep: CheckoutPreparation) => {
    if (!wallet.email || !wallet.signer || !orderId) return;
    if (prep.expiresAt && Date.parse(prep.expiresAt) <= Date.now()) { setStage({ kind: 'failed', message: 'This payment request expired before it was authorized. Nothing was signed.' }); return; }
    setStage({ kind: 'signing' });
    try {
      const signed = await wallet.signer.signTransaction(prep.unsignedTransactionBase64, signingOptionsFor(prep));
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
        if (status.phase === 'finalized') { openSessionStore()?.clear(); setStage({ kind: 'finalized' }); void wallet.refresh(); }
        else if (status.phase === 'failed') { openSessionStore()?.clear(); setStage({ kind: 'failed', message: `Payment ${status.rawStatus}. Your order is not paid.` }); }
        else setStage((current) => current.kind === 'submitted' ? { kind: 'submitted', statusNote: null } : current);
      } catch {
        if (!cancelled) setStage((current) => current.kind === 'submitted' ? { kind: 'submitted', statusNote: 'Status check unavailable. Retrying...' } : current);
      }
    };
    void tick();
    const timer = window.setInterval(tick, STATUS_POLL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [polling, wallet.email, orderId, wallet.refresh]);

  const startOver = () => {
    runRef.current?.cancel(); runRef.current = null; orderRef.current = null; openSessionStore()?.clear();
    keyRef.current = newOrderKey(); setOrderId(null); setOrderTotalCents(null); setNotice(null); setRunState({ kind: 'idle' }); setStage({ kind: 'review' });
  };
  const motionProps = reduce ? {} : { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -8 }, transition: { duration: 0.2 } };

  const gateMessage = wallet.phase === 'loading' ? 'Opening your wallet...'
    : wallet.phase !== 'ready' ? 'No usable wallet in this browser. Open your wallet page to create one.'
    : wallet.linkProblem ? `This browser's wallet is not the wallet linked to your account (${wallet.linkProblem.message}). Research Credits cannot be used from this browser.`
    : wallet.balance === null ? (wallet.service === 'unavailable' ? 'Wallet service unavailable. Your balance could not be loaded, so Research Credits cannot be used right now.' : 'Loading your balance...')
    : null;

  return <section aria-label="Pay with Research Credits" className="rounded-2xl border border-midnight/20 bg-white p-5 sm:p-7">
    <div className="flex items-start justify-between gap-4"><div><p className={eyebrowClass}>RESEARCH CREDITS / SOLANA DEVNET SANDBOX</p><h3 ref={headingRef} tabIndex={-1} className="mt-2 text-xl font-medium tracking-tight outline-none">Pay with Research Credits</h3></div>
      {stage.kind !== 'submitted' && stage.kind !== 'signing' && !(stage.kind === 'topup-run' && runState.kind === 'paying') ? <button type="button" className={buttonClass} onClick={onClose}>Close</button> : null}</div>
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
            {notice ? <Notice tone="info">{notice}</Notice> : null}
            {insufficient ? <Notice tone="warn" title="Not enough Research Credits yet">This order needs {formatUsdc(localTotalAtomic)} USDC and you have {formatUsdc(spendable)} USDC spendable. Nothing has been charged. You can top up here with a card or bank via MoonPay (MoonPay, not Helix &amp; Field, handles ID checks, fees and payment). The next step creates your order (awaiting payment) and shows an exact quote; nothing is bought or signed until you agree to it.</Notice> : null}
            {stale && wallet.balance ? <Notice tone="warn" title="Balance may be out of date">Wait for the balance to refresh before paying.</Notice> : null}
            <p className="text-xs leading-6 text-slate-500">Paying creates an order, then asks you to authorize one USDC transfer from your own wallet. Your order is not marked paid until the transfer is finalized on-chain.</p>
            <button type="button" className={primaryButtonClass} disabled={Boolean(gateMessage) || emailMismatch || stale || wallet.balance === null} onClick={createOrderAndPrepare}>{insufficient ? 'Create order and see top-up quote' : 'Create order and review authorization'}</button>
          </div>
          : stage.kind === 'working' ? <Spinner label={stage.label} />
          : stage.kind === 'signing' ? <Spinner label="Signing in this browser and submitting..." />
          : stage.kind === 'order-unavailable' ? <div className="space-y-4"><Notice tone="warn" title="Order service unavailable in preview">{stage.detail}</Notice><div className="flex flex-wrap gap-3"><button type="button" className={buttonClass} onClick={startOver}>Back</button><button type="button" className={buttonClass} onClick={onClose}>Close</button></div></div>
          : stage.kind === 'topup-offer' ? <TopUpOfferPanel offer={stage.offer} address={wallet.address} onConfirm={() => confirmTopUp(stage.offer)} onCancel={cancelTopUp} />
          : stage.kind === 'topup-run' ? <TopUpRunPanel state={runState} funding={stage.funding} address={wallet.address} widgetUrl={runWidgetUrl.current ? safeWidgetUrl(runWidgetUrl.current) : null} simulation={simulation} onSimulate={simulateDeposit} onCancel={cancelTopUp} onKeepWaiting={() => runRef.current?.keepWaiting()} onTopUpMore={() => orderId && orderTotalCents !== null ? void requestTopUp(orderId, orderTotalCents) : undefined} />
          : stage.kind === 'topup-cancelled' ? <div className="space-y-4"><Notice tone="info" title="Top-up cancelled">Nothing was signed or sent from your wallet. {orderId ? `Order ${orderId} remains awaiting payment.` : ''} If you already completed a MoonPay purchase, that USDC still arrives in your own wallet and stays yours.</Notice><div className="flex flex-wrap gap-3">{orderId && orderTotalCents !== null ? <button type="button" className={primaryButtonClass} onClick={() => void prepare(orderId, orderTotalCents)}>Check this order again</button> : null}<button type="button" className={buttonClass} onClick={startOver}>Start over</button><button type="button" className={buttonClass} onClick={onClose}>Close</button></div></div>
          : stage.kind === 'authorize' ? <AuthorizePanel prep={stage.prep} orderId={orderId} orderTotalCents={orderTotalCents} subtotalCents={subtotalCents} onAuthorize={() => authorize(stage.prep)} onReject={() => { openSessionStore()?.clear(); setStage({ kind: 'rejected' }); }} />
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
      {prep.feeSponsored
        ? <div className="flex justify-between gap-4 py-3"><dt className="text-slate-600">Network fee</dt><dd>Paid by Helix &amp; Field</dd></div>
        : <div className="flex justify-between gap-4 py-3"><dt className="text-slate-600">Estimated network fee</dt><dd className="font-mono">{prep.feeLamports !== null ? `${formatSol(prep.feeLamports)} SOL` : 'Not provided'}</dd></div>}
      <div className="grid gap-1 py-3"><dt className="text-slate-600">Merchant address</dt><dd className="break-all font-mono text-xs">{prep.merchant}</dd></div>
      <div className="flex justify-between gap-4 py-3"><dt className="text-slate-600">Network</dt><dd>Solana devnet</dd></div>
      {orderId ? <div className="flex justify-between gap-4 py-3"><dt className="text-slate-600">Order</dt><dd className="break-all text-right font-mono text-xs">{orderId}</dd></div> : null}
      {prep.expiresAt ? <div className="flex justify-between gap-4 py-3"><dt className="text-slate-600">Request expires</dt><dd>{new Date(prep.expiresAt).toLocaleTimeString()}</dd></div> : null}
    </dl>
    {orderTotalCents !== null && orderTotalCents !== subtotalCents ? <Notice tone="warn" title="Total differs from your bag">The order service priced this order at ${formatCents(orderTotalCents)}; your bag preview showed ${formatCents(subtotalCents)}. The amount above is what you would authorize.</Notice> : null}
    {prep.disclosures.length ? <ul className="space-y-2 text-xs leading-6 text-slate-700">{prep.disclosures.map((d) => <li key={d} className="rounded-lg bg-porcelain p-3">{d}</li>)}</ul> : null}
    <p className="text-xs leading-6 text-slate-600">{prep.feeSponsored ? 'Network fee: paid by Helix & Field. Your wallet signs only the USDC transfer and does not need any SOL for this payment.' : 'The network fee is paid in SOL from your wallet.'} Blockchain transfers may be irreversible. The platform servers hold no key for your wallet; this signature is created in this browser with your sandbox key.</p>
    <div className="flex flex-wrap gap-3"><button type="button" className={primaryButtonClass} onClick={onAuthorize}>Authorize {formatUsdc(prep.amountAtomic)} USDC payment</button><button type="button" className={buttonClass} onClick={onReject}>Cancel - no charge</button></div>
  </div>;
}

function TopUpOfferPanel({ offer, address, onConfirm, onCancel }: { offer: TopUpOffer; address: string | null; onConfirm: () => void; onCancel: () => void }) {
  const [agreed, setAgreed] = useState(false);
  const { quote } = offer;
  const usd = formatCents(offer.topUpUsdCents);
  const mode = quoteFundingMode(quote);
  const manual = mode === 'manual-devnet';
  const widgetOk = mode !== 'widget' || safeWidgetUrl(quote.widgetUrl) !== null;
  const payLine = <li>Only when the wallet service reports at least {formatUsdc(offer.requiredAtomic)} USDC spendable, this page asks your own wallet in this browser to sign one transfer of exactly <b className="font-mono">{formatUsdc(offer.requiredAtomic)} USDC</b> to {offer.merchant ? <>the merchant address <span className="break-all font-mono text-xs">{offer.merchant}</span></> : 'Helix & Field\u2019s merchant payment address, which the service issues only when the payment is prepared (the page refuses to sign unless the prepared transaction pays exactly that amount, from your wallet, to one merchant recipient)'} and submits it. No further click is needed.</li>;
  const totals = <>
    <div className="flex justify-between gap-4 py-3"><dt className="text-slate-600">Order total</dt><dd className="font-mono">{formatUsdc(offer.requiredAtomic)} USDC</dd></div>
    <div className="flex justify-between gap-4 py-3"><dt className="text-slate-600">Spendable credits now</dt><dd className="font-mono">{formatUsdc(offer.spendableAtomic)} USDC</dd></div>
    <div className="flex justify-between gap-4 py-3"><dt className="text-slate-600">Still needed</dt><dd className="font-mono">{formatUsdc(offer.shortfallAtomic)} USDC</dd></div>
  </>;
  if (manual) return <div className="space-y-5">
    <div>
      <p className="text-base font-semibold leading-7">Add devnet USDC to your wallet, then pay this order</p>
      <p className="mt-1 text-sm leading-6 text-slate-600">No purchase is made on this page. Your order needs {formatUsdc(offer.shortfallAtomic)} more USDC than your wallet holds.</p>
    </div>
    <dl className="divide-y divide-silver border-y border-silver text-sm">{totals}</dl>
    <ManualDevnetFunding address={address} context="checkout" />
    <div className="rounded-xl bg-midnight p-4 text-sm leading-6 text-porcelain">
      <p className="font-semibold">What you are agreeing to</p>
      <ol className="mt-2 list-decimal space-y-1 pl-5">
        <li>You add devnet USDC to your wallet address yourself. This page stays open and checks your balance about every 3 seconds.</li>
        {payLine}
        <li>You can cancel at any time before signing. Nothing is signed if funds do not arrive.</li>
      </ol>
    </div>
    <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-silver bg-white p-3 text-sm leading-6 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-midnight">
      <input type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
      <span>When enough devnet USDC reaches my wallet, pay this order automatically ({formatUsdc(offer.requiredAtomic)} USDC); I can cancel before signing.</span>
    </label>
    <div className="flex flex-wrap gap-3">
      <button type="button" className={primaryButtonClass} disabled={!agreed} onClick={onConfirm}>Wait for devnet USDC, then pay</button>
      <button type="button" className={buttonClass} onClick={onCancel}>Cancel - nothing signed</button>
    </div>
  </div>;
  return <div className="space-y-5">
    <div>
      <p className="text-base font-semibold leading-7">Buy ${usd} of USDC with a card or bank via MoonPay</p>
      <p className="mt-1 text-sm leading-6 text-slate-600">MoonPay, not Helix &amp; Field, handles ID checks, fees and payment. The USDC is delivered to your own wallet, not to Helix &amp; Field.</p>
    </div>
    <dl className="divide-y divide-silver border-y border-silver text-sm">
      {totals}
      <div className="flex justify-between gap-4 py-3"><dt className="text-slate-600">Top-up amount</dt><dd>${usd} USD{mode === 'simulate' ? ' (sandbox)' : quote.sandbox ? ' via MoonPay (sandbox)' : ' via MoonPay'}</dd></div>
      {quote.estimatedFeeUsdCents !== null ? <div className="flex justify-between gap-4 py-3"><dt className="text-slate-600">Estimated provider fee</dt><dd>${formatCents(quote.estimatedFeeUsdCents)}</dd></div> : null}
      {quote.estimatedUsdcAtomic !== null ? <div className="flex justify-between gap-4 py-3"><dt className="text-slate-600">Provider&apos;s USDC estimate</dt><dd className="font-mono">{formatUsdc(quote.estimatedUsdcAtomic)}</dd></div> : null}
    </dl>
    <p className="text-xs leading-6 text-slate-600">{quote.estimatedUsdcAtomic !== null ? 'The estimate comes from the provider.' : 'The provider has not quoted a USDC amount.'} Fees set by MoonPay can reduce the USDC that actually arrives. If what arrives is still short of the order total, we show the new shortfall and you choose what to do; we never top up again on our own.</p>
    {quote.disclosures.length ? <ul className="space-y-2 text-xs leading-6 text-slate-700">{quote.disclosures.map((d) => <li key={d} className="rounded-lg bg-porcelain p-3">{d}</li>)}</ul> : null}
    {mode === 'simulate' ? <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-xs leading-6 text-amber-900"><p className="font-semibold">SANDBOX SIMULATION</p><p className="mt-1">This is not MoonPay. No identity check, card payment or real funds are involved; the next step offers a button that asks the sandbox API to simulate a devnet USDC deposit.</p></div> : null}
    <div className="rounded-xl bg-midnight p-4 text-sm leading-6 text-porcelain">
      <p className="font-semibold">What you are agreeing to</p>
      <ol className="mt-2 list-decimal space-y-1 pl-5">
        <li>{mode === 'simulate' ? 'You simulate the top-up on this page.' : 'MoonPay opens in a new tab or window and you complete the purchase there. This page stays open and checks your balance about every 3 seconds.'}</li>
        {payLine}
        <li>You can cancel at any time before signing. Nothing is signed if funds do not arrive.</li>
      </ol>
    </div>
    <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-silver bg-white p-3 text-sm leading-6 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-midnight">
      <input type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
      <span>Top up ${usd}, then pay this order automatically ({formatUsdc(offer.requiredAtomic)} USDC); I can cancel before signing.</span>
    </label>
    {!widgetOk ? <Notice tone="error">The provider did not return a secure (https) payment link, so the top-up cannot be opened. Nothing was bought or signed.</Notice> : null}
    <div className="flex flex-wrap gap-3">
      <button type="button" className={primaryButtonClass} disabled={!agreed || !widgetOk} onClick={onConfirm}>{mode === 'simulate' ? `Top up $${usd} (sandbox), then pay` : `Open MoonPay: top up $${usd}, then pay`}</button>
      <button type="button" className={buttonClass} onClick={onCancel}>Cancel - nothing bought or signed</button>
    </div>
  </div>;
}

type Simulation = { busy: boolean; requested: boolean; error: string | null };

function TopUpRunPanel({ state, funding, address, widgetUrl, simulation, onSimulate, onCancel, onKeepWaiting, onTopUpMore }: {
  state: TopUpState; funding: FundingMode; address: string | null; widgetUrl: string | null; simulation: Simulation; onSimulate: () => void; onCancel: () => void; onKeepWaiting: () => void; onTopUpMore: () => void;
}) {
  const manual = funding === 'manual-devnet';
  const linkClass = 'font-semibold underline underline-offset-4';
  const link = widgetUrl ? <a className={linkClass} href={widgetUrl} target="_blank" rel="noopener noreferrer">Open MoonPay in a new tab</a> : null;
  if (state.kind === 'paying') return <Spinner label="Your finalized balance now covers the order. Verifying and signing your payment in this browser, then submitting..." />;
  if (state.kind === 'short') return <div className="space-y-4">
    <Notice tone="warn" title="Funds arrived, but the order is still short">
      Your finalized spendable balance is now <b className="font-mono">{formatUsdc(state.spendableAtomic)} USDC</b>; this order needs <b className="font-mono">{formatUsdc(state.requiredAtomic)} USDC</b>, so <b className="font-mono">{formatUsdc(state.shortfallAtomic)} USDC</b> is still missing{manual ? '.' : ' (provider fees can reduce what arrives).'} Nothing was signed, and the order remains awaiting payment.
    </Notice>
    <div className="flex flex-wrap gap-3">
      {manual ? null : <button type="button" className={primaryButtonClass} onClick={onTopUpMore}>See another top-up quote</button>}
      <button type="button" className={buttonClass} onClick={onKeepWaiting}>Keep waiting for more funds</button>
      <button type="button" className={buttonClass} onClick={onCancel}>Cancel - nothing signed</button>
    </div>
  </div>;
  if (state.kind === 'timed-out') return <div className="space-y-4">
    <Notice tone="warn" title="Still waiting for funds">
      We stopped checking after about {Math.round(DEFAULT_TIMEOUT_MINUTES)} minutes without seeing enough USDC. Nothing was signed and your order remains awaiting payment. {manual ? 'If you already sent devnet USDC and it has not shown up yet, you can keep waiting' : 'If your MoonPay purchase is still processing, you can keep waiting'}; this top-up also resumes if you reload this tab.
    </Notice>
    <div className="flex flex-wrap gap-3">
      <button type="button" className={primaryButtonClass} onClick={onKeepWaiting}>Keep waiting</button>
      <button type="button" className={buttonClass} onClick={onCancel}>Cancel - nothing signed</button>
    </div>
  </div>;
  if (state.kind !== 'waiting') return <Spinner label="Starting your top-up..." />;
  const p = state.progress;
  return <div className="space-y-4">
    <Spinner label="Waiting for USDC to arrive in your wallet..." />
    {p.widget === 'opened' ? <p className="text-sm leading-6 text-slate-700">MoonPay opened in a new tab or window. Complete the purchase there and keep this page open: when enough USDC arrives, this page pays the order automatically.</p> : null}
    {p.widget === 'closed' ? <Notice tone="info" title="The MoonPay window was closed">If you finished the purchase, funds may still be on their way and we keep checking. {link}</Notice> : null}
    {p.widget === 'blocked' ? <Notice tone="warn" title="Your browser blocked the MoonPay window">Nothing was bought. Open it yourself and keep this page open: {link ?? 'the link is unavailable'}.</Notice> : null}
    {p.widget === 'resumed' ? <Notice tone="info">This page was reloaded. If you already completed the purchase we keep checking for it. The MoonPay window cannot be reopened from here; to buy more, cancel and start a new top-up.</Notice> : null}
    {manual ? <ManualDevnetFunding address={address} context="checkout" /> : null}
    {funding === 'simulate' ? <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
      <p className="text-sm font-semibold text-amber-900">SANDBOX SIMULATION</p>
      <p className="mt-2 text-xs leading-6 text-amber-900">This is not MoonPay. No identity check, card payment or real funds are involved. The button asks the sandbox API to simulate a deposit of devnet USDC to your wallet.</p>
      <button type="button" className={`${primaryButtonClass} mt-4`} disabled={simulation.busy || simulation.requested} onClick={onSimulate}>{simulation.requested ? 'Simulation requested' : simulation.busy ? 'Simulating...' : 'Simulate MoonPay deposit'}</button>
      {simulation.error ? <div className="mt-3"><Notice tone="error">{simulation.error}</Notice></div> : null}
    </div> : null}
    <dl className="divide-y divide-silver border-y border-silver text-sm">
      <div className="flex justify-between gap-4 py-3"><dt className="text-slate-600">Order total</dt><dd className="font-mono">{formatUsdc(p.requiredAtomic)} USDC</dd></div>
      <div className="flex justify-between gap-4 py-3"><dt className="text-slate-600">Spendable credits (finalized)</dt><dd className="font-mono">{p.balanceKnown && p.spendableAtomic !== null ? `${formatUsdc(p.spendableAtomic)} USDC` : 'Unknown right now'}</dd></div>
    </dl>
    {!p.balanceKnown && p.checks > 0 ? <Notice tone="warn" title="Balance unavailable or out of date">We could not confirm your balance on the last check. That is treated as unknown, not as zero and not as enough. We keep trying.</Notice> : null}
    <p className="text-xs leading-6 text-slate-600">Funds count only once the wallet service reports them finalized.{manual ? '' : ' A completed MoonPay checkout alone does not count.'} Checking about every 3 seconds, for up to about {Math.round(DEFAULT_TIMEOUT_MINUTES)} minutes. Closing this panel stops the checking; you can resume in this tab.</p>
    <div aria-live="off" className="text-xs text-slate-500">{p.lastCheckedAt !== null ? `Last checked ${new Date(p.lastCheckedAt).toLocaleTimeString()}` : 'Checking...'}</div>
    {!p.persisted ? <p className="text-xs text-slate-500">This browser would not store resume information, so reloading this page will not resume the top-up.</p> : null}
    <button type="button" className={buttonClass} onClick={onCancel}>Cancel - nothing signed</button>
  </div>;
}
