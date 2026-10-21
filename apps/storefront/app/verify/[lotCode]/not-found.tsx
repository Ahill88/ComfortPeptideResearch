import Link from 'next/link';
import { LotLookupForm } from '../../../components/coa/lot-lookup-form';
import { NoRecordHelp } from '../../../components/coa/explainers';
import { cardClass, eyebrowClass } from '../../../components/coa/ui';

export default function LotNotFound() {
  return <main className="mx-auto min-h-[60vh] max-w-[760px] bg-porcelain px-5 py-12 font-sans text-midnight sm:px-8 lg:py-20">
    <p className={eyebrowClass}>COA verification</p>
    <h1 className="mt-4 text-4xl leading-tight tracking-[-.045em] sm:text-5xl">We have no published record for that lot code.</h1>
    <p className="mt-4 text-sm leading-6 text-slate-700">That does not say anything about the material: it only means no certificate of analysis is published under this exact code. The code may contain a typo, or the COA may not be published yet.</p>
    <div className={`${cardClass} mt-8`}><h2 className="mb-4 text-xl font-medium tracking-tight">Try another code</h2><LotLookupForm /></div>
    <div className="mt-6"><NoRecordHelp /></div>
    <p className="mt-6"><Link className="inline-flex min-h-11 items-center text-sm underline underline-offset-4" href="/verify">Back to Verify</Link></p>
  </main>;
}
