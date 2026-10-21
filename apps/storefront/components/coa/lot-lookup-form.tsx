'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import { LOT_CODE_EXAMPLE, checkLotCode, lotPath } from '../../lib/coa/codes';
import { inputClass, primaryButtonClass } from './ui';

export function LotLookupForm({ initialCode = '' }: { initialCode?: string }) {
  const router = useRouter();
  const id = useId();
  const [value, setValue] = useState(initialCode);
  const [error, setError] = useState<string | null>(null);
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const validate = (raw: string) => { const check = checkLotCode(raw); setError(check.ok ? null : check.reason); return check; };
  return <form noValidate onSubmit={(e) => { e.preventDefault(); const check = validate(value); if (check.ok) router.push(lotPath(check.code)); }} className="space-y-3">
    <label htmlFor={id} className="block text-sm font-semibold text-midnight">Lot code</label>
    <div className="flex flex-col gap-3 sm:flex-row">
      <input
        id={id} name="lot" type="text" inputMode="text" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
        value={value} maxLength={80} placeholder={LOT_CODE_EXAMPLE}
        aria-invalid={error ? true : undefined} aria-describedby={error ? `${hintId} ${errorId}` : hintId}
        onChange={(e) => { setValue(e.target.value); if (error) validate(e.target.value); }}
        className={`${inputClass} font-mono sm:flex-1`}
      />
      <button type="submit" className={primaryButtonClass}>Look up this lot <ArrowRight size={14} aria-hidden="true" /></button>
    </div>
    <p id={hintId} className="text-xs leading-5 text-slate-600">Example format: <span className="font-mono text-midnight">{LOT_CODE_EXAMPLE}</span>. Letters, numbers, dots, hyphens and underscores; 2 to 63 characters. You will find it on your label or packing slip.</p>
    <p id={errorId} role="alert" className="text-sm font-medium text-red-800">{error}</p>
  </form>;
}
