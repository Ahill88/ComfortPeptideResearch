'use client';

import { useEffect, useState } from 'react';

function utc(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

/** Server renders UTC (deterministic); the browser swaps in the operator's local time after hydration. */
export function LocalTime({ iso, withSeconds = false }: { iso: string | null | undefined; withSeconds?: boolean }) {
  const valid = iso && !Number.isNaN(new Date(iso).getTime());
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!valid) return;
    setText(
      new Date(iso).toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}),
      }),
    );
  }, [iso, valid, withSeconds]);
  if (!valid) return <span>-</span>;
  return <time dateTime={iso} title={utc(iso)}>{text ?? utc(iso)}</time>;
}
