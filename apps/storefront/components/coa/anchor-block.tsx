import { ExternalLink } from 'lucide-react';
import { CopyButton } from './copy-button';
import { Field, Pill, buttonClass, monoBoxClass } from './ui';
import { formatInstantUtc, memoAgreesWithRecord, networkBadge } from '../../lib/coa/status';
import type { AnchorKind, AnchorInfo, PublicAnchor, PublicCoa } from '../../lib/coa/model';

const KIND_TITLE: Record<AnchorKind, string> = { publish: 'Recorded when this version was published', revoke: 'Recorded when this version was revoked' };

export function NotAnchored({ kind }: { kind: AnchorKind }) {
  return <div className="rounded-xl border border-slate-300 bg-porcelain p-4 text-sm leading-6 text-slate-700">
    <p className="font-semibold text-midnight">Not yet anchored</p>
    <p className="mt-1">{kind === 'publish'
      ? 'There is no confirmed on-chain anchor for this version yet. The COA record itself is published; the anchor appears here once it has been confirmed on-chain. This is neutral: it is not an error and not a verdict on the document.'
      : 'There is no confirmed on-chain anchor for the revocation yet. The revocation itself is already in effect on this page; the anchor appears here once confirmed.'}</p>
  </div>;
}

export function AnchorBlock({ kind, anchor, coa, lotCode, info }: { kind: AnchorKind; anchor: PublicAnchor | null; coa: PublicCoa; lotCode: string; info: AnchorInfo | null }) {
  if (!anchor) return <div className="space-y-2"><h3 className="text-sm font-semibold text-midnight">{KIND_TITLE[kind]}</h3><NotAnchored kind={kind} /></div>;
  const badge = networkBadge(anchor.network);
  const memoOk = memoAgreesWithRecord(anchor, kind, lotCode, coa);
  return <div className="space-y-4">
    <h3 className="text-sm font-semibold text-midnight">{KIND_TITLE[kind]}</h3>
    <div className="flex flex-wrap items-center gap-2">
      <Pill tone={badge.tone}>{badge.label}</Pill>
    </div>
    {badge.isTest ? <p className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900"><b>Test record.</b> {badge.note}</p> : null}
    <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
      <Field label="Slot">{anchor.slot === null ? 'Not reported' : anchor.slot.toLocaleString('en-US')}</Field>
      <Field label="Block time">{anchor.blockTime ? formatInstantUtc(anchor.blockTime) : 'Not reported'}</Field>
    </dl>
    <div>
      <p className="text-[11px] font-medium uppercase tracking-[.12em] text-slate-600">Transaction signature</p>
      <p className={`${monoBoxClass} mt-1`}>{anchor.txSignature}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <CopyButton value={anchor.txSignature} what="transaction signature" />
        <a href={anchor.explorerUrl} target="_blank" rel="noopener noreferrer" className={buttonClass}>Open in explorer <ExternalLink size={13} aria-hidden="true" /><span className="sr-only">(opens in a new tab)</span></a>
      </div>
    </div>
    <div>
      <p className="text-[11px] font-medium uppercase tracking-[.12em] text-slate-600">Exact memo recorded on-chain (plain text)</p>
      <p className={`${monoBoxClass} mt-1`}>{anchor.memo}</p>
      <div className="mt-2"><CopyButton value={anchor.memo} what="memo text" /></div>
      <p className={`mt-2 text-xs leading-5 ${memoOk ? 'text-slate-600' : 'font-semibold text-red-800'}`}>
        {memoOk
          ? 'Check passed in this page: the memo\u2019s lot code, version and SHA-256 agree with the record shown here. Compare it with the memo in the explorer yourself.'
          : 'Warning: this memo does NOT agree with the lot code, version and SHA-256 shown in this record. Do not rely on this anchor.'}
      </p>
    </div>
    <div>
      <p className="text-[11px] font-medium uppercase tracking-[.12em] text-slate-600">Publisher address (fee payer and signer)</p>
      {info?.publisher ? <>
        <p className={`${monoBoxClass} mt-1`}>{info.publisher}</p>
        <div className="mt-2"><CopyButton value={info.publisher} what="publisher address" /></div>
        <p className="mt-2 text-xs leading-5 text-slate-600">This is the key our public anchor-info lists as the publisher right now. The transaction&apos;s fee payer should be this address.</p>
      </> : <p className="mt-1 text-xs leading-5 text-slate-600">The publisher address could not be loaded right now. It is listed on the Verify page once available.</p>}
    </div>
  </div>;
}
