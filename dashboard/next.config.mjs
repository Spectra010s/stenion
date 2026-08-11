import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the file-tracing root to the monorepo root. Without this, Next infers the
  // root from lockfiles and can pick a stray one outside the repo (it warned about
  // C:\Users\USER\pnpm-lock.yaml), which would break workspace-dependency tracing
  // on Vercel. The dashboard reads the API server-side (app/lib/api.ts), so there
  // are no rewrites/proxies or image domains to configure.
  outputFileTracingRoot: repoRoot,
};

export default nextConfig;
