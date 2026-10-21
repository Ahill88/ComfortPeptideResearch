import type { Metadata } from 'next';
import { FileLookup } from '../../components/coa/hash-tools';
import { HowToVerify, ProvesBlock } from '../../components/coa/explainers';
import { LotLookupForm } from '../../components/coa/lot-lookup-form';
import { PrintStyle, cardClass, eyebrowClass } from '../../components/coa/ui';
import { fetchAnchorInfo } from '../../lib/coa/client';

const TITLE = 'Verify a lot | Helix & Field';
const DESCRIPTION = 'Look up a lot code or check a PDF in your browser against our tamper-evident, publicly checkable certificate of analysis records.';
export const metadata: Metadata = { title: TITLE, description: DESCRIPTION, openGraph: { title: TITLE, description: DESCRIPTION, type: 'website', siteName: 'Helix & Field' } };
export const dynamic = 'force-dynamic';

export default async function VerifyPage() {
  const info = await fetchAnchorInfo();
  return <main className="mx-auto min-h-[60vh] max-w-[1100px] bg-porcelain px-5 py-12 font-sans text-midnight sm:px-8 lg:py-20">
    <PrintStyle />
    <p className={eyebrowClass}>COA verification</p>
    <h1 className="mt-4 max-w-3xl text-4xl leading-[1.05] tracking-[-.045em] sm:text-6xl">Check a lot&apos;s certificate of analysis.</h1>
    <p className="mt-5 max-w-2xl text-base leading-7 text-slate-700">Each certificate of analysis we publish is kept as a tamper-evident, publicly checkable record: look up a lot code, or drop in a PDF to see whether it is the exact document we recorded.</p>
    <div className="mt-10 grid gap-6 lg:grid-cols-2">
      <section aria-labelledby="lookup-heading" className={cardClass}>
        <h2 id="lookup-heading" className="text-xl font-medium tracking-tight">Look up a lot</h2>
        <p className="mt-2 mb-5 text-sm leading-6 text-slate-600">Opens the public record for that lot: status, lab details, the PDF and its on-chain anchor.</p>
        <LotLookupForm />
      </section>
      <section id="verify-file" aria-labelledby="file-heading" className={cardClass}>
        <h2 id="file-heading" className="text-xl font-medium tracking-tight">Verify a file</h2>
        <p className="mt-2 mb-5 text-sm leading-6 text-slate-600">Got a PDF and want to know if it is one of ours? Its fingerprint is calculated here, on your device, and looked up.</p>
        <FileLookup />
      </section>
    </div>
    <div className="mt-6 space-y-6">
      <ProvesBlock />
      <HowToVerify info={info} />
    </div>
    <p className="mt-8 text-xs leading-5 text-slate-600">Research use only. Not for human or veterinary use.</p>
  </main>;
}
