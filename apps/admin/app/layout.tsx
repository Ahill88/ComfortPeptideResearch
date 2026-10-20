import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Helix & Field Operations',
  description: 'Operations dashboard for Helix & Field.',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
