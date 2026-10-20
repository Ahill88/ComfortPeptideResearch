import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';
import { Header } from '../components/header';
import { Footer } from '../components/footer';
import { CartProvider } from '../components/cart-provider';
import { AuthProvider } from '../components/auth-provider';

export const metadata: Metadata = { title: 'Helix & Field | Research Materials', description: 'Research materials, considered information, and a clearer path to laboratory inquiry.' };

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
