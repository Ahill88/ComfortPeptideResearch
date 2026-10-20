'use client';

import Link from 'next/link';
import * as Dialog from '@radix-ui/react-dialog';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ShoppingBag, X } from 'lucide-react';
import { useState } from 'react';
import { useCart } from './cart-provider';
import { CartContents } from './cart-contents';

export function AnimatedCartDrawer() {
  const [open, setOpen] = useState(false);
  const { itemCount, isReady } = useCart();
  const reducedMotion = useReducedMotion();
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild><button type="button" className="flex h-11 items-center gap-2 rounded-full border border-slate-200 px-3 transition hover:bg-slate-100" aria-label={`Open bag, ${isReady ? itemCount : 0} items`}><ShoppingBag size={18} strokeWidth={1.6} /><span className="min-w-4 text-xs font-medium tabular-nums">{isReady ? itemCount : 0}</span></button></Dialog.Trigger>
    <AnimatePresence>{open && <Dialog.Portal forceMount><Dialog.Overlay forceMount asChild><motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reducedMotion ? 0 : 0.2 }} className="fixed inset-0 z-50 bg-[#0B1220]/50 backdrop-blur-sm" /></Dialog.Overlay><Dialog.Content forceMount asChild><motion.div initial={{ x: reducedMotion ? 0 : '100%' }} animate={{ x: 0 }} exit={{ x: reducedMotion ? 0 : '100%' }} transition={{ duration: reducedMotion ? 0 : 0.3, ease: [0.22, 1, 0.36, 1] }} className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col bg-white font-sans text-[#0B1220] shadow-2xl">
      <div className="border-b border-slate-200 px-6 py-5"><div className="flex items-center justify-between"><Dialog.Title className="text-2xl font-semibold tracking-tight">Your bag <span className="ml-2 text-sm font-normal text-slate-600">({isReady ? itemCount : 0})</span></Dialog.Title><Dialog.Close asChild><button type="button" aria-label="Close bag" className="grid h-11 w-11 place-items-center rounded-full hover:bg-slate-100"><X size={20} /></button></Dialog.Close></div><Dialog.Description className="mt-1 text-sm text-slate-600">Review your research materials.</Dialog.Description></div><div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-3"><CartContents compact onNavigate={() => setOpen(false)} /></div><div className="border-t border-slate-200 px-6 py-4 text-center"><Dialog.Close asChild><Link href="/cart" className="text-xs font-medium text-slate-600 underline underline-offset-4 hover:text-[#0B1220]">View full bag</Link></Dialog.Close></div>
    </motion.div></Dialog.Content></Dialog.Portal>}</AnimatePresence>
  </Dialog.Root>;
}
