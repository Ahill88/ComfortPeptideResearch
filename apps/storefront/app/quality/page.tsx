import Link from 'next/link';
import { InfoPage } from '../../components/info-page';

export default function Quality() {
  return <InfoPage eyebrow="Quality & documentation" title="Evidence comes first.">
    <p>Helix &amp; Field is committed to analytical verification for every product listed. We provide lot-specific certificates of analysis, CAS-verified molecular identity, and transparent handling information so you can make informed decisions for your research.</p>
    <section className="rounded-2xl border border-slate-200 bg-slate-50 p-6 sm:p-8">
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-[.15em] text-slate-500">Quality commitments</p>
      <h2>What you'll find for every product.</h2>
      <ul className="mt-4 space-y-3 text-sm leading-6 text-slate-700">
        <li><strong>CAS verification</strong> — every product linked to its Chemical Abstracts Service identifier.</li>
        <li><strong>Lot-specific COA</strong> — analytical results tied to the exact lot you receive.</li>
        <li><strong>Purity reporting</strong> — HPLC and mass spec data when available.</li>
        <li><strong>Storage &amp; handling</strong> — clear instructions to maintain material integrity.</li>
      </ul>
    </section>
    <section>
      <h2>How to evaluate a listing</h2>
      <p>Before selecting a material, confirm the CAS number matches your target compound, review the certificate of analysis for the specific lot, and check that purity data meets your research requirements. Storage conditions should align with your laboratory capabilities.</p>
    </section>
    <section>
      <h2>Questions about a material?</h2>
      <p>Visit <Link href="/contact" className="font-medium text-[#0B1220] underline">contact</Link> for the available inquiry options. We encourage you to reach out before placing an order if you need clarification on any product documentation.</p>
    </section>
    <p className="border-l-2 border-slate-300 pl-5 text-sm">Materials are presented for laboratory research only, not for human or veterinary use, and are not offered as drugs, supplements, or treatments.</p>
  </InfoPage>;
}
