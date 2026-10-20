/** Deterministic, locale-independent formatting for server rendering. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function formatUsdCents(cents: number, currency = 'USD'): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  return `${negative ? '-' : ''}${(abs / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} ${currency}`;
}

export function formatAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '-';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}

const CURSOR = /^[A-Za-z0-9_-]{1,64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type SearchParams = Record<string, string | string[] | undefined>;

export function pick(params: SearchParams, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' ? value : undefined;
}

export function cursorParam(params: SearchParams, key = 'cursor'): string | undefined {
  const value = pick(params, key);
  return value && CURSOR.test(value) ? value : undefined;
}

export function dayCursorParam(params: SearchParams): string | undefined {
  const value = pick(params, 'cursor');
  return value && DAY.test(value) ? value : undefined;
}

export function enumParam<T extends string>(params: SearchParams, key: string, allowed: readonly T[]): T | undefined {
  const value = pick(params, key);
  return allowed.find((candidate) => candidate === value);
}

export function badgeTone(status: string): 'good' | 'warn' | 'bad' | 'neutral' {
  switch (status) {
    case 'FINALIZED': case 'CONFIRMED': case 'COMPLETED': case 'ACTIVE': case 'CONSUMED':
      return 'good';
    case 'PENDING': case 'PREPARED': case 'SUBMITTED': case 'CREATED': case 'PENDING_PAYMENT':
      return 'warn';
    case 'FAILED': case 'EXPIRED':
      return 'bad';
    default:
      return 'neutral';
  }
}
