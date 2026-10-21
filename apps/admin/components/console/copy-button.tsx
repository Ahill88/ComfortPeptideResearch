'use client';

import { useRef, useState } from 'react';

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts / denied permission.
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

export function CopyButton({ text, label, className = 'btn' }: { text: string; label: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  async function onClick() {
    const ok = await copy(text);
    setState(ok ? 'copied' : 'failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2500);
  }
  return (
    <>
      <button type="button" className={className} onClick={onClick}>
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {state === 'copied' ? `${label}: copied to clipboard` : state === 'failed' ? 'Copy failed. Select the text and copy it manually.' : ''}
      </span>
    </>
  );
}
