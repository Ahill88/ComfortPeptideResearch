import type { Metadata } from 'next';
import './globals.css';
import { Header } from '../components/header';
import { Footer } from '../components/footer';

export const metadata: Metadata = { title: 'Helix & Field | Research Materials', description: 'Characterized materials for qualified laboratory research.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body><div className="bg-ink px-4 py-2 text-center font-mono text-[10px] tracking-wide text-slate-100">RESEARCH USE ONLY. NOT FOR HUMAN OR VETERINARY USE. <a className="ml-2 underline" href="/quality">VIEW QUALITY STANDARDS</a></div><Header />{children}<Footer /></body></html>; }
