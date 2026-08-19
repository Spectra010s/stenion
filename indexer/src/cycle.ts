// The run loop, separated from the process entry point.
//
// Everything here is a pure function of its arguments: `runCycle` takes the
// targets and the store it should write to, and reaches for no environment, no
// pg pool, and no clock beyond `new Date()`. That is what makes the error model
// testable — the indexer's whole job on failure is to record a failed run and
// keep going, and as of 2026-08-16 `risk_scores` holds 1,683 rows and not one
// failed, so this path has never executed in production. It can only be proven
// against a deliberately throwing adapter.
//
// It lives in its own module rather than in index.ts because index.ts is a CLI
// entry point: it carries a `require.main === module` guard and extensionless
// relative imports, both of which are CommonJS-only and make the module
// impossible to load from a test under Node's native type stripping.
//
// Retry and alerting are wired in here but configured OUTSIDE here: the policy,
// the budget and the notifier all arrive as arguments (see CycleOptions), so
// this module still reaches for no env and no pool. That is what lets the tests
// drive a four-cycle failure streak and a deliberately throwing adapter without
// a database, a webhook, or a real clock.

import { METHODOLOGY_VERSION } from '@stenion/core';
import type { Adapter, ProtocolMetadata, RiskFactorMap } from '@stenion/core';
import type { RunRecord, Store } from '@stenion/db';

// Explicit .ts extensions, unlike index.ts's extensionless ones. This module is
// imported by a test, so Node's type-stripping ESM loader resolves these paths
// directly and an extensionless specifier does not resolve. tsc rewrites them to
// .js on emit via `rewriteRelativeImportExtensions` — see tsconfig.build.json.
import { decideAlert, streakWindow, type Notifier, type StreakAlert } from './alerts.ts';
import { withRetry, type RetryDeps, type RetryPolicy } from './retry.ts';

/**
 * An adapter bound to its run pipeline. Wrapping each adapter this way keeps
 * its TRawData type internal (an `Adapter<BlendRawData>` is not assignable to
 * `Adapter<unknown>` because computeRiskFactors is contravariant in TRawData),
 * so a heterogeneous list of adapters can share one run loop.
 *
 * The adapter reference persisted to `protocols.adapter` rides on `metadata`
 * (as `metadata.adapterRef`) and is deliberately NOT duplicated here. It used
 * to be read off `adapter.constructor.name`, which is correct in dev and in
 * every test but mangled by minification in the bundled serverless build —
 * see ProtocolMetadata.adapterRef. One source, and it's a literal.
 */
export interface IndexTarget {
  metadata: ProtocolMetadata;
  run(): Promise<{ safetyScore: number; factors: RiskFactorMap; computedAt: Date }>;
}

export function toTarget<T>(adapter: Adapter<T>): IndexTarget {
  return {
    metadata: adapter.metadata,
    run: async () => {
      const raw = await adapter.fetchRawData();
      const factors = await adapter.computeRiskFactors(raw);
      const result = adapter.score(factors);
      return { safetyScore: result.score, factors: result.factors, computedAt: result.computedAt };
    },
  };
}

/** One protocol's outcome in a cycle summary. */
export interface CycleRunResult {
  id: string;
  status: 'ok' | 'failed';
  safetyScore?: number;
  error?: string;
  /** Attempts actually made (1 = succeeded, or failed, first time). */
  attempts?: number;
}

/** What one cycle did — returned so the cron route can respond with a summary. */
export interface CycleSummary {
  ran: number;
  ok: number;
  failed: number;
  results: CycleRunResult[];
  /** Alerts raised this cycle, whether or not the notifier delivered them. */
  alerts?: StreakAlert[];
}

/**
 * Retry, budget and alerting behaviour, injected rather than read from env so
 * this module stays a pure function of its arguments (index.ts owns config).
 *
 * Every field is optional and the defaults are the *old* behaviour: one attempt,
 * no time limit, no alerting. A caller that passes nothing gets exactly the
 * loop that ran before any of this existed, which is what keeps the base
 * error-model tests testing the error model.
 */
export interface CycleOptions {
  retry?: RetryPolicy;
  /**
   * Wall-clock budget for the whole run loop, divided between the targets. The
   * hard constraint behind it is Vercel Hobby's `maxDuration = 60`, which cannot
   * be raised: a cycle killed mid-flight can leave one protocol scored and
   * another neither scored nor recorded as failed, which is strictly worse than
   * a protocol that ran out of retries and failed cleanly.
   */
  budgetMs?: number;
  /** Consecutive failures before a `failing` alert fires. */
  alertThreshold?: number;
  notifier?: Notifier;
  /** Injectable clock/sleep, for tests. */
  deps?: RetryDeps;
}

const NO_RETRY: RetryPolicy = {
  attempts: 1,
  baseDelayMs: 0,
  attemptTimeoutMs: Number.POSITIVE_INFINITY,
};

export async function runCycle(
  targets: IndexTarget[],
  store: Store,
  options: CycleOptions = {},
): Promise<CycleSummary> {
  const retry = options.retry ?? NO_RETRY;
  const deps = options.deps ?? {};
  const now = deps.now ?? Date.now;
  const budgetEndsAt = now() + (options.budgetMs ?? Number.POSITIVE_INFINITY);

  const results: CycleRunResult[] = [];
  const alerts: StreakAlert[] = [];

  for (const [index, target] of targets.entries()) {
    const runAt = new Date().toISOString();

    // Per-protocol share of what's LEFT, not a fixed split of the whole budget.
    // One protocol failing must not cost the other its retries — but a protocol
    // that finishes early should hand its slack on rather than waste it, which
    // recomputing the remainder each iteration does for free.
    const targetsLeft = targets.length - index;
    const deadlineAt = now() + (budgetEndsAt - now()) / targetsLeft;

    // Build the run outcome first (adapter errors caught here), then persist it
    // separately so a DB write failure is logged without aborting the cycle.
    let record: RunRecord;
    let result: CycleRunResult;
    try {
      const { value, attempts } = await withRetry(() => target.run(), retry, deadlineAt, deps);
      const { safetyScore, factors, computedAt } = value;
      record = {
        protocolId: target.metadata.id,
        status: 'ok',
        safetyScore,
        factors,
        // Stamped here, not by the adapter: one rulebook applies to every
        // protocol, so the version is a property of the run, not of the adapter.
        methodologyVersion: METHODOLOGY_VERSION,
        computedAt: computedAt.toISOString(),
        runAt,
      };
      result = { id: target.metadata.id, status: 'ok', safetyScore, attempts };
      const retried = attempts > 1 ? ` (after ${attempts} attempts)` : '';
      console.log(`[${runAt}] ${target.metadata.id}: safetyScore=${safetyScore}${retried}`);
    } catch (err) {
      // Retries reduce false failures; they never hide real ones. Exhausting
      // them records exactly the failure that would have been recorded without
      // any retry at all — a protocol that is genuinely down still shows as down.
      const error = err instanceof Error ? err.message : String(err);
      record = { protocolId: target.metadata.id, status: 'failed', error, runAt };
      result = { id: target.metadata.id, status: 'failed', error, attempts: retry.attempts };
      console.error(`[${runAt}] ${target.metadata.id}: FAILED — ${error}`);
    }

    let wrote = true;
    try {
      await store.insertRunRecord(record);
    } catch (err) {
      wrote = false;
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[${runAt}] ${target.metadata.id}: DB write failed — ${error}`);
    }

    results.push(result);

    // The streak is read AFTER the write, so what an alert describes is literally
    // the rows in the table. If the write didn't land there is nothing new to
    // read and this cycle is skipped — a streak we could not record is not one
    // we should page anyone about.
    if (wrote && options.notifier && options.alertThreshold) {
      const alert = await checkStreak(store, target.metadata, options.alertThreshold);
      if (alert) alerts.push(alert);
    }
  }

  // One POST per cycle: an RPC-wide outage taking out every protocol at once
  // should read as one incident, not as a message per protocol.
  if (alerts.length > 0 && options.notifier) {
    try {
      await options.notifier(alerts);
    } catch (err) {
      // Alerting must never be able to fail a cycle. Scoring already happened
      // and is already persisted; a webhook that is down is its own problem.
      console.error(
        `[alerts] delivery failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    ran: results.length,
    ok: results.filter((r) => r.status === 'ok').length,
    failed: results.filter((r) => r.status === 'failed').length,
    results,
    ...(alerts.length > 0 ? { alerts } : {}),
  };
}

/**
 * Read this protocol's recent runs and decide whether they warrant a
 * notification. Never throws: a failure here is an alerting problem, and the
 * cycle's actual job (score, record) is already done by the time it runs.
 */
async function checkStreak(
  store: Store,
  metadata: ProtocolMetadata,
  threshold: number,
): Promise<StreakAlert | null> {
  try {
    const window = streakWindow(threshold);
    const runs = await store.listRecentRuns(metadata.id, window);
    return decideAlert(runs, {
      threshold,
      window,
      protocolId: metadata.id,
      protocolName: metadata.name,
    });
  } catch (err) {
    console.error(
      `[alerts] ${metadata.id}: could not read run history — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
