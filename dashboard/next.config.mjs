import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the file-tracing root to the monorepo root. Without this, Next infers the
  // root from lockfiles and can pick a stray one outside the repo (it warned about
  // C:\Users\USER\pnpm-lock.yaml), which would break workspace-dependency tracing
  // on Vercel. The API + cron routes now live INSIDE this app (app/api/*) and read
  // @stenion/db / @stenion/indexer in-process, so their dist + node_modules must
  // trace correctly from the workspace root.
  outputFileTracingRoot: repoRoot,

  // Keep native/heavy server deps as runtime `require`s instead of bundling them
  // into the serverless function. `pg` (Postgres driver, pulled via @stenion/db)
  // and `@stellar/stellar-sdk` (Soroban/Horizon client, pulled via @stenion/adapters
  // through the cron route) both misbehave when webpack-bundled — externalizing is
  // the supported path for the Node.js runtime.
  serverExternalPackages: ['pg', '@stellar/stellar-sdk'],

  // The /methodology and /docs/api routes read their repo-root markdown file at
  // request time (single source of truth, not duplicated). Those files live
  // outside the dashboard dir, so include each explicitly in its route's
  // serverless bundle or the read 404s on Vercel — the failure is silent in dev,
  // where the file is simply there on disk.
  outputFileTracingIncludes: {
    '/methodology': ['../METHODOLOGY.md'],
    '/docs/api': ['../API.md'],
  },
};

export default nextConfig;
