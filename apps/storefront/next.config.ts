import path from 'node:path';
import type { NextConfig } from 'next';
const nextConfig: NextConfig = {
  output: 'standalone',
  // Must be the monorepo root: in a pnpm workspace the traced node_modules are symlinks into <root>/node_modules/.pnpm,
  // so a narrower root leaves dangling links in .next/standalone. The server entry is then apps/storefront/server.js.
  outputFileTracingRoot: path.join(__dirname, '../..'),
  // Keep production validation from overwriting the running preview's artifacts.
  distDir: process.env.NODE_ENV === 'development' ? '.next-dev' : '.next',
};
export default nextConfig;
