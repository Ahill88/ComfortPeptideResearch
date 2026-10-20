import type { Config } from 'tailwindcss';
export default { content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'], theme: { extend: { colors: { ink: '#102d31', fog: '#f7f8f6', line: '#dfe5e2', blue: '#296b80' }, fontFamily: { display: ['Georgia', 'serif'], sans: ['Arial', 'sans-serif'], mono: ['ui-monospace', 'monospace'] } } }, plugins: [] } satisfies Config;
