'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { buttonClass } from './ui';

/** Copies plain text. The label states what is copied, and the result is announced politely. */
export function CopyButton({ value, label = 'Copy', what }: { value: string; label?: string; what: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setState('copied'); } catch { setState('failed'); }
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 2500);
  };
  return <button type="button" className={`${buttonClass} no-print`} onClick={copy} aria-label={`${label} ${what}`}>
    {state === 'copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    <span aria-live="polite">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed: select the text' : label}</span>
  </button>;
}
