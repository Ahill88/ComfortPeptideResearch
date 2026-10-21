'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '../auth-provider';
import { authErrorMessage } from '../../lib/auth/api';
import { loginPath } from '../../lib/auth/navigation';
import { AccessShell, buttonClass, Status } from './ui';

export function ProtectedAccount({ children }: { children: ReactNode }) {
  const { session, isReady, loading, error, refresh } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    if (isReady && !loading && !session && !error) router.replace(loginPath(pathname + window.location.search));
  }, [session, isReady, loading, error, pathname, router]);
  if (!isReady || (!session && loading)) return <AccessShell title="Your account"><Status message="Checking your session…" /></AccessShell>;
  if (!session) return <AccessShell title="Your account"><Status error={error} message="Redirecting to sign in…" />{error && <div className="flex flex-wrap gap-3"><button className={buttonClass} onClick={() => void refresh()}>Try again</button><Link className={buttonClass} href={loginPath(pathname)}>Sign in</Link></div>}</AccessShell>;
  return <>{children}</>;
}

export function AccountShell({ title, children }: { title: string; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const links = [['/account', 'Overview'], ['/account/profile', 'Profile'], ['/account/addresses', 'Addresses'], ['/account/security', 'Security'], ['/orders', 'Orders'], ['/account/wallet', 'Wallet']];
  return <main className="mx-auto min-h-[65vh] max-w-[1280px] px-5 py-12 text-midnight sm:px-8 lg:py-20">
    <p className="text-xs font-medium tracking-widest text-slate-600">CUSTOMER ACCOUNT</p>
    <h1 className="mb-7 mt-4 text-4xl tracking-tight sm:text-5xl">{title}</h1>
    <nav aria-label="Account" className="mb-8 flex flex-wrap gap-2 border-b border-silver pb-6">{links.map(([href, label]) => <Link key={href} href={href} className={`${buttonClass} ${pathname === href ? 'bg-white' : ''}`} aria-current={pathname === href ? 'page' : undefined}>{label}</Link>)}</nav>
    {children}
    <div className="mt-8"><Status error={error} message={busy ? 'Signing out…' : null} /><button type="button" disabled={busy} className={buttonClass} onClick={async () => { setBusy(true); setError(null); try { await signOut(); router.replace('/login'); } catch (cause) { setError(authErrorMessage(cause)); } finally { setBusy(false); } }}>Sign out</button></div>
  </main>;
}
