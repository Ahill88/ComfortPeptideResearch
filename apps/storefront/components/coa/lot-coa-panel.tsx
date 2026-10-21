'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowRight, CircleDashed, FileCheck2 } from 'lucide-react';
import { fetchProductLot } from '../../lib/coa/client';
import { lotPath } from '../../lib/coa/codes';

type PanelState = { phase: 'loading' } | { phase: 'published'; code: string } | { phase: 'none' } | { phase: 'unavailable' };

/**
 * Product-page panel. Fetches the product's current lot in the browser after the page has rendered, so it can never block the page.
 * It only says a COA exists when the API reports coaPublished === true for lots[0]; every other outcome is neutral.
 */
export function LotCoaPanel({ slug, className = '' }: { slug: string; className?: string }) {
  const [state, setState] = useState<PanelState>({ phase: 'loading' });
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8000);
    fetchProductLot(slug, { signal: controller.signal })
      .then((result) => {
        if (!active) return;
        if (result.kind === 'unavailable') setState({ phase: 'unavailable' });
        else setState(result.lot.state === 'published' ? { phase: 'published', code: result.lot.code } : { phase: 'none' });
      })
      .catch(() => { if (active) setState({ phase: 'unavailable' }); })
      .finally(() => window.clearTimeout(timer));
    return () => { active = false; controller.abort(); window.clearTimeout(timer); };
  }, [slug]);

  return <div className={`rounded-2xl border border-silver bg-white p-4 text-sm leading-6 ${className}`} aria-live="polite" data-coa-panel={state.phase}>
    {state.phase === 'published'
      ? <p className="flex items-start gap-3"><FileCheck2 size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-emerald-800" /><span><b className="font-semibold">Lot <span className="font-mono">{state.code}</span>: COA published, verify it.</b><br /><Link href={lotPath(state.code)} className="inline-flex min-h-11 items-center gap-2 text-xs font-semibold underline underline-offset-4">Open the lot record <ArrowRight size={13} aria-hidden="true" /></Link></span></p>
      : state.phase === 'loading'
        ? <p className="flex items-center gap-3 text-slate-600"><CircleDashed size={18} aria-hidden="true" className="shrink-0" />Checking the current lot&apos;s COA status...</p>
        : state.phase === 'none'
          ? <p className="flex items-start gap-3 text-slate-700"><CircleDashed size={18} aria-hidden="true" className="mt-0.5 shrink-0" /><span>No published COA for the current lot yet.</span></p>
          : <p className="flex items-start gap-3 text-slate-700"><CircleDashed size={18} aria-hidden="true" className="mt-0.5 shrink-0" /><span>The COA status could not be loaded right now. Nothing is implied either way. <Link href="/verify" className="inline-flex min-h-11 items-center underline underline-offset-4">Look up a lot code</Link></span></p>}
  </div>;
}
