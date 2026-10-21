'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { deleteDraft, publishCoa, refreshLot, retryAnchor, revokeCoa, type CoaActionResult } from '../../app/actions/coa';
import { formatBytes, verifyAddress } from '../../lib/coa';
import type { AdminAnchor, AdminCoa, AdminLotDetail, AdminRole, AnchorKind } from '../../lib/types';
import { CopyButton } from '../console/copy-button';
import { dateLabel } from '../console/format';
import { LocalTime } from '../console/local-time';
import { AnchorBlock } from './anchor-block';
import { AnchorChip, CoaChip } from './chips';
import { UploadForm } from './upload-form';

const POLL_MS = 5000;
const POLL_MAX_MS = 120_000;
const STUCK_MS = 120_000;

type Panel = { coaId: string; kind: 'publish' | 'revoke' | 'revoke-confirm' | 'delete' } | null;
interface Message { kind: 'ok' | 'error'; text: string }

export function LotDetail({ initial, role, verifyBase }: { initial: AdminLotDetail; role: AdminRole; verifyBase: string }) {
  const isOwner = role === 'OWNER';
  const [data, setData] = useState(initial);
  const [panel, setPanel] = useState<Panel>(null);
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const [message, setMessage] = useState<Message | null>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState('');
  const [compared, setCompared] = useState(false);

  // Anchor polling: every 5 s for at most 2 minutes while any anchor is PENDING.
  const [pollState, setPollState] = useState<'idle' | 'polling' | 'gaveup'>('idle');
  const [pollCount, setPollCount] = useState(0);
  const [pollError, setPollError] = useState('');
  const pollStart = useRef<number | null>(null);
  const { lot, coas } = data;
  const hasPending = coas.some((c) => c.anchors.publish?.status === 'PENDING' || c.anchors.revoke?.status === 'PENDING');

  useEffect(() => { if (message) messageRef.current?.focus(); }, [message]);

  useEffect(() => {
    if (!hasPending) { pollStart.current = null; if (pollState !== 'idle') setPollState('idle'); return; }
    if (pollState === 'gaveup') return;
    if (pollStart.current === null) pollStart.current = Date.now();
    if (pollState !== 'polling') setPollState('polling');
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (Date.now() - (pollStart.current ?? Date.now()) >= POLL_MAX_MS) { setPollState('gaveup'); return; }
      const result = await refreshLot(lot.id).catch(() => null);
      if (cancelled) return;
      if (result?.ok) { setData(result.detail); setPollError(''); } else setPollError(result && !result.ok ? result.message : 'The anchor status could not be checked.');
      setPollCount((n) => n + 1);
    }, POLL_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [hasPending, pollState, pollCount, lot.id]);

  function restartPolling() {
    pollStart.current = null;
    setPollState('idle');
    setPollCount((n) => n + 1);
  }

  function apply(result: CoaActionResult) {
    if (result.detail) setData(result.detail);
    else if (result.ok && result.coa) {
      const coa = result.coa;
      setData((d) => ({ ...d, coas: d.coas.some((c) => c.id === coa.id) ? d.coas.map((c) => (c.id === coa.id ? coa : c)) : [coa, ...d.coas] }));
    }
  }

  async function run(call: () => Promise<CoaActionResult>, options: { poll?: boolean } = {}) {
    if (lock.current) return; // double-click guard: state updates are async, the ref is not
    lock.current = true;
    setPending(true);
    setMessage(null);
    try {
      const result = await call();
      apply(result);
      setMessage({ kind: result.ok ? 'ok' : 'error', text: result.message });
      if (result.ok) { setPanel(null); setReason(''); setCompared(false); if (options.poll) restartPolling(); }
      else if (result.detail) {
        // The screen was stale (for example another admin acted): close a panel whose coa no longer qualifies.
        setPanel((p) => (p && !result.detail!.coas.some((c) => c.id === p.coaId) ? null : p));
      }
    } catch {
      setMessage({ kind: 'error', text: 'The request did not complete. Reload this page to check the current state before trying again.' });
    } finally {
      lock.current = false;
      setPending(false);
    }
  }

  function openPanel(next: Panel) {
    setMessage(null); setReason(''); setReasonError(''); setCompared(false); setPanel(next);
  }

  function onUploaded(coa: AdminCoa) {
    setMessage({ kind: 'ok', text: `Uploaded as DRAFT version ${coa.version}. Review it, then publish it (owners only).` });
    setData((d) => ({ ...d, coas: [coa, ...d.coas.filter((c) => c.id !== coa.id)] }));
    void refreshLot(lot.id).then((r) => { if (r.ok) setData(r.detail); });
  }

  const publishedNow = useMemo(() => coas.find((c) => c.status === 'PUBLISHED') ?? null, [coas]);
  const verifyPath = `/verify/${encodeURIComponent(lot.code)}`;
  const verifyFull = verifyAddress(verifyBase, lot.code);
  const publicCopy = `Publishing makes this COA public at ${verifyBase ? verifyFull : verifyPath}. The on-chain anchor proves this exact file was recorded unchanged; it does not prove the lab's results.`;

  // "PENDING for a long time": this page watched it for 2 minutes, or a first attempt that was requested over 2 minutes ago.
  // A retried anchor (attempts > 1) is only judged by what this page has watched, since the request time is not in the contract.
  function stuck(coa: AdminCoa, kind: AnchorKind): boolean {
    if (pollState === 'gaveup') return true;
    const anchor = kind === 'PUBLISH' ? coa.anchors.publish : coa.anchors.revoke;
    const since = kind === 'PUBLISH' ? coa.publishedAt : coa.revokedAt;
    return anchor?.attempts === 1 && since !== null && Date.now() - new Date(since).getTime() > STUCK_MS;
  }

  return (
    <>
      <p><Link className="back" href="/lots">&larr; Back to lots</Link></p>
      <div className="page-head">
        <div>
          <div className="order-head">
            <h1>Lot <span className="lot">{lot.code}</span></h1>
            <CoaChip status={lot.coaStatus} />
            <AnchorChip status={lot.anchorStatus} />
          </div>
          <p>{lot.productName} <span className="mono">{lot.productSku}</span> &middot; current COA {lot.currentCoaVersion === null ? 'none' : `v${lot.currentCoaVersion}`} &middot; released {dateLabel(lot.releasedAt)}</p>
          {(lot.coaStatus === 'published' || lot.coaStatus === 'revoked') && (
            <p className="hint">Public page: {verifyBase ? <a className="inline-target" href={verifyFull} target="_blank" rel="noopener noreferrer">{verifyFull}</a> : <span className="mono">{verifyPath}</span>}</p>
          )}
        </div>
      </div>

      <div aria-live="polite" aria-atomic="true" role="status">
        {message && (
          <p ref={messageRef} tabIndex={-1} className={`msg ${message.kind === 'ok' ? 'msg-ok' : 'msg-error'}`}>
            <strong>{message.kind === 'ok' ? 'Done: ' : 'Not done: '}</strong>{message.text}
          </p>
        )}
      </div>
      <div aria-live="polite" aria-atomic="true" role="status" data-testid="anchor-poll">
        {hasPending && pollState !== 'gaveup' && (
          <p className="msg msg-info">An anchor is PENDING. Checking again every 5 seconds for up to 2 minutes{pollCount > 0 ? ` (checked ${pollCount} time${pollCount === 1 ? '' : 's'})` : ''}.{pollError ? ` Last check failed: ${pollError}` : ''}</p>
        )}
        {hasPending && pollState === 'gaveup' && (
          <p className="msg msg-warn">An anchor is still PENDING after 2 minutes, so this page stopped checking. The COA is unaffected. <button type="button" className="btn" onClick={restartPolling}>Check again</button> {isOwner ? 'or retry the anchor below.' : 'An owner can retry the anchor.'}</p>
        )}
      </div>

      <h2>Versions <span className="muted" style={{ fontWeight: 400 }}>(newest first)</span></h2>
      {coas.length === 0 && <p className="empty" role="status">No COA versions yet. Upload the lab&apos;s PDF below.</p>}
      {coas.map((coa) => {
        const active = panel?.coaId === coa.id ? panel.kind : null;
        const supersedes = coa.status === 'DRAFT' && publishedNow ? publishedNow : null;
        const roleNote = 'Only an owner can do this. You are signed in as STAFF.';
        return (
          <article key={coa.id} className="panel version" aria-labelledby={`v-${coa.id}`} data-version={coa.version} data-status={coa.status}>
            <h2 id={`v-${coa.id}`} className="version-head">
              Version {coa.version} <CoaChip status={coa.status} />
              {coa.status === 'PUBLISHED' && <span className="chip chip-current">Current public version</span>}
            </h2>
            <div className="version-grid">
              <div>
                <h3>Reported by the lab</h3>
                <dl className="dl dl-tight">
                  <dt>Laboratory</dt><dd>{coa.labName}</dd>
                  <dt>Report ID</dt><dd className="mono">{coa.labReportId}</dd>
                  <dt>Tested</dt><dd>{coa.testedAt}</dd>
                  <dt>Method</dt><dd>{coa.method}</dd>
                  <dt>Purity</dt><dd><strong>{coa.purityPercent}%</strong></dd>
                  {coa.notes && (<><dt>Notes</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{coa.notes}</dd></>)}
                </dl>
              </div>
              <div>
                <h3>File and history</h3>
                <dl className="dl dl-tight">
                  <dt>File</dt><dd>{coa.file.name} <span className="muted">({formatBytes(coa.file.sizeBytes)})</span></dd>
                  <dt>SHA-256</dt>
                  <dd><span className="sig"><code>{coa.file.sha256}</code><CopyButton text={coa.file.sha256} label="Copy hash" /></span></dd>
                  <dt>PDF</dt>
                  <dd><a className="btn" href={`/coas/${encodeURIComponent(coa.id)}/file`} target="_blank" rel="noopener noreferrer">Open PDF (new tab)</a></dd>
                  <dt>Uploaded</dt><dd>{coa.createdBy?.name ?? 'Unknown'} &middot; <LocalTime iso={coa.createdAt} /></dd>
                  {coa.publishedAt && (<><dt>Published</dt><dd>{coa.publishedBy?.name ?? 'Unknown'} &middot; <LocalTime iso={coa.publishedAt} /></dd></>)}
                  {coa.revokedAt && (<><dt>Revoked</dt><dd>{coa.revokedBy?.name ?? 'Unknown'} &middot; <LocalTime iso={coa.revokedAt} /></dd></>)}
                  {coa.revokeReason && (<><dt>Reason</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{coa.revokeReason}</dd></>)}
                </dl>
              </div>
            </div>

            {coa.status !== 'DRAFT' && (
              <div className="anchors">
                {(['PUBLISH', 'REVOKE'] as AnchorKind[]).map((kind) => {
                  const anchor: AdminAnchor | null = kind === 'PUBLISH' ? coa.anchors.publish : coa.anchors.revoke;
                  if (kind === 'REVOKE' && !anchor && coa.status !== 'REVOKED') return null;
                  const needs = anchor !== null && (anchor.status === 'FAILED' || (anchor.status === 'PENDING' && stuck(coa, kind)));
                  return (
                    <AnchorBlock
                      key={kind} idBase={`${coa.id}-${kind}`} kind={kind} anchor={anchor}
                      retryVisible={needs} retryAllowed={isOwner}
                      retryReason={isOwner ? (anchor?.status === 'FAILED' ? 'The anchor failed. Retrying asks the API to send it again.' : 'Pending for a long time. Retrying asks the API to send it again.') : roleNote}
                      busy={pending}
                      onRetry={() => run(() => retryAnchor(lot.id, coa.id, kind), { poll: true })}
                    />
                  );
                })}
              </div>
            )}

            <div className="version-actions">
              {coa.status === 'DRAFT' && !active && (
                <>
                  <div className="gate">
                    <button type="button" className="btn-primary" disabled={!isOwner || pending} aria-describedby={isOwner ? undefined : `gate-${coa.id}`} onClick={() => openPanel({ coaId: coa.id, kind: 'publish' })}>Review and publish</button>
                    {!isOwner && <span className="hint" id={`gate-${coa.id}`}>{roleNote} Ask an owner to publish this draft.</span>}
                  </div>
                  <button type="button" className="btn btn-danger-outline" disabled={pending} onClick={() => openPanel({ coaId: coa.id, kind: 'delete' })}>Delete draft</button>
                </>
              )}
              {(coa.status === 'PUBLISHED' || coa.status === 'SUPERSEDED') && !active && (
                <div className="gate">
                  <button type="button" className="btn btn-danger-outline" disabled={!isOwner || pending} aria-describedby={isOwner ? undefined : `gate-${coa.id}`} onClick={() => openPanel({ coaId: coa.id, kind: 'revoke' })}>Revoke version {coa.version}</button>
                  {!isOwner && <span className="hint" id={`gate-${coa.id}`}>{roleNote}</span>}
                </div>
              )}
            </div>

            {active === 'publish' && (
              <section className="confirm review" aria-labelledby={`review-${coa.id}`}>
                <h3 id={`review-${coa.id}`}>Review version {coa.version} before publishing</h3>
                <p className="msg msg-info" style={{ marginBottom: 10 }}>{publicCopy}</p>
                {supersedes && <p className="msg msg-warn" style={{ marginBottom: 10 }}>Version {supersedes.version} is public now (purity {supersedes.purityPercent}%). Publishing this version supersedes it: it stays visible as superseded.</p>}
                <div className="compare">
                  <div>
                    <h4>Values you entered</h4>
                    <dl className="dl dl-tight" aria-label="Entered values">
                      <dt>Laboratory</dt><dd><strong>{coa.labName}</strong></dd>
                      <dt>Report ID</dt><dd className="mono"><strong>{coa.labReportId}</strong></dd>
                      <dt>Tested</dt><dd><strong>{coa.testedAt}</strong></dd>
                      <dt>Method</dt><dd><strong>{coa.method}</strong></dd>
                      <dt>Purity</dt><dd><strong>{coa.purityPercent}%</strong></dd>
                      <dt>Notes</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{coa.notes ?? <span className="muted">None</span>}</dd>
                    </dl>
                  </div>
                  <div>
                    <h4>The lab&apos;s PDF</h4>
                    <p><a className="btn" href={`/coas/${encodeURIComponent(coa.id)}/file`} target="_blank" rel="noopener noreferrer">Open PDF (new tab)</a></p>
                    <dl className="dl dl-tight" aria-label="File">
                      <dt>File</dt><dd>{coa.file.name} <span className="muted">({formatBytes(coa.file.sizeBytes)})</span></dd>
                      <dt>SHA-256</dt><dd><code className="mono" style={{ overflowWrap: 'anywhere' }}>{coa.file.sha256}</code></dd>
                    </dl>
                    <p className="hint"><strong>Open the PDF and compare every value on the left with the lab&apos;s document.</strong> The anchor records the file, not the numbers: a mistyped value would be published under your name.</p>
                  </div>
                </div>
                <label className="check" htmlFor={`compared-${coa.id}`}>
                  <input id={`compared-${coa.id}`} type="checkbox" checked={compared} onChange={(e) => setCompared(e.target.checked)} />
                  <span>I compared these values with the lab&apos;s PDF</span>
                </label>
                <div className="btn-row">
                  <button type="button" className="btn-primary btn-lg" disabled={!compared || pending} onClick={() => run(() => publishCoa(lot.id, coa.id, coa.file.sha256), { poll: true })}>
                    {pending ? 'Working...' : `Confirm: publish version ${coa.version}`}
                  </button>
                  <button type="button" className="btn btn-lg" disabled={pending} onClick={() => setPanel(null)}>Cancel</button>
                </div>
                {!compared && <p className="hint" style={{ marginTop: 6 }}>Tick the box to enable publishing.</p>}
              </section>
            )}

            {active === 'delete' && (
              <section className="confirm" aria-labelledby={`del-${coa.id}`}>
                <h3 id={`del-${coa.id}`}>Delete draft version {coa.version}?</h3>
                <p className="hint">The uploaded file and entered values are removed. An owner or the person who uploaded it can do this.</p>
                <div className="btn-row">
                  <button type="button" className="btn-danger btn-lg" disabled={pending} onClick={() => run(() => deleteDraft(lot.id, coa.id))}>{pending ? 'Working...' : 'Confirm: delete draft'}</button>
                  <button type="button" className="btn btn-lg" disabled={pending} onClick={() => setPanel(null)}>Keep draft</button>
                </div>
              </section>
            )}

            {(active === 'revoke' || active === 'revoke-confirm') && (
              <section className="confirm" aria-labelledby={`rev-${coa.id}`}>
                <h3 id={`rev-${coa.id}`}>Revoke version {coa.version}</h3>
                {active === 'revoke' ? (
                  <form noValidate onSubmit={(e) => {
                    e.preventDefault();
                    const clean = reason.trim();
                    if (!clean) { setReasonError('Enter the reason for the revocation.'); return; }
                    if (clean.length > 500) { setReasonError('The reason is limited to 500 characters.'); return; }
                    setReasonError(''); setPanel({ coaId: coa.id, kind: 'revoke-confirm' });
                  }}>
                    <p className="hint">The reason is shown publicly on the verification page. The file stays downloadable and marked revoked.</p>
                    <div className="field">
                      <label htmlFor={`reason-${coa.id}`}>Reason (1 to 500 characters)</label>
                      <textarea id={`reason-${coa.id}`} value={reason} onChange={(e) => { setReason(e.target.value); setReasonError(''); }} maxLength={500} aria-invalid={Boolean(reasonError) || undefined} aria-describedby={reasonError ? `reason-err-${coa.id}` : undefined} />
                      {reasonError && <span id={`reason-err-${coa.id}`} className="field-error" role="alert">{reasonError}</span>}
                    </div>
                    <div className="btn-row">
                      <button type="submit" className="btn-danger btn-lg">Review revocation</button>
                      <button type="button" className="btn btn-lg" onClick={() => setPanel(null)}>Cancel</button>
                    </div>
                  </form>
                ) : (
                  <>
                    <p className="hint">This cannot be undone.{coa.status === 'PUBLISHED' ? ' The lot will have no current COA afterwards.' : ''} A revoke anchor will be requested.</p>
                    <dl className="dl dl-tight"><dt>Reason</dt><dd style={{ whiteSpace: 'pre-wrap' }}><strong>{reason.trim()}</strong></dd></dl>
                    <div className="btn-row">
                      <button type="button" className="btn-danger btn-lg" disabled={pending} onClick={() => run(() => revokeCoa(lot.id, coa.id, reason), { poll: true })}>{pending ? 'Working...' : `Confirm: revoke version ${coa.version}`}</button>
                      <button type="button" className="btn btn-lg" disabled={pending} onClick={() => setPanel({ coaId: coa.id, kind: 'revoke' })}>Back</button>
                    </div>
                  </>
                )}
              </section>
            )}
          </article>
        );
      })}

      <UploadForm lotId={lot.id} lotCode={lot.code} onUploaded={onUploaded} />
    </>
  );
}
