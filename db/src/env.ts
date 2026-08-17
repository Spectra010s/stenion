// Minimal env handling for the db package. Mirrors the indexer's philosophy:
// load the nearest .env (walking up so a repo-root .env is found from any
// package cwd), never override real shell/CI env, and validate DATABASE_URL
// loudly the first time it's needed rather than failing mid-query.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

let loaded = false;

/**
 * Load KEY=VALUE pairs from the nearest .env walking up from `startDir`, without
 * overriding values already present in the environment. Idempotent and a no-op
 * if no .env exists (the vars may come from the real environment instead).
 */
export function loadEnv(startDir: string = process.cwd()): void {
  if (loaded) return;
  loaded = true;

  let dir = startDir;
  let envPath: string | null = null;
  for (;;) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) {
      envPath = candidate;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!envPath) return;

  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key !== '' && !(key in process.env)) process.env[key] = value;
  }
}

/**
 * Return DATABASE_URL, loading .env first. Throws a clear, actionable error if
 * it's missing or is not a postgres(ql):// URL — the one connection string
 * everything here depends on, so a bad value should fail obviously.
 */
export function requireDatabaseUrl(): string {
  loadEnv();
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) {
    throw new Error(
      'DATABASE_URL is required but missing. Copy db/.env.example to .env (or the ' +
        'repo root .env) and paste your Neon pooled connection string.',
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`DATABASE_URL must be a valid URL, got "${raw}"`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`DATABASE_URL must be a postgres:// URL, got protocol "${url.protocol}"`);
  }
  return requireVerifyFullSslMode(raw);
}

/**
 * Pin sslmode=verify-full explicitly for Neon/Postgres connections.
 *
 * pg currently treats sslmode=require as certificate-verifying, but pg v9 is
 * expected to weaken that behaviour. Keeping verify-full in the connection
 * string makes the required TLS verification explicit and prevents a dependency
 * bump from silently downgrading database transport security.
 *
 * See: https://github.com/stenion-lab/stenion/issues/4
 */
export function requireVerifyFullSslMode(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('sslmode', 'verify-full');
  return url.toString();
}
