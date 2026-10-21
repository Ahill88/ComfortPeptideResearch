'use client';

import { useMemo, useRef, useState } from 'react';
import { COMMON_METHODS, MAX_PDF_BYTES, formatBytes, latestTestedAt, validateCoaFields, type CoaFieldErrors, type CoaFields } from '../../lib/coa';
import type { AdminCoa } from '../../lib/types';

const EMPTY: CoaFields = { labName: '', labReportId: '', testedAt: '', method: '', purityPercent: '', notes: '' };

/** Client-side file checks. The server and API repeat them; these just fail fast with a clear reason. */
async function checkPdf(file: File): Promise<string | null> {
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return 'That is not a PDF file. Choose the lab\'s PDF.';
  if (file.size === 0) return 'That file is empty.';
  if (file.size > MAX_PDF_BYTES) return `That file is ${formatBytes(file.size)}. The limit is 10 MB.`;
  const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  if (String.fromCharCode(...head) !== '%PDF-') return 'That file is not a real PDF: it does not start with %PDF-. Renaming a file to .pdf does not make it one.';
  return null;
}

type UploadResult = { ok: true; coa: AdminCoa } | { ok: false; message: string; redirect?: string };

export function UploadForm({ lotId, lotCode, onUploaded }: { lotId: string; lotCode: string; onUploaded: (coa: AdminCoa) => void }) {
  const [fields, setFields] = useState<CoaFields>(EMPTY);
  const [errors, setErrors] = useState<CoaFieldErrors>({});
  const [formError, setFormError] = useState('');
  const [picked, setPicked] = useState<{ name: string; size: number } | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const file = useRef<File | null>(null);
  const lock = useRef(false);
  const maxDate = useMemo(() => latestTestedAt(), []);

  const set = (key: keyof CoaFields) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setFields((f) => ({ ...f, [key]: e.target.value }));
    setErrors((v) => ({ ...v, [key]: undefined }));
  };

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const chosen = e.target.files?.[0] ?? null;
    setFormError('');
    file.current = null;
    setPicked(null);
    if (!chosen) { setErrors((v) => ({ ...v, file: undefined })); return; }
    const problem = await checkPdf(chosen);
    if (problem) {
      setErrors((v) => ({ ...v, file: problem }));
      if (fileInput.current) fileInput.current.value = ''; // never keep a rejected file selected
      return;
    }
    file.current = chosen;
    setPicked({ name: chosen.name, size: chosen.size });
    setErrors((v) => ({ ...v, file: undefined }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (lock.current) return; // double-click guard
    setFormError('');
    const next = validateCoaFields(fields, maxDate);
    if (!file.current) next.file = next.file ?? 'Choose the lab\'s PDF file.';
    setErrors(next);
    if (Object.keys(next).length) return;
    lock.current = true;
    setUploading(true);
    try {
      const body = new FormData();
      body.set('file', file.current!, file.current!.name);
      for (const [key, value] of Object.entries(fields)) body.set(key, value.trim());
      const response = await fetch(`/lots/${encodeURIComponent(lotId)}/upload`, { method: 'POST', body, credentials: 'same-origin' });
      let result: UploadResult;
      try { result = (await response.json()) as UploadResult; } catch { result = { ok: false, message: 'The upload did not complete. Reload the page to see whether it was saved.' }; }
      if (result.ok) {
        setFields(EMPTY); setErrors({}); setPicked(null); file.current = null;
        if (fileInput.current) fileInput.current.value = '';
        onUploaded(result.coa);
      } else if (result.redirect) {
        window.location.assign(result.redirect);
      } else {
        setFormError(result.message);
      }
    } catch {
      setFormError('The upload did not complete. Reload the page to see whether it was saved.');
    } finally {
      lock.current = false;
      setUploading(false);
    }
  }

  const err = (key: keyof CoaFieldErrors) => errors[key];
  const aria = (key: keyof CoaFieldErrors) => ({ 'aria-invalid': Boolean(errors[key]) || undefined, 'aria-describedby': errors[key] ? `up-${key}-err` : undefined });
  const msg = (key: keyof CoaFieldErrors) => errors[key] && <span id={`up-${key}-err`} className="field-error" role="alert">{errors[key]}</span>;

  return (
    <form className="panel" onSubmit={submit} noValidate aria-labelledby="upload-h">
      <h2 id="upload-h">Upload a new version</h2>
      <p className="hint" style={{ marginBottom: 12 }}>
        Upload the PDF exactly as the outside lab issued it, and enter the values the lab reported. It is saved as a DRAFT for lot {lotCode}; nothing is public until an owner publishes it.
      </p>
      <div className="field">
        <label htmlFor="up-file">Lab PDF (PDF only, up to 10 MB)</label>
        <input ref={fileInput} id="up-file" type="file" accept="application/pdf,.pdf" onChange={onFile} {...aria('file')} />
        {picked && <span className="hint" role="status">Selected: {picked.name} ({formatBytes(picked.size)}). It starts with %PDF-.</span>}
        {msg('file')}
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="up-labName">Laboratory name</label>
          <input id="up-labName" type="text" value={fields.labName} onChange={set('labName')} maxLength={120} autoComplete="off" {...aria('labName')} />
          {msg('labName')}
        </div>
        <div className="field">
          <label htmlFor="up-labReportId">Lab report ID</label>
          <input id="up-labReportId" type="text" value={fields.labReportId} onChange={set('labReportId')} maxLength={120} autoComplete="off" spellCheck={false} {...aria('labReportId')} />
          {msg('labReportId')}
        </div>
        <div className="field">
          <label htmlFor="up-testedAt">Tested on</label>
          <input id="up-testedAt" type="date" value={fields.testedAt} max={maxDate} onChange={set('testedAt')} {...aria('testedAt')} />
          {msg('testedAt')}
        </div>
        <div className="field">
          <label htmlFor="up-method">Method</label>
          <input id="up-method" type="text" list="up-methods" value={fields.method} onChange={set('method')} maxLength={120} autoComplete="off" {...aria('method')} />
          <datalist id="up-methods">{COMMON_METHODS.map((m) => <option key={m} value={m} />)}</datalist>
          {msg('method')}
        </div>
        <div className="field">
          <label htmlFor="up-purityPercent">Purity reported by the lab (%)</label>
          <input id="up-purityPercent" type="text" inputMode="decimal" value={fields.purityPercent} onChange={set('purityPercent')} maxLength={6} autoComplete="off" {...aria('purityPercent')} aria-describedby={errors.purityPercent ? 'up-purityPercent-err' : 'up-purity-hint'} />
          {errors.purityPercent ? msg('purityPercent') : <span id="up-purity-hint" className="hint">0 to 100, up to 2 decimals, for example 99.42.</span>}
        </div>
      </div>
      <div className="field">
        <label htmlFor="up-notes">Notes <span className="muted" style={{ fontWeight: 400 }}>(optional, up to 1000 characters)</span></label>
        <textarea id="up-notes" value={fields.notes} onChange={set('notes')} maxLength={1000} {...aria('notes')} />
        {msg('notes')}
      </div>
      <div aria-live="polite" role="status">
        {formError && <p className="msg msg-error"><strong>Not uploaded: </strong>{formError}</p>}
      </div>
      <button type="submit" className="btn-primary btn-lg" disabled={uploading}>{uploading ? 'Uploading...' : 'Upload as draft'}</button>
    </form>
  );
}
