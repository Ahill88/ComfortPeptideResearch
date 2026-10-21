'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ExternalLink, FlaskConical } from 'lucide-react';
import { useWallet } from './wallet-provider';
import { buttonClass, cardClass, eyebrowClass, inputClass, Notice, primaryButtonClass, ServiceNotice, Spinner, WalletGate } from './ui';
import { WalletDisclosures } from './wallet-disclosures';
import { ManualDevnetFunding } from './manual-devnet-funding';
import { createOnrampQuote, errorMessage, mockCompleteOnramp, type OnrampQuote } from '../../lib/wallet/api';
import { formatCents, formatUsdc, formatWholeNumber, parseUsdToCents, researchCredits } from '../../lib/wallet/credits';
import { quoteFundingMode } from '../../lib/wallet/topup-flow';

const PRESETS_CENTS = [2500, 5000, 10000, 25000];
const WATCH_INTERVAL_MS = 5000;

/** Only https widget URLs are opened, and never with an opener reference. */
function safeWidgetUrl(value: string): string | null {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.toString() : null; } catch { return null; }
}

function Flow() {
  const wallet = useWallet();
  const reduce = useReducedMotion();
  const [selected, setSelected] = useState<number | null>(5000);
  const [custom, setCustom] = useState('');
  const [quote, setQuote] = useState<OnrampQuote | null>(null);
  const [quoteCents, setQuoteCents] = useState<number | null>(null);
  const [baseline, setBaseline] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [simulated, setSimulated] = useState(false);
  const [deposited, setDeposited] = useState<bigint | null>(null);

  const customCents = custom.trim() ? parseUsdToCents(custom) : null;
  const cents = custom.trim() ? customCents : selected;
  const customInvalid = custom.trim() !== '' && (customCents === null || customCents < 1);
  const canQuote = cents !== null && cents >= 1 && !customInvalid && wallet.balanceFresh && !busy;

  const requestQuote = async () => {
    if (!wallet.email || cents === null || !wallet.balance || !wallet.balanceFresh) return;
    setBusy(true); setError(null);
    try {
      const next = await createOnrampQuote(wallet.email, cents);
      setBaseline(wallet.balance.finalizedAtomic); setQuote(next); setQuoteCents(cents); setSimulated(false); setDeposited(null);
    } catch (e) { setError(errorMessage(e, 'Wallet service unavailable')); } finally { setBusy(false); }
  };

  // Watch for a FINALIZED balance increase. Quote/checkout status alone never produces credits.
  const watching = quote !== null && baseline !== null && deposited === null;
  useEffect(() => {
    if (!watching) return;
    const tick = () => { if (document.visibilityState === 'visible') void wallet.refresh(); };
    const timer = window.setInterval(tick, WATCH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [watching, wallet.refresh]);
  useEffect(() => {
    if (!watching || !wallet.balance || !wallet.balanceFresh || baseline === null) return;
    if (wallet.balance.finalizedAtomic > baseline) setDeposited(wallet.balance.finalizedAtomic - baseline);
  }, [watching, wallet.balance, wallet.balanceFresh, baseline]);

  const simulate = async () => {
    if (!wallet.email || !quote) return;
    setBusy(true); setError(null);
    try { await mockCompleteOnramp(wallet.email, quote.intentId); setSimulated(true); void wallet.refresh(); } catch (e) { setError(errorMessage(e, 'Wallet service unavailable')); } finally { setBusy(false); }
  };

  const reset = () => { setQuote(null); setBaseline(null); setDeposited(null); setSimulated(false); setError(null); };
  // 'simulate' only when the API said so; 'manual-devnet' = API on real devnet without MoonPay (no button, funding instructions instead).
  const mode = quote ? quoteFundingMode(quote) : null;
  const widget = quote && mode === 'widget' ? safeWidgetUrl(quote.widgetUrl) : null;
  const motionProps = reduce ? {} : { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -8 }, transition: { duration: 0.2 } };

  return <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
    <section className={cardClass} aria-labelledby="amount-heading">
      <p className={eyebrowClass}>STEP 1</p><h2 id="amount-heading" className="mt-3 text-3xl tracking-tight">Choose an amount</h2>
      <p className="mt-3 text-sm leading-7 text-slate-600">Amount in US dollars you plan to spend (with a real MoonPay quote; in the sandbox the deposit is simulated). 1 Research Credit = 1 USDC of available value, shown after funds arrive on-chain.</p>
      <fieldset className="mt-6" disabled={quote !== null}><legend className="sr-only">Preset amounts</legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{PRESETS_CENTS.map((preset) => {
          const active = !custom.trim() && selected === preset;
          return <button key={preset} type="button" aria-pressed={active} onClick={() => { setSelected(preset); setCustom(''); }} className={`min-h-11 rounded-2xl border px-3 py-3 text-sm font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-midnight disabled:opacity-60 ${active ? 'border-midnight bg-midnight text-white' : 'border-silver bg-white hover:bg-porcelain'}`}>${formatWholeNumber(BigInt(preset / 100))}</button>;
        })}</div>
        <label htmlFor="custom-amount" className="mb-2 mt-5 block text-xs font-semibold">Custom amount (USD, up to 2 decimals)</label>
        <input id="custom-amount" inputMode="decimal" autoComplete="off" placeholder="e.g. 150.00" value={custom} onChange={(e) => setCustom(e.target.value)} aria-invalid={customInvalid} aria-describedby={customInvalid ? 'custom-error' : undefined} className={inputClass} />
        {customInvalid ? <p id="custom-error" role="alert" className="mt-2 text-xs text-red-700">Enter a positive dollar amount with at most 2 decimal places.</p> : null}
      </fieldset>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button type="button" className={primaryButtonClass} disabled={!canQuote || quote !== null} onClick={requestQuote}>{busy && !quote ? 'Requesting quote...' : 'Get quote'}</button>
        {cents !== null && cents >= 1 ? <span className="text-sm text-slate-600">${formatCents(cents)} USD</span> : null}
      </div>
      {!wallet.balanceFresh ? <p className="mt-4 text-xs text-slate-500">A quote needs a current, non-stale balance first{wallet.service === 'unavailable' ? ' (wallet service unavailable).' : '.'}</p> : null}
      {error && !quote ? <div className="mt-4"><Notice tone="error">{error}</Notice></div> : null}
    </section>

    <section className={cardClass} aria-labelledby="quote-heading" aria-live="polite">
      <p className={eyebrowClass}>STEP 2</p><h2 id="quote-heading" className="mt-3 text-3xl tracking-tight">Quote and deposit</h2>
      <AnimatePresence mode="wait" initial={false}>
        {!quote ? <motion.p key="empty" {...motionProps} className="mt-4 text-sm leading-7 text-slate-600">Request a quote to see MoonPay disclosures. Nothing is charged by requesting a quote.</motion.p>
        : deposited !== null ? <motion.div key="done" {...motionProps} className="mt-5 space-y-4">
          <Notice tone="success" title="Finalized balance increase detected">Your wallet&apos;s finalized USDC balance (as reported by the wallet service) increased by <b className="font-mono">{formatUsdc(deposited)} USDC</b>{wallet.balance ? <> and now shows <b>{formatWholeNumber(researchCredits(wallet.balance.spendableAtomic))}</b> Research Credits ({formatUsdc(wallet.balance.spendableAtomic)} USDC available)</> : null}.</Notice>
          <div className="flex flex-wrap gap-3"><Link href="/account/wallet" className={primaryButtonClass}>Back to wallet</Link><button type="button" className={buttonClass} onClick={reset}>Add more</button></div>
        </motion.div>
        : <motion.div key="quote" {...motionProps} className="mt-5 space-y-5">
          {mode === 'manual-devnet' ? <ManualDevnetFunding address={wallet.address} context="add-credits" /> : <>
            <dl className="divide-y divide-silver border-y border-silver text-sm">
              <div className="flex justify-between gap-4 py-3"><dt className="text-slate-600">Provider</dt><dd>{quote.provider}{quote.sandbox ? ' (sandbox)' : ''}</dd></div>
              <div className="flex justify-between gap-4 py-3"><dt className="text-slate-600">Amount</dt><dd>${quoteCents !== null ? formatCents(quoteCents) : ''} USD</dd></div>
              {quote.estimatedFeeUsdCents !== null ? <div className="flex justify-between gap-4 py-3"><dt className="text-slate-600">Estimated provider fee</dt><dd>${formatCents(quote.estimatedFeeUsdCents)}</dd></div> : null}
              {quote.estimatedUsdcAtomic !== null ? <div className="flex justify-between gap-4 py-3"><dt className="text-slate-600">Estimated USDC</dt><dd className="font-mono">{formatUsdc(quote.estimatedUsdcAtomic)}</dd></div> : null}
            </dl>
            {quote.estimatedUsdcAtomic !== null ? <p className="text-xs leading-6 text-slate-500">Estimate supplied by the provider. The amount that arrives may differ.</p> : <p className="text-xs leading-6 text-slate-500">The provider has not quoted a USDC amount. Fees and the final USDC received are set by MoonPay.</p>}
            {quote.disclosures.length ? <ul className="space-y-2 text-xs leading-6 text-slate-700">{quote.disclosures.map((d) => <li key={d} className="rounded-lg bg-porcelain p-3">{d}</li>)}</ul> : null}
            {mode === 'simulate' ? <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-amber-900"><FlaskConical size={16} aria-hidden="true" />SANDBOX SIMULATION</p>
              <p className="mt-2 text-xs leading-6 text-amber-900">This is not MoonPay. No identity check, card payment or real funds are involved. The button asks the sandbox API to simulate a deposit of devnet USDC to your wallet.</p>
              <button type="button" className={`${primaryButtonClass} mt-4`} disabled={busy || simulated} onClick={simulate}>{simulated ? 'Simulation requested' : busy ? 'Simulating...' : 'Simulate MoonPay deposit'}</button>
            </div> : widget ? <a href={widget} target="_blank" rel="noopener noreferrer" className={primaryButtonClass}>Continue to MoonPay <ExternalLink size={14} aria-hidden="true" /></a> : <Notice tone="error">The provider did not return a secure (https) payment link, so it was not opened.</Notice>}
          </>}
          <div className="rounded-xl border border-silver bg-porcelain p-4"><Spinner label="Waiting for a finalized balance increase..." /><p className="mt-2 text-xs leading-6 text-slate-600"><b>Credits appear after USDC arrives on-chain.</b> {mode === 'manual-devnet' ? 'We only show them once your finalized wallet balance rises.' : 'A completed checkout or simulation alone does not add credits; we only show them once your finalized wallet balance rises.'}</p></div>
          <button type="button" className={buttonClass} onClick={reset}>Cancel and start over</button>
          {error ? <Notice tone="error">{error}</Notice> : null}
        </motion.div>}
      </AnimatePresence>
    </section>
  </div>;
}

export function AddCreditsFlow() {
  return <>
    <ServiceNotice />
    <WalletGate><Flow /></WalletGate>
    <WalletDisclosures />
  </>;
}
