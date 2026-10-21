import type { ReactNode } from 'react';
import Link from 'next/link';
import type { Authed } from '../../lib/server/session';
import { signOut } from '../../app/actions/auth';

export type NavKey = 'overview' | 'orders' | 'lots' | 'products' | 'inventory' | 'compliance' | 'email' | 'wallets' | 'team' | 'audit' | 'account';

const NAV: Array<{ key: NavKey; href: string; label: string; owner?: boolean }> = [
  { key: 'overview', href: '/', label: 'Overview' },
  { key: 'orders', href: '/orders', label: 'Orders' },
  { key: 'lots', href: '/lots', label: 'Lots & COAs' },
  { key: 'products', href: '/products', label: 'Products' },
  { key: 'inventory', href: '/inventory', label: 'Inventory' },
  { key: 'compliance', href: '/compliance', label: 'Compliance' },
  { key: 'email', href: '/email', label: 'Email outbox', owner: true },
  { key: 'wallets', href: '/wallets', label: 'Wallets' },
  { key: 'team', href: '/team', label: 'Team', owner: true },
  { key: 'audit', href: '/audit', label: 'Audit log', owner: true },
  { key: 'account', href: '/account/password', label: 'Password' },
];

export function Shell({ auth, active, children }: { auth: Authed; active: NavKey; children: ReactNode }) {
  const { admin } = auth;
  return (
    <div className="shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <aside className="sidebar">
        <Link className="brand" href="/" aria-label="Helix and Field operations, overview">
          <span className="brand-mark" aria-hidden="true">H/F</span>
          <span>Helix &amp; Field<small>Operations</small></span>
        </Link>
        <nav className="nav" aria-label="Primary">
          {NAV.filter((item) => !item.owner || admin.role === 'OWNER').map((item) => (
            <Link key={item.key} className="nav-link" href={item.href} aria-current={item.key === active ? 'page' : undefined}>
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="main-col">
        <header className="topbar">
          <p className="who">
            <span className="who-name">{admin.name}</span>
            <span className="who-meta">{admin.email} <span className="role">{admin.role}</span></span>
          </p>
          <form action={signOut}>
            <button type="submit" className="btn">Sign out</button>
          </form>
        </header>
        <main id="main" className="content" tabIndex={-1}>{children}</main>
      </div>
    </div>
  );
}
