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
  return pinVerifyFullSslMode(raw);
}

/**
 * Hosts where the connection never leaves the machine. No local development
 * Postgres serves a verifiable certificate — the `postgres:16-alpine` container
 * in CONTRIBUTING.md speaks no TLS at all — so pinning `verify-full` here would
 * break `pnpm --filter @stenion/db migrate` locally and buy nothing. Loopback
 * only, deliberately: a remote host gets no escape from verification, so this
 * carve-out can never become a production downgrade path.
 *
 * Compared case-insensitively because `postgresql:` is not a "special" URL
 * scheme, so WHATWG URL parsing leaves the host's case alone (`@LOCALHOST/`
 * stays `LOCALHOST`) instead of lowercasing it the way it would for http.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Pin `sslmode=verify-full` onto a Postgres connection string.
 *
 * **Why pinned at all.** `pg` currently treats `sslmode=require` as *verifying*
 * the server's certificate, which is not what libpq means by `require`.
 * `pg-connection-string` v3 / `pg` v9 adopt the libpq semantics, where
 * `require` encrypts the transport but authenticates nobody — so an unchanged
 * connection string would silently stop verifying that we are talking to Neon
 * the day that major version lands. `verify-full` means the same strong thing
 * under both readings, which is the entire point: it takes our transport
 * security out of the hands of a dependency's interpretation. We are on
 * `pg@^8`, so this is preparation rather than a live hole — the caret cannot
 * reach v9 on its own. That is not a reason to simplify this away; it is the
 * reason it has to be here *before* someone bumps the major.
 *
 * **Why it overrides instead of filling a gap.** Neon hands out connection
 * strings that already carry `sslmode=require`, so a "set it only if absent"
 * version would never fire on the one deployment that actually matters.
 * Whatever `DATABASE_URL` says about `sslmode` loses, on purpose — including a
 * weaker explicit value, which is exactly the case worth overriding.
 *
 * The sole exception is loopback; see {@link LOOPBACK_HOSTS}.
 *
 * See: https://github.com/stenion-lab/stenion/issues/4
 */
export function pinVerifyFullSslMode(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  if (LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return databaseUrl;
  url.searchParams.set('sslmode', 'verify-full');
  return url.toString();
}
