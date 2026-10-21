/**
 * Shared presentation primitives for the COA pages. Server-safe (no hooks).
 * The class strings mirror components/wallet/ui.tsx so the pages share one design language, but that file is not imported:
 * it is a client module that pulls the wallet provider and signer code, which a public verification page must not ship.
 */
import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, XCircle } from 'lucide-react';
import type { Tone } from '../../lib/coa/status';

export const cardClass = 'rounded-2xl border border-silver bg-white p-5 sm:p-8 print:rounded-none print:border-slate-400 print:p-4';
export const buttonClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl border border-silver bg-white px-5 py-3 text-xs font-semibold text-midnight transition hover:bg-porcelain focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-midnight disabled:cursor-not-allowed disabled:opacity-50';
export const primaryButtonClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl border border-midnight bg-midnight px-5 py-3 text-xs font-semibold text-white transition hover:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-midnight disabled:cursor-not-allowed disabled:opacity-50';
export const inputClass = 'min-h-11 w-full rounded-xl border border-slate-400 bg-white px-3.5 py-3 text-sm text-midnight outline-none transition focus:border-slate-600 focus:ring-2 focus:ring-sky-200';
export const eyebrowClass = 'font-mono text-[11px] font-medium uppercase tracking-[.17em] text-slate-600';
export const monoBoxClass = 'break-all rounded-xl border border-silver bg-porcelain px-3.5 py-3 font-mono text-xs leading-6 text-midnight';

export const toneStyles: Record<Tone, string> = {
  positive: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  caution: 'border-amber-300 bg-amber-50 text-amber-900',
  negative: 'border-red-300 bg-red-50 text-red-900',
  neutral: 'border-slate-300 bg-porcelain text-slate-700',
};

export function ToneIcon({ tone, size = 18 }: { tone: Tone; size?: number }) {
  const props = { size, 'aria-hidden': true as const, className: 'shrink-0' };
  if (tone === 'positive') return <CheckCircle2 {...props} />;
  if (tone === 'negative') return <XCircle {...props} />;
  if (tone === 'caution') return <AlertTriangle {...props} />;
  return <CircleDashed {...props} />;
}

/** Status is always icon + text + border; colour is reinforcement only. */
export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[.08em] ${toneStyles[tone]}`}><ToneIcon tone={tone} size={13} />{children}</span>;
}

export function Panel({ tone = 'neutral', title, id, children }: { tone?: Tone; title: string; id: string; children: ReactNode }) {
  return <section aria-labelledby={id} className={`rounded-2xl border p-5 sm:p-6 print:rounded-none print:p-4 ${toneStyles[tone]}`}>
    <h2 id={id} className="flex items-center gap-2 text-base font-semibold tracking-tight"><ToneIcon tone={tone} />{title}</h2>
    <div className="mt-3 text-sm leading-6">{children}</div>
  </section>;
}

export function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return <div className={wide ? 'sm:col-span-2' : undefined}><dt className="text-[11px] font-medium uppercase tracking-[.12em] text-slate-600">{label}</dt><dd className="mt-1 break-words text-sm text-midnight">{children}</dd></div>;
}

/** Standard print rules for the verification pages: drop site chrome and controls, keep the record, show link targets. */
export function PrintStyle() {
  return <style>{`@media print {
    body { background: #fff !important; }
    header, footer { display: none !important; }
    .no-print { display: none !important; }
    a[href^="http"]::after { content: " (" attr(href) ")"; font-size: 9px; word-break: break-all; }
  }`}</style>;
}
