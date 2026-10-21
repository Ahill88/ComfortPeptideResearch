import type { OrderStatus } from '../../lib/types';
import { statusLabel } from './format';

/** Text label always present: status is never conveyed by colour alone. */
export function StatusChip({ status }: { status: OrderStatus | string }) {
  return <span className={`chip chip-${String(status).toLowerCase().replace(/_/g, '-')}`}>{statusLabel(status)}</span>;
}
