import { cache } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { LotRecordView, RecordUnavailable } from '../../../components/coa/lot-record-view';
import { PrintStyle } from '../../../components/coa/ui';
import { fetchAnchorInfo, fetchLotRecord } from '../../../lib/coa/client';
import { lotCodeFromParam } from '../../../lib/coa/codes';
import { lotBanner } from '../../../lib/coa/status';

export const dynamic = 'force-dynamic';

// One fetch per request, shared by generateMetadata and the page.
const loadLot = cache((code: string) => fetchLotRecord(code));

export async function generateMetadata({ params }: { params: Promise<{ lotCode: string }> }): Promise<Metadata> {
  const code = lotCodeFromParam((await params).lotCode);
  if (!code) return { title: 'Lot not found | Helix & Field', robots: { index: false } };
  const lookup = await loadLot(code);
  if (lookup.kind === 'unavailable') return { title: `Lot ${code} | Verify | Helix & Field`, robots: { index: false } };
  if (lookup.kind === 'not-found') return { title: 'Lot not found | Helix & Field', robots: { index: false } };
  const { record } = lookup;
  const banner = lotBanner(record);
  const title = `Lot ${record.lotCode}: ${banner.positive ? 'current COA' : 'COA revoked'} | Helix & Field`;
  const description = banner.positive
    ? `Certificate of analysis record for lot ${record.lotCode}${record.product ? ` (${record.product.name})` : ''}: version ${banner.featured.version}, a tamper-evident, publicly checkable record you can verify yourself.`
    : `The certificate of analysis for lot ${record.lotCode} has been revoked. The record stays public so you can see why.`;
  return { title, description, openGraph: { title, description, type: 'website', siteName: 'Helix & Field' } };
}

export default async function LotPage({ params }: { params: Promise<{ lotCode: string }> }) {
  const code = lotCodeFromParam((await params).lotCode);
  if (!code) notFound();
  const lookup = await loadLot(code);
  if (lookup.kind === 'not-found') notFound();
  const info = lookup.kind === 'found' ? await fetchAnchorInfo() : null;
  return <main className="mx-auto min-h-[60vh] max-w-[1100px] bg-porcelain px-5 py-10 font-sans text-midnight sm:px-8 lg:py-16">
    <PrintStyle />
    <Link href="/verify" className="no-print mb-6 inline-flex min-h-11 items-center gap-2 text-xs font-medium text-slate-700 hover:text-midnight"><ArrowLeft size={14} aria-hidden="true" />Verify another lot or file</Link>
    {lookup.kind === 'found' ? <LotRecordView record={lookup.record} info={info} /> : <RecordUnavailable />}
  </main>;
}
