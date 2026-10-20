import path from 'node:path';
import type { NextConfig } from 'next';
// outputFileTracingRoot is the monorepo root so pnpm's workspace symlinks resolve inside any standalone output.
const nextConfig: NextConfig = { outputFileTracingRoot: path.join(__dirname, '../..') };
export default nextConfig;
