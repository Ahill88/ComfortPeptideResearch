import { formatUsd } from '../../money';
import type { Totals } from './model';
import type { QuoteState } from './request';

export function OrderTotals({ totals, partial = false }: { totals: Totals | null; partial?: boolean }) {
  return <div aria-live="polite">
    <dl aria-label="Order totals" className="space-y-3 text-sm">
      {([['Materials subtotal', 'subtotalCents'], ['Shipping', 'shippingCents'], ['Tax', 'taxCents'], ['Total', 'totalCents']] as const).map(([label, key]) => <div key={key} className={`flex justify-between gap-4 ${key === 'totalCents' ? 'border-t border-slate-200 pt-3 font-semibold' : ''}`}><dt>{label}</dt><dd className="tabular-nums">{totals ? formatUsd(totals[key]) : 'Unavailable'}</dd></div>)}
    </dl>
    <p className="mt-3 text-xs leading-5 text-slate-600">{partial ? 'Partial quote: totals include only materials the service could price. Checkout is blocked.' : 'USD. Prices, shipping and tax are supplied by the order service.'}</p>
  </div>;
}

export function QuoteStatus({ state, onRefresh }: { state: QuoteState; onRefresh: () => void }) {
  if (state.kind === 'idle' || state.kind === 'loading') return <p role="status" className="mt-3 text-sm text-slate-600">Checking current prices and availability…</p>;
  return <div className="mt-3 space-y-2 text-xs leading-5 text-slate-600">
    {state.kind === 'error' ? <p role="alert">{state.message} Checkout needs a current quote.</p> : <p>Stock is checked again when your order is placed. A quote does not reserve stock.</p>}
    <button type="button" className="min-h-11 underline underline-offset-4" onClick={onRefresh}>Refresh quote</button>
  </div>;
}
