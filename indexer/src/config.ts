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
  /** Total attempts per protocol per cycle, including the first. 1 disables retry. */
  retryAttempts: number;
  /** Delay before the 2nd attempt, doubling for each one after. */
  retryBaseDelayMs: number;
  /** Soft cap on a single attempt — see RetryPolicy.attemptTimeoutMs. */
  attemptTimeoutMs: number;
  /**
   * Wall-clock budget for one cycle's run loop, split between protocols.
   *
   * The ceiling is Vercel Hobby's `maxDuration = 60`, which cannot be raised, so
   * this must leave room for cold start, pool connect, the protocol upserts, the
   * streak queries and the alert POST on top. Conservative by choice: a cycle
   * killed mid-flight can leave one protocol scored and another neither scored
   * nor recorded as failed, which is worse than a retry that never happened.
   */
  cycleBudgetMs: number;
  /** Consecutive failed cycles before a protocol raises an alert. */
  alertThreshold: number;
  /** Webhook alerts are POSTed to, or null when alerting is disabled. */
  alertWebhookUrl: string | null;
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

/**
 * An http(s) URL if set, null if not. Unlike requiredUrl, absence is a valid
 * answer — an unset alert webhook means "alerting is off", which is the default
 * and must not stop the indexer. A malformed one is still a problem, though:
 * silently not alerting because of a typo is the failure this whole change
 * exists to prevent.
 */
function optionalUrl(name: string): string | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push(`${name} must be a valid URL, got "${raw}"`);
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    problems.push(`${name} must be an http(s) URL, got "${raw}"`);
  }
  return raw;
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
    runOnce: process.argv.includes('--once') || optionalBool('STENION_RUN_ONCE', false),
    retryAttempts: optionalPositiveInt('STENION_RETRY_ATTEMPTS', 3),
    retryBaseDelayMs: optionalPositiveInt('STENION_RETRY_BASE_DELAY_MS', 1000),
    attemptTimeoutMs: optionalPositiveInt('STENION_ATTEMPT_TIMEOUT_MS', 15_000),
    // 42s, not the 48s the arithmetic alone allows: there are no observed cycle
    // durations from the deployed function yet, so this errs toward the ceiling
    // being safe. Raise it once the Vercel logs show real headroom.
    cycleBudgetMs: optionalPositiveInt('STENION_CYCLE_BUDGET_MS', 42_000),
    // 4 cycles ≈ 20 minutes at the 5-minute cadence. One blip must not page
    // anyone, and a score 20 minutes stale is not an emergency — false pages are
    // how people learn to ignore alerts.
    alertThreshold: optionalPositiveInt('STENION_ALERT_THRESHOLD', 4),
    alertWebhookUrl: optionalUrl('STENION_ALERT_WEBHOOK_URL'),
  };

  if (problems.length > 0) throw new ConfigError([...problems]);
  return config;
}
