#!/usr/bin/env node
/* global console, fetch, process, Response, URL */
/**
 * Fire the indexer's failure-alert path at a REAL webhook, on demand.
 *
 * WHY THIS EXISTS: the alerting path only runs after four consecutive failed
 * cycles, which is ~20 minutes of a protocol genuinely being down. Waiting for
 * that to find out whether the webhook URL is right, whether Discord accepts the
 * payload, and whether the message is readable is not a plan. This drives the
 * real path deliberately and reports exactly what came back.
 *
 * WHAT IT ACTUALLY EXERCISES — it is not a hand-written payload. It seeds an
 * in-memory run history with a real failure streak, runs the REAL `runCycle`
 * against a deliberately throwing target, and lets the REAL `decideAlert`,
 * `formatAlert`, `buildWebhookPayload` and `webhookNotifier` do their jobs. The
 * only injected part is `fetch`, wrapped so this script can report the status
 * and body that `webhookNotifier` itself discards. If this succeeds, the
 * production path works — it IS the production path.
 *
 * IT NEVER TOUCHES POSTGRES. The store is in-memory, so nothing is written to
 * `risk_scores` and no real protocol's history is affected.
 *
 * The alert deliberately names a fake protocol ("stenion-smoke-test"), so a
 * message arriving in a shared channel cannot be mistaken for a real outage.
 *
 * Usage:
 *   pnpm smoke:alert-webhook                 # reads STENION_ALERT_WEBHOOK_URL from .env
 *   pnpm smoke:alert-webhook <webhook-url>   # or pass one explicitly
 *   pnpm smoke:alert-webhook -- --mode failing     # only the 🔴 alert
 *   pnpm smoke:alert-webhook -- --mode recovered   # only the 🟢 alert
 *   pnpm smoke:alert-webhook -- --dry-run          # print the payload, send nothing
 *
 * Requires the indexer to be built (`pnpm --filter @stenion/indexer build`).
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// No timeout constant here on purpose: the POST carries webhookNotifier's own
// AbortSignal (WEBHOOK_TIMEOUT_MS, 3s), so this smoke test is bounded by exactly
// the deadline production uses — which makes "is 3s enough for this webhook from
// this network?" one of the things it actually answers.

/** Obviously-fake identity: a drill must never read as a real outage. */
const SMOKE_ID = 'stenion-smoke-test';
const SMOKE_NAME = 'Stenion Alert Smoke Test';
const SMOKE_ERROR =
  'SMOKE TEST — not a real failure. Simulated: Soroban RPC unreachable (ETIMEDOUT)';
const THRESHOLD = 4;
const CADENCE_MS = 5 * 60_000;

function printUsage() {
  console.log(`Usage: pnpm smoke:alert-webhook [webhook-url] [--mode both|failing|recovered] [--dry-run]

Fires the real consecutive-failure alert path at a live webhook, without waiting
for a real four-cycle outage. Reads STENION_ALERT_WEBHOOK_URL from the repo-root
.env when no URL is given. Never writes to Postgres.

Examples:
  pnpm smoke:alert-webhook
  pnpm smoke:alert-webhook -- --mode failing
  pnpm smoke:alert-webhook https://discord.com/api/webhooks/... -- --dry-run
`);
}

/** Load the repo-root .env, without overriding real environment values. */
function loadDotEnv() {
  const envPath = resolve(REPO_ROOT, '.env');
  if (!existsSync(envPath)) return;
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

/** A webhook URL is a credential — never print it in full. */
function redact(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/[^/]+$/, '/…')}`;
  } catch {
    return '<unparseable url>';
  }
}

function describeService(url) {
  if (url.includes('discord.com') || url.includes('discordapp.com')) return 'Discord';
  if (url.includes('hooks.slack.com')) return 'Slack';
  return 'a generic JSON webhook';
}

/** N consecutive failures ending `sinceMs` ago, newest first. */
function failureStreak(n) {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => ({
    status: 'failed',
    error: SMOKE_ERROR,
    runAt: new Date(now - (i + 1) * CADENCE_MS).toISOString(),
  }));
}

/** An in-memory Store seeded with `history`. Nothing here reaches Postgres. */
function memoryStore(history) {
  return {
    async upsertProtocol() {},
    async insertRunRecord(record) {
      (history[record.protocolId] ??= []).unshift({
        status: record.status,
        error: record.status === 'failed' ? record.error : null,
        runAt: record.runAt,
      });
    },
    async listProtocolsWithLatestScore() {
      return [];
    },
    async getProtocolDetail() {
      return null;
    },
    async listRecentRuns(protocolId, limit) {
      return (history[protocolId] ?? []).slice(0, limit);
    },
  };
}

const FACTORS = {
  collateralSafety: { value: 70, weight: 0.2, detail: 'smoke test' },
  oracleSafety: { value: 100, weight: 0.25, detail: 'smoke test' },
  adminKeySafety: { value: 40, weight: 0.2, detail: 'smoke test' },
  liquiditySafety: { value: 22, weight: 0.15, detail: 'smoke test' },
  utilizationSafety: { value: 14, weight: 0.2, detail: 'smoke test' },
};

const METADATA = { id: SMOKE_ID, name: SMOKE_NAME, chain: 'stellar', adapterRef: 'SmokeAdapter' };

/** Fails, the way an adapter does when RPC is unreachable. */
const failingTarget = {
  metadata: METADATA,
  run: async () => {
    throw new Error(SMOKE_ERROR);
  },
};

/** Succeeds, to end a streak and trigger the recovery alert. */
const recoveringTarget = {
  metadata: METADATA,
  run: async () => ({ safetyScore: 61, factors: FACTORS, computedAt: new Date() }),
};

async function main() {
  // pnpm forwards a literal `--`; drop it before reading positional args.
  const args = process.argv.slice(2).filter((arg) => arg !== '--');

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const dryRun = args.includes('--dry-run');
  const modeIndex = args.indexOf('--mode');
  const mode = modeIndex === -1 ? 'both' : args[modeIndex + 1];
  if (!['both', 'failing', 'recovered'].includes(mode)) {
    console.error(`Unknown --mode "${mode}". Expected both, failing, or recovered.`);
    printUsage();
    process.exitCode = 2;
    return;
  }

  const positional = args.filter(
    (a, i) => !a.startsWith('--') && !(modeIndex !== -1 && i === modeIndex + 1),
  );

  loadDotEnv();
  const webhookUrl = (positional[0] ?? process.env.STENION_ALERT_WEBHOOK_URL ?? '').trim();

  if (!webhookUrl && !dryRun) {
    console.error(
      'No webhook URL. Set STENION_ALERT_WEBHOOK_URL in the repo-root .env, or pass one as the first argument.',
    );
    printUsage();
    process.exitCode = 2;
    return;
  }

  // The built output, not src: this deliberately exercises what actually ships.
  const require = createRequire(resolve(REPO_ROOT, 'indexer/'));
  const distDir = resolve(REPO_ROOT, 'indexer/dist');
  if (!existsSync(resolve(distDir, 'cycle.js'))) {
    console.error(
      'indexer/dist is missing or stale. Build it first:\n  pnpm --filter @stenion/indexer build',
    );
    process.exitCode = 2;
    return;
  }
  const { runCycle } = require(resolve(distDir, 'cycle.js'));
  const { webhookNotifier, buildWebhookPayload, MAX_MESSAGE_CHARS } = require(
    resolve(distDir, 'alerts.js'),
  );

  if (webhookUrl) {
    console.log(`Target : ${redact(webhookUrl)}  (looks like ${describeService(webhookUrl)})`);
  }
  console.log(`Mode   : ${mode}${dryRun ? '  [DRY RUN — nothing will be sent]' : ''}`);
  console.log(
    `Protocol: ${SMOKE_ID} (fake — no real protocol is involved, Postgres is untouched)\n`,
  );

  const plan = mode === 'both' ? ['failing', 'recovered'] : [mode];
  let failures = 0;

  for (const kind of plan) {
    // Seed the history so THIS cycle is the one that crosses the threshold.
    // `failing`  : 3 prior failures + a failing run  -> the 4th, which fires.
    // `recovered`: 6 prior failures + a scoring run  -> ends an alerted streak.
    const history =
      kind === 'failing'
        ? { [SMOKE_ID]: failureStreak(THRESHOLD - 1) }
        : { [SMOKE_ID]: failureStreak(6) };
    const target = kind === 'failing' ? failingTarget : recoveringTarget;

    let sent = null;
    let status = null;
    let responseBody = '';

    // Wrap fetch so we can see what webhookNotifier itself discards. Everything
    // else — the streak read, the decision, the formatting, the POST — is real.
    const observingFetch = async (url, init) => {
      sent = JSON.parse(init.body);
      if (dryRun) return new Response(null, { status: 204 });
      const res = await fetch(url, init);
      status = res.status;
      responseBody = await res.text().catch(() => '');
      return res;
    };

    const summary = await runCycle([target], memoryStore(history), {
      alertThreshold: THRESHOLD,
      notifier: webhookNotifier(webhookUrl || 'https://example.invalid/dry-run', observingFetch),
    });

    console.log(`--- ${kind} ---`);

    if (!summary.alerts || summary.alerts.length === 0) {
      console.error(
        `FAIL: the cycle produced no ${kind} alert. The alerting logic did not fire — ` +
          `this is a bug in the alert path, not in the webhook.`,
      );
      failures++;
      continue;
    }

    const payload = sent ?? buildWebhookPayload(summary.alerts);
    console.log(payload.content);
    console.log(
      `\n[payload] ${payload.content.length}/${MAX_MESSAGE_CHARS} chars` +
        `${payload.text === payload.content ? ', text===content OK' : ', TEXT/CONTENT MISMATCH'}` +
        `, ${payload.alerts.length} structured alert(s)`,
    );

    if (dryRun) {
      console.log('[dry run] not sent.\n');
      continue;
    }

    if (status !== null && status >= 200 && status < 300) {
      console.log(`[sent] HTTP ${status} — delivered. Check the channel.\n`);
    } else {
      failures++;
      console.error(`[sent] HTTP ${status} — REJECTED.`);
      if (responseBody) console.error(`       response: ${responseBody.slice(0, 500)}`);
      console.error(diagnose(status, payload, MAX_MESSAGE_CHARS) + '\n');
    }
  }

  if (failures > 0) {
    throw new Error(`${failures} of ${plan.length} alert(s) did not deliver.`);
  }
  if (!dryRun) {
    console.log('OK: every alert was accepted by the webhook.');
  }
}

/** Turn the common webhook rejections into something actionable. */
function diagnose(status, payload, maxChars) {
  if (status === 401 || status === 403 || status === 404) {
    return (
      '       The URL is wrong, revoked, or the webhook was deleted. Regenerate it in the\n' +
      '       channel settings and update STENION_ALERT_WEBHOOK_URL.'
    );
  }
  if (status === 400) {
    const overLimit = payload.content.length > maxChars;
    return (
      '       Discord rejects a malformed body with 400. Check the response above.\n' +
      (overLimit
        ? `       The content is ${payload.content.length} chars, over the ${maxChars} limit — that is the cause.`
        : '       Content length is within limits, so the cause is the body shape.')
    );
  }
  if (status === 429) {
    return '       Rate limited. Wait and retry — this is the webhook throttling, not a bug.';
  }
  return '       Unexpected status. The response body above is the best clue.';
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
