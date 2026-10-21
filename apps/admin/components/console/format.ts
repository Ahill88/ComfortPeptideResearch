import type { OrderStatus } from '../../lib/types';

/** CUID/UUID prefixes are shared between neighbouring orders, so the distinguishing tail is the short id. */
export function shortId(id: string): string {
  return id.slice(-8).toUpperCase();
}

export function formatMoney(cents: number, currency: string): string {
  const safe = /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : 'USD';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: safe }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${safe}`;
  }
}

/** USDC has 6 decimals. Exact BigInt maths on the atomic string; invalid input is reported, never guessed. */
export function atomicToUsdc(atomic: string): string | null {
  if (!/^\d{1,30}$/.test(atomic)) return null;
  const value = BigInt(atomic);
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, '0');
  return `${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}

export const STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING_PAYMENT: 'Awaiting payment',
  PAID: 'Paid',
  PROCESSING: 'Packing',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status as OrderStatus] ?? status;
}

export function explorerUrl(network: string, signature: string): string | null {
  // Only a cluster we can name with certainty gets a link; anything else gets none.
  if (network !== 'solana-devnet') return null;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,120}$/.test(signature)) return null;
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

const UTC = (iso: string) => new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
export function utcLabel(iso: string | null | undefined): string {
  if (!iso || Number.isNaN(new Date(iso).getTime())) return '-';
  return UTC(iso);
}

/** UTC calendar date (YYYY-MM-DD) of an ISO timestamp, or a dash. */
export function dateLabel(iso: string | null | undefined): string {
  if (!iso || Number.isNaN(new Date(iso).getTime())) return '-';
  return new Date(iso).toISOString().slice(0, 10);
}
