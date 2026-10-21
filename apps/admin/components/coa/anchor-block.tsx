'use client';

import type { AdminAnchor, AnchorKind } from '../../lib/types';
import { CopyButton } from '../console/copy-button';
import { AnchorChip } from './chips';

/** Only an https URL is ever used as an href (the value comes from the API; never trust it into a javascript: link). */
function safeHttps(url: string | null): string | null {
  if (!url) return null;
  try { return new URL(url).protocol === 'https:' ? url : null; } catch { return null; }
}

export function AnchorBlock({
  idBase, kind, anchor, retryAllowed, retryVisible, retryReason, busy, onRetry,
}: {
  idBase: string; kind: AnchorKind; anchor: AdminAnchor | null; retryAllowed: boolean; retryVisible: boolean; retryReason: string; busy: boolean; onRetry: () => void;
}) {
  const label = kind === 'PUBLISH' ? 'Publish' : 'Revoke';
  if (!anchor) {
    return (
      <div className="anchor anchor-none" data-anchor-kind={kind.toLowerCase()}>
        <h4>{label} anchor <AnchorChip status="none" /></h4>
        <p className="hint">No {label.toLowerCase()} anchor is recorded. Anchoring may be disabled or unavailable; the COA itself is unaffected.</p>
      </div>
    );
  }
  const explorer = safeHttps(anchor.explorerUrl);
  return (
    <div className={`anchor anchor-${anchor.status.toLowerCase()}`} data-anchor-kind={kind.toLowerCase()}>
      <h4>{label} anchor <AnchorChip status={anchor.status} /></h4>
      <dl className="dl dl-tight">
        <dt>Network</dt><dd className="mono">{anchor.network}</dd>
        <dt>Attempts</dt><dd>{anchor.attempts}</dd>
        {anchor.error && (<><dt>Error</dt><dd className="anchor-error">{anchor.error}</dd></>)}
        <dt>Transaction</dt>
        <dd>
          {anchor.txSignature ? (
            <span className="sig">
              <code>{anchor.txSignature}</code>
              <CopyButton text={anchor.txSignature} label="Copy signature" />
              {explorer && <a className="btn" href={explorer} target="_blank" rel="noopener noreferrer">View on explorer (opens a new tab)</a>}
            </span>
          ) : <span className="muted">{anchor.status === 'CONFIRMED' ? 'No signature recorded.' : 'No transaction yet.'}</span>}
        </dd>
        {anchor.slot !== null && anchor.slot !== undefined && (<><dt>Slot</dt><dd className="mono">{anchor.slot}</dd></>)}
        {anchor.blockTime && (<><dt>Block time</dt><dd>{anchor.blockTime}</dd></>)}
        <dt>Memo</dt>
        <dd><span className="sig"><code>{anchor.memo}</code><CopyButton text={anchor.memo} label="Copy memo" /></span></dd>
      </dl>
      {retryVisible && (
        <div className="btn-row" style={{ marginTop: 6 }}>
          <button type="button" className="btn" disabled={!retryAllowed || busy} aria-describedby={`retry-note-${idBase}`} onClick={onRetry}>
            {busy ? 'Working...' : `Retry ${label.toLowerCase()} anchor`}
          </button>
          <span className="hint" id={`retry-note-${idBase}`} style={{ alignSelf: 'center' }}>{retryReason}</span>
        </div>
      )}
    </div>
  );
}
