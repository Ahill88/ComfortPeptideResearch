import { ProtectedView } from '../../../components/account-views';

export default function OrderTracking() {
  return <ProtectedView><main className="mx-auto min-h-[60vh] max-w-5xl px-5 py-14 sm:px-8 lg:py-20"><p className="font-mono text-[10px] tracking-[.17em] text-blue">ORDER DETAIL / LOCAL PREVIEW</p><h1 className="mt-4 border-b border-line pb-8 font-display text-5xl tracking-[-.045em] sm:text-6xl">Order status.</h1><section className="mt-8 max-w-2xl border border-line bg-white p-6"><p className="font-mono text-[10px] tracking-[.13em] text-blue">HF-1048</p><h2 className="mt-3 font-display text-3xl">Delivered</h2><p className="mt-3 text-sm leading-6 text-slate-600">This tracking detail is illustrative local preview data. Production fulfillment and carrier events are not connected.</p></section></main></ProtectedView>;
}
