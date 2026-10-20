import type { Config } from 'tailwindcss';
export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        midnight: '#0B1220', graphite: '#111827', porcelain: '#F8FAFC',
        silver: '#E2E8F0', ice: '#7DD3FC',
        ink: '#0B1220', fog: '#F8FAFC', line: '#E2E8F0', blue: '#0369A1',
      },
      fontFamily: {
        display: ['var(--font-geist-sans)', 'sans-serif'],
        sans: ['var(--font-geist-sans)', 'sans-serif'],
        mono: ['var(--font-geist-mono)', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;
