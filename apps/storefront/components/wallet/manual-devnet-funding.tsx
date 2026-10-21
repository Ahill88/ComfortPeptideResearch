'use client';

import { ExternalLink } from 'lucide-react';
import { CopyButton } from './ui';
import { manualDevnetCopy } from '../../lib/wallet/topup-flow';

const linkClass = 'font-semibold underline underline-offset-4';

/**
 * Shown instead of a "Simulate MoonPay deposit" button when the API is on real Solana devnet and MoonPay is not connected.
 * Nothing here pretends a purchase is happening. The address is the browser wallet's PUBLIC address (the account's linked wallet).
 */
export function ManualDevnetFunding({ address, context }: { address: string | null; context: 'add-credits' | 'checkout' }) {
  const copy = manualDevnetCopy(context);
  return <div className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900" data-testid="manual-devnet-funding">
    <p className="text-sm font-semibold">{copy.title}</p>
    <p className="text-xs leading-6">{copy.intro}</p>
    {address ? <div className="rounded-lg bg-white/70 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-[.12em] text-slate-600">{copy.sendTo}</p>
      <p className="mt-1 break-all font-mono text-xs text-midnight">{address}</p>
      <div className="mt-2"><CopyButton value={address} label="Copy address" /></div>
    </div> : null}
    <ol className="list-decimal space-y-2 pl-5 text-xs leading-6">
      <li>{copy.usdcStep.before} <a className={linkClass} href={copy.usdcStep.url} target="_blank" rel="noopener noreferrer">{copy.usdcStep.linkLabel} <ExternalLink size={12} className="inline" aria-hidden="true" /></a></li>
      <li>{copy.solNote.before} <a className={linkClass} href={copy.solNote.url} target="_blank" rel="noopener noreferrer">{copy.solNote.linkLabel} <ExternalLink size={12} className="inline" aria-hidden="true" /></a>.</li>
    </ol>
    <p className="text-xs leading-6">{copy.watch}</p>
  </div>;
}
