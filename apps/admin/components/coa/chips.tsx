// Text labels always present: status is never conveyed by colour alone.
const COA_LABEL: Record<string, string> = { none: 'No COA', draft: 'Draft', published: 'Published', superseded: 'Superseded', revoked: 'Revoked' };
const ANCHOR_LABEL: Record<string, string> = { none: 'No anchor', pending: 'Anchor pending', confirmed: 'Anchor confirmed', failed: 'Anchor failed' };

export function CoaChip({ status }: { status: string }) {
  const key = status.toLowerCase();
  return <span className={`chip chip-coa-${key}`}>{COA_LABEL[key] ?? status}</span>;
}

export function AnchorChip({ status, label }: { status: string; label?: string }) {
  const key = status.toLowerCase();
  const text = label ? `${label} anchor: ${key === 'none' ? 'none' : key}` : (ANCHOR_LABEL[key] ?? status);
  return <span className={`chip chip-anchor-${key}`} data-anchor-status={key}>{text}</span>;
}
