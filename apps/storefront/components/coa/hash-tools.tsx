'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FileUp, Loader2, RotateCcw, ShieldCheck } from 'lucide-react';
import { CopyButton } from './copy-button';
import { Pill, ToneIcon, buttonClass, monoBoxClass, primaryButtonClass, toneStyles } from './ui';
import { compareHashes, sha256OfBlob } from '../../lib/coa/hash';
import { fetchByHash, hashRemotePdf } from '../../lib/coa/client';
import { byHashSummary, versionStatus } from '../../lib/coa/status';
import type { Tone } from '../../lib/coa/status';
import type { ByHashResult, CoaStatus } from '../../lib/coa/model';
import { lotPath } from '../../lib/coa/codes';

/* ------------------------------ file drop zone ------------------------------ */

function FileDrop({ id, onFile, disabled, title, hint }: { id: string; onFile: (file: File) => void; disabled?: boolean; title: string; hint: string }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return <label
    htmlFor={id}
    onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true); }}
    onDragLeave={() => setOver(false)}
    onDrop={(e) => { e.preventDefault(); setOver(false); const file = e.dataTransfer.files?.[0]; if (file && !disabled) onFile(file); }}
    className={`no-print flex min-h-[7.5rem] cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-5 py-6 text-center transition focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-blue ${over ? 'border-blue bg-sky-50' : 'border-slate-400 bg-white hover:bg-porcelain'} ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
  >
    <FileUp size={22} aria-hidden="true" className="text-slate-600" />
    <span className="text-sm font-semibold text-midnight">{title}</span>
    <span className="max-w-md text-xs leading-5 text-slate-600">{hint}</span>
    <input ref={input} id={id} type="file" className="sr-only" disabled={disabled} onChange={(e) => { const file = e.target.files?.[0]; if (file) onFile(file); e.target.value = ''; }} />
  </label>;
}

const LOCAL_ONLY = 'Your file stays on your device: its SHA-256 is computed in this browser and only that 64-character fingerprint is used.';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The file could not be read.';
}

function ResultBox({ tone, headline, children }: { tone: Tone; headline: string; children: React.ReactNode }) {
  return <div className={`rounded-xl border p-4 text-sm leading-6 ${toneStyles[tone]}`}>
    <p className="flex items-center gap-2 font-semibold"><ToneIcon tone={tone} />{headline}</p>
    <div className="mt-2 space-y-2">{children}</div>
  </div>;
}

function Digest({ label, value }: { label: string; value: string }) {
  return <div><p className="text-[11px] font-medium uppercase tracking-[.12em] opacity-80">{label}</p><p className={`${monoBoxClass} mt-1 bg-white/70`}>{value}</p></div>;
}

/* --------------------------- landing: verify a file --------------------------- */

type LookupState =
  | { phase: 'idle' }
  | { phase: 'hashing'; name: string }
  | { phase: 'looking-up'; name: string; sha256: string }
  | { phase: 'result'; name: string; sha256: string; result: ByHashResult }
  | { phase: 'error'; message: string; sha256?: string };

export function FileLookup() {
  const [state, setState] = useState<LookupState>({ phase: 'idle' });
  const run = useRef(0);
  const busy = state.phase === 'hashing' || state.phase === 'looking-up';
  const onFile = useCallback(async (file: File) => {
    const id = ++run.current;
    setState({ phase: 'hashing', name: file.name });
    let sha256: string;
    try { sha256 = await sha256OfBlob(file); } catch (error) { if (id === run.current) setState({ phase: 'error', message: messageOf(error) }); return; }
    if (id !== run.current) return;
    setState({ phase: 'looking-up', name: file.name, sha256 });
    const lookup = await fetchByHash(sha256);
    if (id !== run.current) return;
    if (lookup.kind === 'unavailable') setState({ phase: 'error', sha256, message: 'The record service could not be reached, so we cannot say whether this file matches. Your file was hashed locally; try again in a moment, or compare the fingerprint below by hand.' });
    else setState({ phase: 'result', name: file.name, sha256, result: lookup.result });
  }, []);

  return <div className="space-y-4">
    <FileDrop id="coa-file-lookup" onFile={onFile} disabled={busy} title="Drop a PDF here, or choose a file" hint={`Find out whether it is a COA we published. ${LOCAL_ONLY}`} />
    <div role="status" aria-live="polite" className="space-y-3">
      {state.phase === 'hashing' ? <p className="flex items-center gap-2 text-sm text-slate-700"><Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />Computing SHA-256 of {state.name} in your browser...</p> : null}
      {state.phase === 'looking-up' ? <p className="flex items-center gap-2 text-sm text-slate-700"><Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />Checking the fingerprint against published records...</p> : null}
      {state.phase === 'error' ? <ResultBox tone="caution" headline="Could not complete the check"><p>{state.message}</p>{state.sha256 ? <Digest label="SHA-256 of your file" value={state.sha256} /> : null}</ResultBox> : null}
      {state.phase === 'result' ? <LookupResult name={state.name} sha256={state.sha256} result={state.result} /> : null}
    </div>
    {state.phase === 'result' || state.phase === 'error' ? <button type="button" className={`${buttonClass} no-print`} onClick={() => { run.current++; setState({ phase: 'idle' }); }}><RotateCcw size={14} aria-hidden="true" />Check another file</button> : null}
  </div>;
}

function LookupResult({ name, sha256, result }: { name: string; sha256: string; result: ByHashResult }) {
  const summary = byHashSummary(result);
  return <ResultBox tone={summary.tone} headline={summary.headline}>
    <p>{summary.detail}</p>
    {result.matches.length ? <ul className="space-y-2">{result.matches.map((m) => <li key={`${m.lotCode}-${m.version}`} className="flex flex-wrap items-center gap-3">
      <Pill tone={versionStatus(m.status).tone}>{versionStatus(m.status).label}</Pill>
      <span>Lot <span className="font-mono">{m.lotCode}</span>, version {m.version}</span>
      <Link className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4" href={lotPath(m.lotCode)}>Open the lot record</Link>
    </li>)}</ul> : null}
    <Digest label={`SHA-256 of ${name}`} value={sha256} />
    <CopyButton value={sha256} what="file SHA-256" label="Copy SHA-256" />
  </ResultBox>;
}

/* ------------------------- lot page: verify a specific PDF ------------------------- */

export type VerifyTarget = { lotCode: string; version: number; sha256: string; status: CoaStatus; pdfUrl: string };
export type OtherVersion = { version: number; sha256: string; status: CoaStatus };

type VerifyState =
  | { phase: 'idle' }
  | { phase: 'working'; source: 'api' | 'file'; name?: string }
  | { phase: 'done'; source: 'api' | 'file'; name?: string; computed: string; match: boolean }
  | { phase: 'error'; message: string };

const REMOTE_FAILURES = {
  network: 'The PDF could not be downloaded by this browser (the request failed or was blocked). Download it with the link above and check it with the file picker instead.',
  status: 'The service did not return the PDF for this version. Try again, or download it with the link above.',
  hash: 'The downloaded PDF could not be hashed in this browser. Use the command-line steps in "How to verify it yourself".',
} as const;

export function VerifyPdfControl({ target, others }: { target: VerifyTarget; others: OtherVersion[] }) {
  const [state, setState] = useState<VerifyState>({ phase: 'idle' });
  const run = useRef(0);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const idBase = `verify-${target.lotCode}-${target.version}`.replace(/[^A-Za-z0-9_-]/g, '_');

  const fromApi = async () => {
    const id = ++run.current;
    abort.current?.abort();
    abort.current = new AbortController();
    setState({ phase: 'working', source: 'api' });
    try {
      const result = await hashRemotePdf(target.pdfUrl, { signal: abort.current.signal });
      if (id !== run.current) return;
      if (result.kind === 'failed') setState({ phase: 'error', message: REMOTE_FAILURES[result.reason] });
      else setState({ phase: 'done', source: 'api', computed: result.sha256, match: compareHashes(result.sha256, target.sha256) === 'match' });
    } catch { /* aborted: superseded by a newer run or unmounted */ }
  };
  const fromFile = async (file: File) => {
    const id = ++run.current;
    abort.current?.abort();
    setState({ phase: 'working', source: 'file', name: file.name });
    try {
      const computed = await sha256OfBlob(file);
      if (id === run.current) setState({ phase: 'done', source: 'file', name: file.name, computed, match: compareHashes(computed, target.sha256) === 'match' });
    } catch (error) { if (id === run.current) setState({ phase: 'error', message: messageOf(error) }); }
  };

  const working = state.phase === 'working';
  return <div className="space-y-4">
    <div className="no-print flex flex-wrap items-center gap-3">
      <button type="button" className={primaryButtonClass} onClick={fromApi} disabled={working}>
        {working && state.source === 'api' ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />}Verify this PDF
      </button>
      <p className="max-w-md text-xs leading-5 text-slate-600">Downloads the PDF from the record service, computes its SHA-256 in your browser and compares it with the recorded value.</p>
    </div>
    <FileDrop id={`${idBase}-file`} onFile={fromFile} disabled={working} title="Or check a file you already have" hint={`Pick or drop a PDF to compare it with version ${target.version}. ${LOCAL_ONLY}`} />
    <div role="status" aria-live="polite">
      {state.phase === 'working' ? <p className="flex items-center gap-2 text-sm text-slate-700"><Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />{state.source === 'api' ? 'Downloading and hashing the PDF...' : `Computing SHA-256 of ${state.name ?? 'your file'}...`}</p> : null}
      {state.phase === 'error' ? <ResultBox tone="caution" headline="Could not complete the check"><p>{state.message}</p></ResultBox> : null}
      {state.phase === 'done' ? <VerifyOutcome target={target} others={others} state={state} /> : null}
    </div>
  </div>;
}

function VerifyOutcome({ target, others, state }: { target: VerifyTarget; others: OtherVersion[]; state: Extract<VerifyState, { phase: 'done' }> }) {
  const subject = state.source === 'api' ? 'The PDF served by the record service' : `Your file${state.name ? ` (${state.name})` : ''}`;
  if (!state.match) {
    const also = others.find((o) => o.version !== target.version && compareHashes(state.computed, o.sha256) === 'match');
    return <ResultBox tone="negative" headline="Does not match">
      <p>{subject} does not match the SHA-256 recorded for version {target.version} of lot {target.lotCode}. Do not rely on it as that document.</p>
      {also ? <p>It does match version {also.version} of this lot, which is {versionStatus(also.status).label.toLowerCase()}.</p> : <p>A single changed byte gives a different fingerprint, so this can be a different document or an edited or re-saved copy.</p>}
      <Digest label="Computed SHA-256" value={state.computed} />
      <Digest label="Recorded SHA-256" value={target.sha256} />
    </ResultBox>;
  }
  const status = versionStatus(target.status);
  const tone: Tone = target.status === 'published' ? 'positive' : status.tone;
  return <ResultBox tone={tone} headline={target.status === 'published' ? 'Match: identical to the recorded COA' : target.status === 'superseded' ? 'Match, but this version is superseded' : 'Match, but this version has been revoked'}>
    <p>{subject} has exactly the SHA-256 recorded for version {target.version} of lot {target.lotCode}.{target.status === 'published' ? '' : target.status === 'superseded' ? ' A newer version has replaced it.' : ' The record was revoked: do not rely on it.'}</p>
    <Digest label="Computed SHA-256" value={state.computed} />
    <p className="text-xs leading-5 opacity-90">This shows the document is the one recorded; it does not show the lab&apos;s results are true.</p>
  </ResultBox>;
}
