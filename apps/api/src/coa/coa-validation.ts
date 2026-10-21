import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

/** Uploaded file as multer (memory storage) hands it over. Declared locally: no @types/multer dependency. */
export interface UploadedPdfFile {
  fieldname?: string;
  originalname?: string;
  mimetype?: string;
  size?: number;
  buffer?: Buffer;
}

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');
export const FILE_NAME_MAX = 100;
export const DEFAULT_FILE_NAME = 'coa.pdf';
export const FIELD_MAX = 120;
export const NOTES_MAX = 1000;
export const REVOKE_REASON_MAX = 500;
/** Drafts hold up to 10 MB each; a runaway uploader must not fill the database. */
export const MAX_DRAFTS_PER_LOT = 50;

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Accepts only a real PDF: present, non-empty, <= 10 MB and starting with the `%PDF-` magic bytes. The client-declared MIME type and file
 * name are never consulted for the decision.
 */
export function assertPdf(file: UploadedPdfFile | undefined | null): Buffer {
  const bytes = file?.buffer;
  if (!file || !bytes || !Buffer.isBuffer(bytes)) throw new BadRequestException('A PDF file is required in the "file" field.');
  if (bytes.length === 0) throw new BadRequestException('The file is empty.');
  if (bytes.length > MAX_PDF_BYTES) throw new BadRequestException('The file is larger than 10 MB.');
  if (bytes.length < PDF_MAGIC.length || !bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) throw new BadRequestException('The file is not a PDF.');
  return bytes;
}

/**
 * Display name only (never a path, never used for storage lookups): basename, NFC, a conservative character set, <= 100 chars, always
 * ending in `.pdf`. Anything unusable becomes `coa.pdf`.
 */
export function sanitizeFileName(raw: unknown): string {
  let name = typeof raw === 'string' ? raw : '';
  name = name.split(/[\\/]/).pop() ?? '';
  try {
    name = name.normalize('NFC');
  } catch {
    name = '';
  }
  name = name.replace(/[^A-Za-z0-9._() -]+/g, '_').replace(/\.{2,}/g, '.').replace(/\s+/g, ' ').trim();
  name = name.replace(/\.pdf$/i, '').replace(/^[.\s_-]+/, '').replace(/[.\s]+$/, '');
  if (!name || /^[_.\s-]+$/.test(name)) return DEFAULT_FILE_NAME;
  return `${name.slice(0, FILE_NAME_MAX - 4).replace(/[.\s]+$/, '') || 'coa'}.pdf`;
}

export interface CoaFields {
  labName: string;
  labReportId: string;
  testedAt: string;
  method: string;
  /** Normalized decimal string with exactly two decimals, e.g. "98.50". */
  purityPercent: string;
  notes: string | null;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/;

export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** YYYY-MM-DD that is a real calendar date. */
export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value && Number(match[1]) >= 1900;
}

/** Validates the multipart text fields. Collects every problem into one 400. `now` is injectable for tests. */
export function parseCoaFields(raw: unknown, now: Date = new Date()): CoaFields {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const errors: string[] = [];
  const text = (key: string, max: number, required: boolean, allowNewlines = false): string | null => {
    const value = body[key];
    if (value === undefined || value === null || value === '') {
      if (required) errors.push(`${key} is required`);
      return null;
    }
    if (typeof value !== 'string') {
      errors.push(`${key} must be a single text value`);
      return null;
    }
    // multipart text values may carry CRLF line breaks (browsers/FormData normalize to them): store plain LF.
    const trimmed = (allowNewlines ? value.replace(/\r\n?/g, '\n') : value).trim();
    if (!trimmed) {
      if (required) errors.push(`${key} must not be blank`);
      return null;
    }
    if (trimmed.length > max) errors.push(`${key} must be at most ${max} characters`);
    if ((allowNewlines ? CONTROL_EXCEPT_NEWLINE : CONTROL).test(trimmed)) errors.push(`${key} contains control characters`);
    return trimmed;
  };

  const labName = text('labName', FIELD_MAX, true);
  const labReportId = text('labReportId', FIELD_MAX, true);
  const method = text('method', FIELD_MAX, true);
  const notes = text('notes', NOTES_MAX, false, true);

  let testedAt: string | null = null;
  const rawDate = body.testedAt;
  if (typeof rawDate !== 'string' || !isCalendarDate(rawDate.trim())) errors.push('testedAt must be a calendar date in YYYY-MM-DD format');
  else if (rawDate.trim() > todayUtc(now)) errors.push('testedAt must not be in the future');
  else testedAt = rawDate.trim();

  let purityPercent: string | null = null;
  const rawPurity = body.purityPercent;
  const purityMatch = typeof rawPurity === 'string' ? /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(rawPurity.trim()) : null;
  if (!purityMatch) errors.push('purityPercent must be a number from 0 to 100 with at most 2 decimals');
  else {
    const whole = Number(purityMatch[1]);
    const fraction = (purityMatch[2] ?? '').padEnd(2, '0');
    if (whole > 100 || (whole === 100 && fraction !== '00')) errors.push('purityPercent must be between 0 and 100');
    else purityPercent = `${whole}.${fraction}`;
  }

  if (errors.length || !labName || !labReportId || !method || !testedAt || !purityPercent) throw new BadRequestException(errors.length ? errors : ['Invalid COA fields']);
  return { labName, labReportId, testedAt, method, purityPercent, notes };
}

export function normalizeSha256(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value.trim()) ? value.trim().toLowerCase() : null;
}
