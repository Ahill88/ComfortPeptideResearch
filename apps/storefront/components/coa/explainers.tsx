import Link from 'next/link';
import { Check, Minus } from 'lucide-react';
import { CopyButton } from './copy-button';
import { Field, cardClass, monoBoxClass } from './ui';
import type { AnchorInfo } from '../../lib/coa/model';
import { networkBadge } from '../../lib/coa/status';

export const PROVES = [
  'This exact PDF is the document we recorded for this lot (down to the last byte).',
  'It has not been changed since the record time. If one byte differs, the fingerprint (SHA-256) no longer matches.',
  'Where an anchor is shown, the record time is fixed by a public ledger entry that neither we nor you can quietly edit afterwards.',
];
export const DOES_NOT_PROVE = [
  'That the lab\u2019s results are true or accurate. The figures are reported by the lab; we publish them and make no claim about them.',
  'That the material in your vial is the material that was tested. The lot code links the two; the record cannot inspect the vial.',
  'Any endorsement, or any claim of suitability for any use. This is a tamper-evident, publicly checkable record, nothing more.',
];

export function ProvesBlock() {
  return <section aria-labelledby="proves-heading" className={cardClass}>
    <h2 id="proves-heading" className="text-xl font-medium tracking-tight">What this proves, and what it does not</h2>
    <p className="mt-2 text-sm leading-6 text-slate-600">A lot record is a tamper-evident, publicly checkable record. Read both columns.</p>
    <div className="mt-6 grid gap-6 md:grid-cols-2">
      <div>
        <h3 className="text-sm font-semibold">It proves</h3>
        <ul className="mt-3 space-y-3 text-sm leading-6">{PROVES.map((t) => <li key={t} className="flex gap-3"><Check size={16} aria-hidden="true" className="mt-1 shrink-0 text-emerald-800" /><span>{t}</span></li>)}</ul>
      </div>
      <div>
        <h3 className="text-sm font-semibold">It does not prove</h3>
        <ul className="mt-3 space-y-3 text-sm leading-6">{DOES_NOT_PROVE.map((t) => <li key={t} className="flex gap-3"><Minus size={16} aria-hidden="true" className="mt-1 shrink-0 text-slate-700" /><span>{t}</span></li>)}</ul>
      </div>
    </div>
  </section>;
}

const COMMANDS = [
  { os: 'macOS', command: 'shasum -a 256 ~/Downloads/coa.pdf' },
  { os: 'Linux', command: 'sha256sum ~/Downloads/coa.pdf' },
  { os: 'Windows (PowerShell)', command: 'Get-FileHash -Algorithm SHA256 "$HOME\\Downloads\\coa.pdf"' },
];

export function HowToVerify({ info }: { info: AnchorInfo | null }) {
  return <section id="how-to-verify" aria-labelledby="how-heading" className={cardClass}>
    <h2 id="how-heading" className="text-xl font-medium tracking-tight">How to verify it yourself</h2>
    <p className="mt-2 text-sm leading-6 text-slate-600">You do not need to trust this page. These steps use only your own computer and a public explorer.</p>
    <ol className="mt-6 space-y-6 text-sm leading-6">
      <li><b>1. Download the PDF</b> from the lot record (use &ldquo;Download PDF&rdquo;).</li>
      <li>
        <b>2. Compute its SHA-256</b> with a command on your own machine (replace the path with where you saved it):
        <div className="mt-3 space-y-3">{COMMANDS.map((c) => <div key={c.os}>
          <p className="text-[11px] font-medium uppercase tracking-[.12em] text-slate-600">{c.os}</p>
          <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-center"><code className={`${monoBoxClass} sm:flex-1`}>{c.command}</code><CopyButton value={c.command} what={`${c.os} command`} /></div>
        </div>)}</div>
      </li>
      <li><b>3. Compare</b> the 64-character result with the SHA-256 shown on the lot record. They must be identical (letter case does not matter).</li>
      <li><b>4. Open the Solana transaction</b> from the lot record&apos;s anchor section.</li>
      <li><b>5. Compare the memo.</b> In the explorer, find the Memo instruction. Its text must read <code className="break-all font-mono text-xs">helix-coa:v1:publish:&lt;lot code&gt;:&lt;version&gt;:&lt;sha256&gt;</code> with your lot code, version and the same SHA-256.</li>
      <li>
        <b>6. Compare the publisher address.</b> The transaction&apos;s fee payer should be the publisher address our public anchor-info lists:
        <PublisherLine info={info} />
      </li>
    </ol>
  </section>;
}

function PublisherLine({ info }: { info: AnchorInfo | null }) {
  if (!info) return <p className="mt-2 text-slate-600">The publisher address could not be loaded right now. Try again shortly.</p>;
  if (!info.publisher) return <p className="mt-2 text-slate-600">No publisher address is listed at the moment{info.anchoringEnabled ? '' : ' (on-chain anchoring is not enabled)'}, so there is nothing to compare against yet.</p>;
  const badge = info.network ? networkBadge(info.network) : null;
  return <div className="mt-3 space-y-2">
    <dl className="grid gap-4 sm:grid-cols-2"><Field label="Network">{badge ? badge.label : 'Not reported'}</Field><Field label="Anchoring">{info.anchoringEnabled ? 'Enabled' : 'Not enabled'}</Field></dl>
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center"><code className={`${monoBoxClass} sm:flex-1`}>{info.publisher}</code><CopyButton value={info.publisher} what="publisher address" /></div>
    {badge?.isTest ? <p className="text-xs leading-5 text-amber-900">This deployment anchors to Solana devnet, a test network. Test records are not production records.</p> : null}
    <p className="text-xs leading-5 text-slate-600">Memo program: <span className="break-all font-mono">{info.memoProgramId}</span></p>
  </div>;
}

export function NoRecordHelp() {
  return <p className="text-sm leading-6 text-slate-600">Check the lot code against your label or packing slip. A lot appears here only after a certificate of analysis has been published for it. Looking for a file instead? Use <Link className="underline underline-offset-4" href="/verify#verify-file">Verify a file</Link>.</p>;
}
