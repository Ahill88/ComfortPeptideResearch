'use client';

import Link from 'next/link';
import * as Dialog from '@radix-ui/react-dialog';
import { Menu, X, ArrowUpRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAuth } from './auth-provider';
import { AnimatedCartDrawer } from './animated-cart-drawer';

const links = [{ href: '/catalog', label: 'Catalog' }, { href: '/research', label: 'Research' }, { href: '/quality', label: 'Quality' }, { href: '/about', label: 'About' }];

export function Header() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const { session } = useAuth();
  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 24);
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);
  return <header className="sticky top-0 z-40 h-[76px] border-b border-slate-200/80 bg-white/95 font-sans text-[#0B1220] backdrop-blur-xl">
    <div className={`mx-auto flex h-full max-w-[1440px] items-center justify-between gap-4 px-5 transition-[padding] duration-300 motion-reduce:transition-none lg:px-8 ${scrolled ? 'py-3' : 'py-1'}`}>
      <Link href="/" className="flex items-center gap-3 rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4" aria-label="Helix and Field home"><span className={`grid place-items-center rounded-full border border-slate-300 text-sm font-semibold transition-all motion-reduce:transition-none ${scrolled ? 'h-8 w-8' : 'h-10 w-10'}`}>H</span><span className="text-lg font-semibold tracking-tight sm:text-xl">Helix &amp; Field</span></Link>
      <nav aria-label="Main navigation" className="hidden items-center gap-7 text-sm font-medium md:flex">{links.map(link => <Link key={link.href} href={link.href} className="rounded-sm text-slate-600 transition hover:text-[#0B1220] focus-visible:outline focus-visible:outline-offset-4">{link.label}</Link>)}</nav>
      <div className="flex items-center gap-2 sm:gap-4"><Link href={session ? '/account' : '/access'} className="hidden rounded-full px-3 py-2 text-sm font-medium transition hover:bg-slate-100 sm:block">{session ? 'Account' : 'Access'}</Link>{session ? <Link href="/account/wallet" className="hidden rounded-full px-3 py-2 text-sm font-medium transition hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 lg:block">Research Wallet</Link> : null}<AnimatedCartDrawer />
        <Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Trigger asChild><button type="button" className="grid h-11 w-11 place-items-center rounded-full hover:bg-slate-100 md:hidden" aria-label="Open navigation"><Menu size={21} /></button></Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-[#0B1220]/50 backdrop-blur-sm" /><Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-sm flex-col overflow-y-auto bg-white p-6 font-sans text-[#0B1220] shadow-2xl"><div className="flex items-center justify-between"><Dialog.Title className="text-lg font-semibold">Explore Helix &amp; Field</Dialog.Title><Dialog.Close asChild><button type="button" aria-label="Close navigation" className="grid h-11 w-11 place-items-center rounded-full hover:bg-slate-100"><X size={21} /></button></Dialog.Close></div><Dialog.Description className="mt-2 text-sm text-slate-500">Materials, research, and your account.</Dialog.Description><nav aria-label="Mobile navigation" className="mt-8">{[...links, { href: session ? '/account' : '/access', label: session ? 'Account' : 'Access' }, ...(session ? [{ href: '/account/wallet', label: 'Research Wallet' }] : [])].map(link => <Dialog.Close asChild key={link.href}><Link href={link.href} className="flex items-center justify-between border-b border-slate-200 py-5 text-xl font-medium">{link.label}<ArrowUpRight size={18} /></Link></Dialog.Close>)}</nav><p className="mt-auto pt-8 text-xs leading-5 text-slate-500">For laboratory research only. Not for human or veterinary use.</p></Dialog.Content></Dialog.Portal></Dialog.Root>
      </div>
    </div>
  </header>;
}
