// Indexer configuration: load .env, validate everything up front, and fail
// loudly with a full list of what's wrong before the run loop starts. No
// silent fallbacks for the values that decide *what* and *where* we index —
// a wrong endpoint should surface at startup, not as confusing runtime output.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface IndexerConfig {
  /** Soroban RPC endpoint adapters read pool/reserve/oracle state from. */
  rpcUrl: string;
  /** Horizon endpoint used for admin-account signer/activity data. */
  horizonUrl: string;
  /** Scoring-cycle interval in milliseconds. */
  intervalMs: number;
  /** Postgres connection string each run outcome is written to. */
  databaseUrl: string;
  /** Run a single cycle then exit instead of looping. */
  runOnce: boolean;
}

/** Thrown when env validation fails; carries every problem so all are shown at once. */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid indexer configuration (${problems.length} problem(s))`);
    this.name = 'ConfigError';
  }
}

/**
 * Load KEY=VALUE pairs from the nearest .env walking up from `startDir`, without
 * overriding values already present in the environment (shell/CI wins over .env).
 * A missing .env is fine — the vars may come from the real environment instead.
 */
function loadDotEnv(startDir: string): void {
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

const problems: string[] = [];

function requiredUrl(name: string): string {
  const raw = process.env[name]?.trim();
  if (!raw) {
    problems.push(`${name} is required but is missing or empty`);
    return '';
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push(`${name} must be a valid URL, got "${raw}"`);
    return raw;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    problems.push(`${name} must be an http(s) URL, got "${raw}"`);
  }
  return raw;
}

function requiredPostgresUrl(name: string): string {
  const raw = process.env[name]?.trim();
  if (!raw) {
    problems.push(`${name} is required but is missing or empty`);
    return '';
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push(`${name} must be a valid URL, got "${raw}"`);
    return raw;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    problems.push(`${name} must be a postgres:// URL, got "${raw}"`);
  }
  return raw;
}

function optionalPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    problems.push(`${name} must be a positive integer, got "${raw}"`);
    return fallback;
  }
  return n;
}

function optionalBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes'].includes(raw)) return true;
  if (['0', 'false', 'no'].includes(raw)) return false;
  problems.push(`${name} must be a boolean (true/false/1/0), got "${process.env[name]}"`);
  return fallback;
}

/**
 * Load and validate configuration. Throws ConfigError listing every problem if
 * anything is invalid — call once at startup so misconfiguration is caught before
 * the first run rather than mid-cycle.
 */
export function loadConfig(cwd: string = process.cwd()): IndexerConfig {
  loadDotEnv(cwd);
  problems.length = 0;

  const config: IndexerConfig = {
    rpcUrl: requiredUrl('STENION_RPC_URL'),
    horizonUrl: requiredUrl('STENION_HORIZON_URL'),
    intervalMs: optionalPositiveInt('STENION_INTERVAL_MS', 5 * 60 * 1000),
    databaseUrl: requiredPostgresUrl('DATABASE_URL'),
    runOnce:
      process.argv.includes('--once') || optionalBool('STENION_RUN_ONCE', false),
  };

  if (problems.length > 0) throw new ConfigError([...problems]);
  return config;
}
