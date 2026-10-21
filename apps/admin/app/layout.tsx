import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Helix & Field Operations',
  description: 'Operations console for Helix & Field.',
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
