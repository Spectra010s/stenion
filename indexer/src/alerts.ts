// Consecutive-failure alerting, derived from `risk_scores` rather than from a
// persisted counter.
//
// WHY DERIVE. The indexer is invoked per-cycle by an external scheduler, so
// there is no long-running process to hold a streak in memory, and the two
// options were a counter column or a query. A counter is a second source of
// truth that can disagree with the history it describes: `insertRunRecord`
// failure is caught and logged rather than fatal, so a counter could increment
// beside a row that never landed, and the alert would then claim a streak the
// database cannot show you. Derivation cannot desynchronize from the history,
// because it IS the history. The cost is one small indexed read per protocol
// per cycle, over the (protocol_id, run_at DESC) index that already exists for
// the leaderboard's LATERAL joins.
//
// THE EMPTY-TABLE RULE, which is the whole reason this file is shaped the way
// it is. The predicate below is "count `failed` rows from the newest backwards
// until the first non-failed one". It is deliberately NOT "no ok run in the
// last N" — that formulation is equivalent on a populated table and catastrophic
// on an empty one, because a protocol with no history at all satisfies it
// immediately and pages someone at 2am about a table that was simply truncated.
// Counting backwards from the newest row yields 0 on an empty history, so an
// alert requires N rows that actually exist and actually failed. A protocol
// added later, starting from zero rows, is protected by the same arithmetic
// with no special case.
//
// Everything except `webhookNotifier` is pure.

import type { RecentRun } from '@stenion/db';

/** One thing worth telling a human about. */
export interface StreakAlert {
  kind: 'failing' | 'recovered';
  protocolId: string;
  protocolName: string;
  /**
   * For `failing`: the streak length, which equals the threshold (alerting is
   * edge-triggered — see decideAlert). For `recovered`: the length of the streak
   * that just ended.
   */
  consecutiveFailures: number;
  /**
   * False when the streak filled the whole window we read, so
   * `consecutiveFailures` is a floor rather than an exact count. Rendered as
   * "20+" rather than "20", because overstating precision in an alert is how
   * people stop trusting them.
   */
  exact: boolean;
  /** Oldest and newest failure in the streak (within the window we read). */
  firstFailureAt: string;
  lastFailureAt: string;
  /** The most recent failure message — the actionable part. */
  latestError: string;
  /**
   * Every distinct message in the streak, newest first. Four identical errors
   * and four different ones mean different things: the first is usually the
   * protocol or our decode of it, the second is usually the RPC provider.
   */
  distinctErrors: string[];
}

/** Receives a cycle's alerts. Injected into runCycle so the run loop stays env-free. */
export type Notifier = (alerts: StreakAlert[]) => Promise<void>;

/**
 * How many recent runs to read per protocol.
 *
 * Needs to exceed the threshold, or "exactly N failures" could not be
 * distinguished from "more than N" and the alert would re-fire every cycle for
 * the length of an outage. `threshold + 2` is the true minimum (the recovery
 * check looks past a leading ok row); the floor of 20 buys accurate streak
 * counts in the recovery message for outages up to ~100 minutes, and costs
 * nothing — it is still a handful of index entries.
 */
export function streakWindow(threshold: number): number {
  return Math.max(threshold + 2, 20);
}

/**
 * Count `failed` runs from the newest backwards, stopping at the first run that
 * isn't one.
 *
 * An empty array returns 0. That is the load-bearing case: it is what makes a
 * freshly-truncated `risk_scores` — or a protocol's very first cycle — incapable
 * of reading as a failure streak.
 */
export function countLeadingFailures(runs: RecentRun[]): number {
  let count = 0;
  for (const run of runs) {
    if (run.status !== 'failed') break;
    count++;
  }
  return count;
}

function buildAlert(
  kind: StreakAlert['kind'],
  protocolId: string,
  protocolName: string,
  streak: RecentRun[],
  exact: boolean,
): StreakAlert {
  const distinctErrors = [...new Set(streak.map((r) => r.error ?? 'unknown error'))];
  return {
    kind,
    protocolId,
    protocolName,
    consecutiveFailures: streak.length,
    exact,
    // `streak` is newest-first, so the oldest failure is the last element.
    firstFailureAt: streak[streak.length - 1].runAt,
    lastFailureAt: streak[0].runAt,
    latestError: streak[0].error ?? 'unknown error',
    distinctErrors,
  };
}

/**
 * Decide whether this protocol's history warrants a notification, given the
 * newest `streakWindow(threshold)` runs — INCLUDING the run just written by this
 * cycle, so the streak described is literally the rows in the table rather than
 * a prediction of them.
 *
 * Both arms are edge-triggered:
 *
 * - `failing` fires when the leading failure count is EXACTLY the threshold, so
 *   a six-hour outage sends one message rather than seventy-two.
 * - `recovered` fires when an ok run is immediately preceded by a streak that
 *   had reached the threshold — i.e. only when a `failing` alert was sent for it.
 *
 * The recovery arm is what makes the silence after a `failing` alert mean
 * something: without it, "no new messages" is ambiguous between still-broken and
 * fixed, and resolving that ambiguity by re-alerting on every cycle needs
 * dedup state that this deliberately doesn't have.
 */
export function decideAlert(
  runs: RecentRun[],
  opts: {
    threshold: number;
    protocolId: string;
    protocolName: string;
    /**
     * How many rows were ASKED for. Needed to tell "the streak ran off the end
     * of the window" (count is a floor) from "the streak ran off the end of
     * history" (count is exact) — `runs.length` alone cannot distinguish them,
     * and getting it wrong understates a long outage as an exact short one.
     */
    window?: number;
  },
): StreakAlert | null {
  const { threshold, protocolId, protocolName } = opts;
  const window = opts.window ?? streakWindow(threshold);
  if (threshold < 1 || runs.length === 0) return null;

  if (runs[0].status === 'failed') {
    const count = countLeadingFailures(runs);
    // Strict equality, not >=: this is the crossing, and every later cycle of
    // the same outage must stay quiet.
    if (count !== threshold) return null;
    return buildAlert('failing', protocolId, protocolName, runs.slice(0, count), true);
  }

  // Newest run is ok — did it end a streak that had been alerted on?
  const priorRuns = runs.slice(1);
  const count = countLeadingFailures(priorRuns);
  if (count < threshold) return null;
  // The count is exact if the streak stopped at an ok run we can see, or if we
  // read less than a full window (in which case we saw all of history). It is a
  // floor only when the failures ran to the end of a window that filled up.
  const exact = count < priorRuns.length || runs.length < window;
  return buildAlert('recovered', protocolId, protocolName, priorRuns.slice(0, count), exact);
}

/** "15 min" / "2 h 5 min" — enough precision for a human reading an alert. */
function humanDuration(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * The human-readable body of one alert.
 *
 * "Blend failed" is useless at 2am, so this carries which protocol, how many
 * consecutive cycles, how long that has been, and the underlying error verbatim.
 */
export function formatAlert(alert: StreakAlert): string {
  const count = alert.exact ? `${alert.consecutiveFailures}` : `${alert.consecutiveFailures}+`;
  const span = humanDuration(Date.parse(alert.lastFailureAt) - Date.parse(alert.firstFailureAt));
  const name = `${alert.protocolId} (${alert.protocolName})`;

  if (alert.kind === 'recovered') {
    return [
      `🟢 Stenion: ${name} recovered`,
      `Scored successfully after ${count} consecutive failed cycles (${span}).`,
      `Last error before recovery: ${alert.latestError}`,
    ].join('\n');
  }

  const errors =
    alert.distinctErrors.length === 1
      ? 'Streak errors: all identical.'
      : `Streak errors: ${alert.distinctErrors.length} distinct —\n` +
        alert.distinctErrors.map((e) => `  • ${e}`).join('\n');

  return [
    `🔴 Stenion: ${name} has failed ${count} consecutive indexer cycles`,
    `First failure: ${alert.firstFailureAt}`,
    `Latest failure: ${alert.lastFailureAt} (streak spans ${span})`,
    `Latest error: ${alert.latestError}`,
    errors,
  ].join('\n');
}

/**
 * Discord's hard cap on `content`. A longer body is rejected outright with a
 * 400 — the message does not arrive truncated, it does not arrive at all.
 *
 * This is not a theoretical limit, and it got closer when the registry went from
 * two targets to three. The case that reaches it is the worst one there is: an
 * RPC-wide outage takes out every target, they all cross the threshold on the
 * same cycle, and their alerts are batched into a single POST. The render is one
 * block per alert, so the body scales linearly with target count — two protocols
 * with four distinct Soroban `HostError` messages each measured ~2,500
 * characters, and three of the same is ~3,700.
 *
 * The sharper consequence is which cases now truncate at all. With a moderate
 * ~150-character error message, the same four-distinct-errors scenario renders
 * 1,958 characters across two targets — inside the cap — and 2,944 across three.
 * The third target is what moves an ordinary outage from "arrives whole" to
 * "arrives marked truncated". That is the cap working, not failing: without it
 * the alert for the biggest possible outage is the one Discord throws away. The
 * structured `alerts` array is never truncated, so nothing is lost for a machine
 * consumer. Slack's `text` limit is far higher (40,000), so this cap is
 * Discord's, applied to both to keep the two keys identical.
 */
export const MAX_MESSAGE_CHARS = 2000;

const TRUNCATION_MARKER = '\n… truncated — full errors are in `alerts` and in risk_scores.';

/** Keep the rendered body inside MAX_MESSAGE_CHARS, marking where it was cut. */
function fitMessage(body: string): string {
  if (body.length <= MAX_MESSAGE_CHARS) return body;
  return body.slice(0, MAX_MESSAGE_CHARS - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/**
 * The webhook body.
 *
 * `text` AND `content` carry the same string on purpose: Slack's incoming
 * webhooks read `text`, Discord's read `content`, and each ignores keys it
 * doesn't know. Sending both means one env var works with either service with
 * no adapter and no dependency. It looks like duplication — it isn't, and
 * DELETING EITHER KEY BREAKS ONE OF THE TWO SERVICES SILENTLY (the POST still
 * returns 2xx; the message just renders empty).
 *
 * The rendered body is capped (see MAX_MESSAGE_CHARS) because a message over
 * the limit is rejected, not shortened. `alerts` is the structured form and is
 * NEVER truncated — a machine consumer keeps every error in full, and nothing
 * is actually lost, since the same errors are in `risk_scores` too.
 */
export function buildWebhookPayload(alerts: StreakAlert[]): Record<string, unknown> {
  const body = fitMessage(alerts.map(formatAlert).join('\n\n'));
  return { text: body, content: body, alerts };
}

/** How long to wait on the webhook before giving up. Part of the cycle's headroom. */
export const WEBHOOK_TIMEOUT_MS = 3000;

/**
 * POST every alert for one cycle to `url` as a single request — an RPC-wide
 * outage that takes out every target should be one message, not one per target.
 *
 * Throws on a non-2xx or a network error; the caller logs and continues.
 * Alerting must never be able to fail a cycle.
 */
export function webhookNotifier(url: string, fetchImpl: typeof fetch = fetch): Notifier {
  return async (alerts) => {
    if (alerts.length === 0) return;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildWebhookPayload(alerts)),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`alert webhook returned ${res.status}`);
    }
  };
}
