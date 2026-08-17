// A single shared pg Pool for the process. DATABASE_URL is normalized to
// `sslmode=verify-full` before the pool is created, so Neon/Postgres TLS
// certificate verification is explicit and not dependent on pg version-specific
// `sslmode=require` behaviour. Callers get the pool lazily so simply importing
// the package doesn't open a connection.

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
