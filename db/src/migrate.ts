// Dead-simple forward-only migration runner. No ORM, no framework: read the
// .sql files in ../migrations in filename order, run any not yet recorded in
// schema_migrations, each inside its own transaction so a failure leaves the DB
// on the last fully-applied version. Re-runnable and idempotent.
//
// Run with:  pnpm --filter @stenion/db build && pnpm --filter @stenion/db migrate

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { closePool, getPool } from './pool';

const MIGRATIONS_DIR = resolve(__dirname, '../migrations');

async function migrate(): Promise<void> {
  const pool = getPool();

  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );

  const applied = new Set(
    (await pool.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map(
      (r) => r.version,
    ),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let ran = 0;
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;

    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      await client.query('COMMIT');
      console.log(`applied ${file}`);
      ran += 1;
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      client.release();
    }
  }

  console.log(ran === 0 ? 'up to date, nothing to apply' : `done, applied ${ran} migration(s)`);
}

migrate()
  .then(() => closePool())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    await closePool();
    process.exit(1);
  });
