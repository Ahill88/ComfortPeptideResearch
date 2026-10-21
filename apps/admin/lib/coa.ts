// Shared (client + server) rules for lots and COA uploads. These mirror docs/api/coa-contract.md; the API stays the authority.
export const LOT_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/;
export const LOT_CODE_HINT = 'Letters, digits, dot, underscore and dash; 2 to 63 characters; must start with a letter or digit.';
export const ENTITY_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const COMMON_METHODS = ['HPLC', 'HPLC-UV', 'UPLC', 'LC-MS', 'LC-MS/MS', 'GC-MS', 'NMR', 'Amino acid analysis'] as const;
export const SHA256_HEX = /^[a-f0-9]{64}$/;

export interface CoaFields {
  labName: string; labReportId: string; testedAt: string; method: string; purityPercent: string; notes: string;
}
export type CoaFieldErrors = Partial<Record<keyof CoaFields | 'file', string>>;

/** The earlier of the operator's local date and today's UTC date: a date that is never "in the future" for the API. */
export function latestTestedAt(now = new Date()): string {
  const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const utc = now.toISOString().slice(0, 10);
  return local < utc ? local : utc;
}

export function validateCoaFields(f: CoaFields, maxDate: string): CoaFieldErrors {
  const e: CoaFieldErrors = {};
  const labName = f.labName.trim(); const labReportId = f.labReportId.trim(); const method = f.method.trim();
  if (!labName) e.labName = 'Enter the laboratory name.'; else if (labName.length > 120) e.labName = 'Laboratory name is limited to 120 characters.';
  if (!labReportId) e.labReportId = "Enter the lab's report ID."; else if (labReportId.length > 120) e.labReportId = 'Report ID is limited to 120 characters.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.testedAt) || Number.isNaN(Date.parse(`${f.testedAt}T00:00:00Z`))) e.testedAt = 'Enter the date the lab tested the sample.';
  else if (f.testedAt > maxDate) e.testedAt = 'The tested date cannot be in the future.';
  if (!method) e.method = 'Enter the test method (for example HPLC).'; else if (method.length > 120) e.method = 'Method is limited to 120 characters.';
  const purity = f.purityPercent.trim();
  if (!purity) e.purityPercent = "Enter the purity the lab reported, 0 to 100.";
  else if (!/^\d{1,3}(\.\d{1,2})?$/.test(purity) || Number(purity) > 100) e.purityPercent = 'Purity must be between 0 and 100 with at most 2 decimals.';
  if (f.notes.length > 1000) e.notes = 'Notes are limited to 1000 characters.';
  return e;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** Where the public verification page lives. Server-side env only; relative text when unset or not an http(s) URL. */
export function verifyAddress(base: string, lotCode: string): string {
  return `${base}/verify/${encodeURIComponent(lotCode)}`;
}
