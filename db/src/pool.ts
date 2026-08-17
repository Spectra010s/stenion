// A single shared pg Pool for the process. DATABASE_URL is pinned to
// `sslmode=verify-full` on the way in (see env.ts for why, and for the loopback
// carve-out), so certificate verification is stated outright rather than left
// to whatever the installed pg version reads `sslmode=require` to mean. Every
// consumer — indexer, dashboard pages, route handlers, migrations — reaches the
// database through this function, so the pin covers all of them at once.
// Callers get the pool lazily so simply importing the package doesn't open a
// connection.

import { Pool } from 'pg';

import { requireDatabaseUrl } from './env';

let pool: Pool | undefined;

/** The process-wide connection pool, created on first use from DATABASE_URL. */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: requireDatabaseUrl() });
  }
  return pool;
}

/**
 * Close the pool so the process can exit. The pg Pool keeps the event loop
 * alive, so a one-shot task (--once run, migrate) must call this to terminate.
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
