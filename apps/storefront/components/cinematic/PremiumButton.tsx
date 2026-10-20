import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import type { ReactNode } from 'react';

export function PremiumButton({ href, children, variant = 'dark' }: { href: string; children: ReactNode; variant?: 'dark' | 'light' | 'outline' }) {
  const styles = { dark: 'bg-midnight text-white hover:bg-graphite', light: 'bg-white text-midnight hover:bg-ice', outline: 'border-current text-inherit hover:bg-silver/10' };
  return <Link href={href} className={`premium-button ${styles[variant]}`}>{children}<ArrowUpRight size={16} aria-hidden="true" /></Link>;
}
