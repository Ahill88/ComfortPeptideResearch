import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';
import { Header } from '../components/header';
import { Footer } from '../components/footer';
import { CartProvider } from '../components/cart-provider';
import { AuthProvider } from '../components/auth-provider';

export const metadata: Metadata = { title: 'Helix & Field | Research Peptides & Materials', description: 'High-purity research peptides and materials with verified documentation. Lot-specific COAs, CAS-verified products, and consistent quality for laboratory research.' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
    <body>
      <AuthProvider><CartProvider>
        <div className="bg-midnight px-4 py-2.5 text-center font-mono text-[10px] tracking-wide text-silver">RESEARCH USE ONLY. NOT FOR HUMAN OR VETERINARY USE. <a className="ml-2 underline underline-offset-4" href="/quality">QUALITY DOCUMENTATION</a></div>
        <Header />{children}<Footer />
      </CartProvider></AuthProvider>
    </body>
  </html>;
}
