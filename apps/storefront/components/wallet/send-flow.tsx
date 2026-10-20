'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from './wallet-provider';
import { buttonClass, cardClass, CopyButton, eyebrowClass, inputClass, Notice, primaryButtonClass, ServiceNotice, WalletGate } from './ui';
import { WalletDisclosures } from './wallet-disclosures';
import { errorMessage, prepareTransfer, submitTransfer, WalletApiError, type TransferPreparation, type TransferSubmission } from '../../lib/wallet/api';
import { formatSol, formatUsdc, parseUsdcInput } from '../../lib/wallet/credits';
import { verifyUsdcTransfer } from '../../lib/wallet/tx';

type Step = 'form' | 'review' | 'sent';

function parseAddress(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try { return new PublicKey(trimmed).toBase58(); } catch { return null; }
}

function Flow() {
  const wallet = useWallet();
  const reduce = useReducedMotion();
  const [step, setStep] = useState<Step>('form');
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [max, setMax] = useState(false);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<TransferPreparation | null>(null);
  const [recipient, setRecipient] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [result, setResult] = useState<TransferSubmission | null>(null);

  // A stale or unreachable balance is shown as unknown, never as 0 (the API reports stale:true with spendable 0).
  const spendable = wallet.balanceFresh && wallet.balance ? wallet.balance.spendableAtomic : null;
  const parsedDestination = parseAddress(destination);
  const parsedAmount = max ? null : parseUsdcInput(amount);
  const destinationError = touched && !parsedDestination ? (destination.trim() ? 'This is not a valid Solana address.' : 'Enter a recipient address.') : parsedDestination && parsedDestination === wallet.address ? 'This is your own wallet address.' : null;
  const amountError = touched && !max ? (parsedAmount === null ? 'Enter an amount with up to 6 decimal places.' : parsedAmount === 0n ? 'Amount must be greater than zero.' : spendable !== null && parsedAmount > spendable ? `Amount exceeds your available balance of ${formatUsdc(spendable)} USDC.` : null) : null;
  const motionProps = reduce ? {} : { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -8 }, transition: { duration: 0.2 } };

  const prepare = async () => {
    setTouched(true); setError(null);
    if (!wallet.email || !parsedDestination || parsedDestination === wallet.address) return;
    if (!max && (parsedAmount === null || parsedAmount === 0n || (spendable !== null && parsedAmount > spendable))) return;
    if (max && spendable === null) { setError('Your balance is not available right now, so the maximum cannot be determined. Try again once the balance refreshes.'); return; }
    if (max && spendable === 0n) { setError('There is no available USDC balance to send.'); return; }
    setBusy(true);
    try {
      const next = await prepareTransfer(wallet.email, max ? { destination: parsedDestination, max: true } : { destination: parsedDestination, amountAtomic: parsedAmount ?? 0n });
      if (!max && next.amountAtomic !== parsedAmount) { setError('The service prepared a different amount than you entered. Nothing was signed.'); return; }
      setPrepared(next); setRecipient(parsedDestination); setAcknowledged(false); setStep('review');
    } catch (e) { setError(errorMessage(e, 'Wallet service unavailable')); } finally { setBusy(false); }
  };

  const confirmAndSend = async () => {
    if (!wallet.email || !wallet.signer || !prepared || !acknowledged) return;
    setBusy(true); setError(null);
    try {
      const problems = verifyUsdcTransfer(prepared.unsignedTransactionBase64, { signer: wallet.signer.address, destinationOwner: recipient, amountAtomic: prepared.amountAtomic });
      if (problems.length) { setError(`Not signed. The prepared transaction does not match what is shown: ${problems.join(' ')}`); return; }
      const signed = await wallet.signer.signTransaction(prepared.unsignedTransactionBase64);
      setResult(await submitTransfer(wallet.email, prepared.id, signed));
      setStep('sent');
      void wallet.refresh();
    } catch (e) {
      const lostConnection = e instanceof WalletApiError && e.unavailable;
      setError(`${errorMessage(e, 'Wallet service unavailable')}${lostConnection ? ' The transfer may or may not have been submitted: check Transaction history on the wallet page before trying again.' : ''}`);
    } finally { setBusy(false); }
  };

  const restart = () => { setStep('form'); setPrepared(null); setResult(null); setDestination(''); setAmount(''); setMax(false); setTouched(false); setError(null); setAcknowledged(false); };

  return <section className={cardClass} aria-live="polite">
    <AnimatePresence mode="wait" initial={false}>
      {step === 'form' ? <motion.form key="form" {...motionProps} noValidate onSubmit={(e) => { e.preventDefault(); void prepare(); }} className="max-w-xl space-y-6">
        <div><p className={eyebrowClass}>STEP 1 OF 3</p><h2 className="mt-3 text-3xl tracking-tight">Recipient and amount</h2>
          <p className="mt-3 text-sm leading-7 text-slate-600">Sends devnet USDC from your wallet. Available to send: <b className="font-mono text-midnight">{spendable !== null ? `${formatUsdc(spendable)} USDC` : 'unknown (balance unavailable)'}</b></p></div>
        <div><label htmlFor="send-destination" className="mb-2 block text-sm font-medium">Recipient Solana address</label>
          <input id="send-destination" className={`${inputClass} font-mono`} spellCheck={false} autoComplete="off" value={destination} onChange={(e) => setDestination(e.target.value)} onBlur={() => setTouched(true)} aria-invalid={Boolean(destinationError)} aria-describedby={destinationError ? 'dest-error' : undefined} />
          {destinationError ? <p id="dest-error" role="alert" className="mt-2 text-xs text-red-700">{destinationError}</p> : null}</div>
        <div><label htmlFor="send-amount" className="mb-2 block text-sm font-medium">Amount (USDC)</label>
          <div className="flex gap-3"><input id="send-amount" inputMode="decimal" autoComplete="off" placeholder="0.000000" disabled={max} className={`${inputClass} font-mono`} value={max && spendable !== null ? formatUsdc(spendable) : amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={Boolean(amountError)} aria-describedby={amountError ? 'amount-error' : 'amount-help'} />
            <button type="button" aria-pressed={max} className={`${buttonClass} shrink-0 ${max ? 'border-midnight bg-midnight text-white hover:bg-slate-700' : ''}`} onClick={() => setMax((m) => !m)}>Send max</button></div>
          {amountError ? <p id="amount-error" role="alert" className="mt-2 text-xs text-red-700">{amountError}</p> : <p id="amount-help" className="mt-2 text-xs leading-6 text-slate-500">{max ? 'Sends your entire available USDC balance. The network fee is paid in SOL from your wallet, not taken from the USDC amount, so you need devnet SOL in this wallet.' : 'Up to 6 decimal places. The network fee is paid separately in SOL from your wallet.'}</p>}</div>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <button type="submit" className={primaryButtonClass} disabled={busy || wallet.service === 'unavailable'}>{busy ? 'Preparing...' : 'Review transfer'}</button>
        {wallet.service === 'unavailable' ? <p className="text-xs text-slate-500">Wallet service unavailable. Transfers cannot be prepared right now.</p> : null}
      </motion.form>
      : step === 'review' && prepared ? <motion.div key="review" {...motionProps} className="max-w-xl space-y-6">
        <div><p className={eyebrowClass}>STEP 2 OF 3</p><h2 className="mt-3 text-3xl tracking-tight">Review and confirm</h2></div>
        <dl className="divide-y divide-silver border-y border-silver text-sm">
          <div className="grid gap-1 py-4"><dt className="text-xs font-semibold text-slate-600">Recipient</dt><dd className="break-all font-mono">{recipient}</dd></div>
          <div className="flex justify-between gap-4 py-4"><dt className="text-xs font-semibold text-slate-600">Amount</dt><dd className="font-mono text-base">{formatUsdc(prepared.amountAtomic)} USDC</dd></div>
          <div className="flex justify-between gap-4 py-4"><dt className="text-xs font-semibold text-slate-600">Estimated SOL cost (network fee, plus recipient account rent if one must be created)</dt><dd className="font-mono">{prepared.feeLamports !== null ? `${formatSol(prepared.feeLamports)} SOL` : 'Not provided by service'}</dd></div>
          <div className="flex justify-between gap-4 py-4"><dt className="text-xs font-semibold text-slate-600">Network</dt><dd>Solana devnet</dd></div>
        </dl>
        {prepared.warnings.length ? <Notice tone="warn" title="Service warnings"><ul className="list-disc pl-5">{prepared.warnings.map((w) => <li key={w}>{w}</li>)}</ul></Notice> : null}
        <Notice tone="warn" title="Transfers may be irreversible">Once submitted, this transfer cannot be recalled by us or anyone else. Confirm the recipient address character by character.</Notice>
        <label className="flex min-h-11 items-start gap-3 rounded-xl border border-silver p-4 text-sm leading-6"><input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-[#0B1220]" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} /> I have checked the recipient and amount, and I authorize my wallet to sign this transfer.</label>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <div className="flex flex-wrap gap-3"><button type="button" className={primaryButtonClass} disabled={!acknowledged || busy} onClick={confirmAndSend}>{busy ? 'Signing and sending...' : 'Sign and send'}</button><button type="button" className={buttonClass} disabled={busy} onClick={() => { setStep('form'); setError(null); }}>Back</button></div>
        <p className="text-xs leading-6 text-slate-500">Signing happens in this browser with your sandbox key. The key is never sent to the platform.</p>
      </motion.div>
      : result ? <motion.div key="sent" {...motionProps} className="max-w-xl space-y-5">
        <div><p className={eyebrowClass}>STEP 3 OF 3</p><h2 className="mt-3 text-3xl tracking-tight">Transfer submitted, not yet final</h2></div>
        <Notice tone="info" title={`Status: ${result.status}`}>Submitted is not the same as final. The amount is deducted from your available balance while the transfer is pending; it is final only when the history shows it as Finalized. If the network rejects or never lands it, it becomes Failed or Expired and the amount is available again.</Notice>
        <div><p className="text-xs font-semibold text-slate-600">Transaction signature</p><p className="mt-2 break-all rounded-xl border border-silver bg-porcelain p-4 font-mono text-xs">{result.signature}</p></div>
        <div className="flex flex-wrap gap-3"><CopyButton value={result.signature} label="Copy signature" /><a className={buttonClass} target="_blank" rel="noopener noreferrer" href={`https://explorer.solana.com/tx/${encodeURIComponent(result.signature)}?cluster=devnet`}>View on devnet explorer</a><Link className={buttonClass} href="/account/wallet">Back to wallet</Link><button type="button" className={buttonClass} onClick={restart}>Send another</button></div>
      </motion.div> : null}
    </AnimatePresence>
  </section>;
}

export function SendFlow() {
  return <>
    <ServiceNotice />
    <WalletGate><Flow /></WalletGate>
    <WalletDisclosures />
  </>;
}
