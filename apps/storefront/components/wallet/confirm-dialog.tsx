'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { useState, type ReactNode } from 'react';
import { buttonClass, primaryButtonClass } from './ui';

/** Accessible confirmation dialog (Radix). When `requiredText` is set the user must type it to enable confirm. */
export function ConfirmDialog({ trigger, title, description, confirmLabel, requiredText, danger, onConfirm }: {
  trigger: ReactNode; title: string; description: ReactNode; confirmLabel: string; requiredText?: string; danger?: boolean; onConfirm: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const enabled = !busy && (!requiredText || typed.trim() === requiredText);
  return <Dialog.Root open={open} onOpenChange={(next) => { setOpen(next); if (!next) setTyped(''); }}>
    <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-midnight/60 backdrop-blur-sm" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-silver bg-white p-6 font-sans text-midnight shadow-2xl sm:p-8">
        <Dialog.Title className="text-2xl tracking-tight">{title}</Dialog.Title>
        <Dialog.Description asChild><div className="mt-4 space-y-3 text-sm leading-7 text-slate-600">{description}</div></Dialog.Description>
        {requiredText ? <div className="mt-5"><label htmlFor="confirm-dialog-input" className="mb-2 block text-xs font-semibold">Type <b className="font-mono">{requiredText}</b> to continue</label><input id="confirm-dialog-input" autoComplete="off" className="min-h-11 w-full rounded-xl border border-slate-300 px-3.5 py-3 font-mono text-sm outline-none focus:border-slate-500 focus:ring-2 focus:ring-sky-100" value={typed} onChange={(e) => setTyped(e.target.value)} /></div> : null}
        <div className="mt-7 flex flex-wrap justify-end gap-3">
          <Dialog.Close asChild><button type="button" className={buttonClass}>Cancel</button></Dialog.Close>
          <button type="button" disabled={!enabled} className={danger ? 'inline-flex min-h-11 items-center justify-center rounded-2xl border border-red-700 bg-red-700 px-5 py-3 text-xs font-semibold text-white transition hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50' : primaryButtonClass}
            onClick={async () => { setBusy(true); try { await onConfirm(); setOpen(false); setTyped(''); } finally { setBusy(false); } }}>{confirmLabel}</button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
