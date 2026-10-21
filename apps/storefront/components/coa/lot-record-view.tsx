import Link from 'next/link';
import { Download, ExternalLink, FileText } from 'lucide-react';
import { AnchorBlock } from './anchor-block';
import { CopyButton } from './copy-button';
import { VerifyPdfControl } from './hash-tools';
import type { OtherVersion } from './hash-tools';
import { Field, Panel, Pill, buttonClass, cardClass, eyebrowClass, monoBoxClass } from './ui';
import { pdfHref } from '../../lib/coa/client';
import { formatBytes, formatDay, formatInstantUtc, formatPurity, lotBanner, versionStatus } from '../../lib/coa/status';
import type { AnchorInfo, PublicCoa, PublicLotRecord } from '../../lib/coa/model';

function DocumentCard({ record, coa, info }: { record: PublicLotRecord; coa: PublicCoa; info: AnchorInfo | null }) {
  const href = pdfHref(coa.file);
  const others: OtherVersion[] = record.versions.map((v) => ({ version: v.version, sha256: v.file.sha256, status: v.status }));
  const labLabel = `as reported by ${coa.lab.name}`;
  return <div className="grid gap-6 lg:grid-cols-2">
    <section aria-labelledby="coa-heading" className={cardClass}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="coa-heading" className="text-xl font-medium tracking-tight">Certificate of analysis, version {coa.version}</h2>
        <Pill tone={versionStatus(coa.status).tone}>{versionStatus(coa.status).label}</Pill>
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-600">Lab details and purity below are {labLabel}. We publish the lab&apos;s document; we do not restate or vouch for its results.</p>
      <dl className="mt-6 grid gap-x-8 gap-y-4 sm:grid-cols-2">
        <Field label="Laboratory">{coa.lab.name}</Field>
        <Field label="Lab report ID"><span className="font-mono text-xs">{coa.lab.reportId}</span></Field>
        <Field label="Test date">{formatDay(coa.testedAt)}</Field>
        <Field label="Method">{coa.method}</Field>
        <Field label={`Purity (${labLabel})`}><span className="text-2xl font-medium tracking-tight">{formatPurity(coa.purityPercent)}</span></Field>
        {coa.publishedAt ? <Field label="Published">{formatInstantUtc(coa.publishedAt)}</Field> : null}
        {coa.notes ? <Field label="Lab notes" wide><span className="whitespace-pre-wrap">{coa.notes}</span></Field> : null}
      </dl>
      <div className="mt-6 border-t border-silver pt-6">
        <p className="flex items-center gap-2 text-sm font-semibold"><FileText size={16} aria-hidden="true" />{coa.file.name}<span className="font-normal text-slate-600">({formatBytes(coa.file.sizeBytes)})</span></p>
        <div className="no-print mt-3 flex flex-wrap gap-2">
          <a className={buttonClass} href={href} target="_blank" rel="noopener noreferrer">Open PDF preview <ExternalLink size={13} aria-hidden="true" /><span className="sr-only">(opens in a new tab)</span></a>
          <a className={buttonClass} href={href} download={coa.file.name}>Download PDF <Download size={13} aria-hidden="true" /></a>
        </div>
        <p className="mt-5 text-[11px] font-medium uppercase tracking-[.12em] text-slate-600">SHA-256 of the PDF</p>
        <p className={`${monoBoxClass} mt-1`}>{coa.file.sha256}</p>
        <div className="mt-2"><CopyButton value={coa.file.sha256} what="SHA-256" label="Copy SHA-256" /></div>
      </div>
      <div className="no-print mt-6 border-t border-silver pt-6">
        <h3 className="text-sm font-semibold">Verify this PDF</h3>
        <div className="mt-3"><VerifyPdfControl target={{ lotCode: record.lotCode, version: coa.version, sha256: coa.file.sha256, status: coa.status, pdfUrl: href }} others={others} /></div>
      </div>
    </section>

    <section aria-labelledby="anchor-heading" className={cardClass}>
      <h2 id="anchor-heading" className="text-xl font-medium tracking-tight">Public anchor</h2>
      <p className="mt-2 text-xs leading-5 text-slate-600">The PDF&apos;s SHA-256 is written to the Solana ledger inside a memo, giving a timestamped, tamper-evident, publicly checkable record. It shows when and which document, not whether the lab&apos;s results are true.</p>
      <div className="mt-6 space-y-8">
        <AnchorBlock kind="publish" anchor={coa.anchors.publish} coa={coa} lotCode={record.lotCode} info={info} />
        {coa.status === 'revoked' ? <div className="border-t border-silver pt-6"><AnchorBlock kind="revoke" anchor={coa.anchors.revoke} coa={coa} lotCode={record.lotCode} info={info} /></div> : null}
      </div>
    </section>
  </div>;
}

function VersionHistory({ record, featured }: { record: PublicLotRecord; featured: PublicCoa }) {
  const rows = [...record.versions].sort((a, b) => b.version - a.version);
  const others: OtherVersion[] = record.versions.map((v) => ({ version: v.version, sha256: v.file.sha256, status: v.status }));
  return <section aria-labelledby="history-heading" className={cardClass}>
    <h2 id="history-heading" className="text-xl font-medium tracking-tight">Version history</h2>
    <p className="mt-2 text-xs leading-5 text-slate-600">Every version stays visible. Newer versions supersede older ones; revoked versions remain here with their reason.</p>
    <ol className="mt-6 divide-y divide-silver border-y border-silver">
      {rows.map((v) => {
        const st = versionStatus(v.status);
        const anchored = v.anchors.publish ? 'Anchored' : 'Not yet anchored';
        const isFeatured = v.version === featured.version;
        return <li key={v.version} className="py-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="text-sm font-semibold">Version {v.version}</span>
            <Pill tone={st.tone}>{st.label}</Pill>
            {isFeatured ? <span className="text-xs text-slate-600">(shown above)</span> : null}
          </div>
          <dl className="mt-3 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Tested">{formatDay(v.testedAt)}</Field>
            <Field label="Published">{v.publishedAt ? formatDay(v.publishedAt) : 'Not recorded'}</Field>
            {v.revokedAt ? <Field label="Revoked">{formatDay(v.revokedAt)}</Field> : null}
            <Field label="On-chain anchor">{anchored}{v.anchors.revoke ? ', revocation anchored' : ''}</Field>
            {v.revokeReason ? <Field label="Revocation reason" wide>{v.revokeReason}</Field> : null}
          </dl>
          <p className="mt-2 break-all font-mono text-[11px] leading-5 text-slate-600">SHA-256 {v.file.sha256}</p>
          <div className="no-print mt-3 flex flex-wrap gap-2">
            <a className={buttonClass} href={pdfHref(v.file)} target="_blank" rel="noopener noreferrer">Open PDF <ExternalLink size={13} aria-hidden="true" /><span className="sr-only">version {v.version} (opens in a new tab)</span></a>
          </div>
          {!isFeatured ? <details className="no-print group mt-3"><summary className="flex min-h-11 cursor-pointer list-none items-center text-xs font-semibold underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden">Check version {v.version}&apos;s PDF</summary>
            <div className="mt-3"><VerifyPdfControl target={{ lotCode: record.lotCode, version: v.version, sha256: v.file.sha256, status: v.status, pdfUrl: pdfHref(v.file) }} others={others} /></div>
          </details> : null}
        </li>;
      })}
    </ol>
  </section>;
}

export function LotRecordView({ record, info }: { record: PublicLotRecord; info: AnchorInfo | null }) {
  const banner = lotBanner(record);
  return <div className="space-y-6">
    <div>
      <p className={eyebrowClass}>Lot record</p>
      <h1 className="mt-3 break-all font-mono text-3xl font-medium tracking-tight sm:text-5xl">{record.lotCode}</h1>
      {record.product ? <p className="mt-3 text-lg text-slate-700">{record.product.name}</p> : null}
    </div>
    <Panel id="status-heading" tone={banner.tone} title={banner.title}>
      <p>{banner.detail}</p>
      {banner.reason ? <p className="mt-2"><b className="font-semibold">Reason given:</b> <span className="whitespace-pre-wrap">{banner.reason}</span></p> : null}
      {banner.positive ? <p className="mt-2 text-xs leading-5 opacity-90">Current means it is the version we publish for this lot today. Check the anchor and verify the PDF below instead of taking this banner on trust.</p> : null}
    </Panel>
    <DocumentCard record={record} coa={banner.featured} info={info} />
    <VersionHistory record={record} featured={banner.featured} />
    <p className="text-xs leading-5 text-slate-600">See <Link className="underline underline-offset-4" href="/verify#how-to-verify">how to verify it yourself</Link> without relying on this page. Research use only. Not for human or veterinary use.</p>
  </div>;
}

export function RecordUnavailable() {
  return <section aria-labelledby="unavailable-heading" className="rounded-2xl border border-slate-300 bg-porcelain p-6 sm:p-8">
    <h2 id="unavailable-heading" className="text-xl font-medium tracking-tight">Record unavailable</h2>
    <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-700">We could not load a usable record for this lot right now. Nothing is being shown rather than something unverified. Try again in a moment; if it persists, contact us with the lot code.</p>
  </section>;
}
