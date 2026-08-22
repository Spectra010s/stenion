// Health POLICY for the public API: what "stale" means, what the three overall
// states mean, and which HTTP status each one is served with.
//
// Like ./_http, ./_cache and ./_rate-limit this is a LEAF — it imports nothing at
// all — so it is loadable from a plain Node test under native type stripping. The
// database half is @stenion/db's `listRunHealth()`; the wiring is the route.
//
// It deliberately does not import `RunHealthEntry` from @stenion/db, even as a
// type: the input below is declared structurally so this module has no import
// graph whatsoever. `RunFreshness` and `RunHealthEntry` are the same shape, and
// the route passing one where the other is expected is what typechecks that.
//
// ---------------------------------------------------------------------------
// WHY THIS ENDPOINT EXISTS
//
// Scoring silently stopping is one of the worst failure modes Stenion has. The
// site keeps serving last-known scores, every page renders, nothing 500s, and
// the numbers quietly age. There is no red anywhere — the only symptoms are a
// timestamp in the UI that a human has to notice and compare against a clock,
// and a database nobody is watching. This gives that failure a machine-readable
// signal and a non-200, so an uptime monitor can catch it without a human in the
// loop and without parsing a body.
//
// ---------------------------------------------------------------------------
// STALENESS IS MEASURED FROM THE LAST *SUCCESSFUL* RUN, NOT THE LAST RUN
//
// A failed run produced no score. Measuring freshness from `lastRunAt` would let
// an adapter that fails reliably every five minutes report as perfectly fresh
// forever, which is precisely inverted: a protocol failing like clockwork is the
// case this endpoint is for. So `staleMinutes` is the age of the newest `ok` run
// and nothing else.
//
// `lastRunAt`/`lastRunStatus` are still published per protocol, because together
// with the above they say WHERE the problem is:
//
//   fresh lastRunAt + stale lastSuccessfulRunAt → the cron is arriving, this
//     protocol's adapter is failing. One adapter, isolated. Go read its error.
//   both stale                                  → the cron is not arriving at
//     all. Infrastructure. Go look at cron-job.org.
//
// ---------------------------------------------------------------------------
// WHY A FRESH FAILURE ALONE IS NOT UNHEALTHY
//
// A protocol whose newest run failed but whose newest *success* is four minutes
// old is reported `healthy`, and that is deliberate rather than an oversight.
//
// The indexer already retries (STENION_RETRY_ATTEMPTS, default 3) before it will
// record a failure at all, so a `failed` row is three exhausted attempts — but it
// is still one cycle, and the data it protects is four minutes old. Turning the
// endpoint red there means paging someone about a blip while the served numbers
// are entirely current. Repeated failure is not missed by this: an adapter that
// keeps failing stops producing successful runs, and crosses the threshold below
// on its own within THRESHOLD minutes. Sustained failure and staleness are the
// same event seen at different times, so staleness alone is enough to catch it —
// with the transient case filtered out for free.
//
// A consumer who genuinely wants to know about any single failed cycle reads
// `lastRunStatus` in the body, which is why it is published.
// ---------------------------------------------------------------------------

/**
 * How old a protocol's newest successful run may be before it stops counting as
 * current, in minutes. Overridable with `STENION_HEALTH_STALE_MINUTES`.
 *
 * 30 minutes = SIX missed cycles at the indexer's 5-minute cadence.
 *
 * Sized against what already exists rather than picked round. The indexer's
 * failure-alert threshold is 4 consecutive cycles (`STENION_ALERT_THRESHOLD`,
 * ~20 minutes), and its stated reasoning is that "a score 20 minutes stale is
 * not an emergency — false pages are how people learn to ignore alerts". This
 * endpoint is consumed by an uptime monitor, so its non-200 is a *louder* signal
 * than that webhook, and it must therefore sit at a *higher* bar. 30 > 20 gives
 * the intended escalation order: the webhook mentions it first, and only if the
 * problem is still there ten minutes later does the monitor go red.
 *
 * The floor on this number is set by the cadence: anything under ~10 minutes
 * would make a single slow cycle, a Vercel cold start, or one cron-job.org
 * misfire read as an outage.
 */
export const DEFAULT_STALE_MINUTES = 30;

/**
 * How many multiples of the staleness threshold pass, with NOTHING succeeding
 * anywhere, before the overall state is `down` rather than `degraded`.
 * Overridable with `STENION_HEALTH_DOWN_MULTIPLIER`.
 *
 * 2 → 60 minutes, i.e. twelve missed cycles with not one successful run across
 * the entire registry.
 *
 * WHY THERE IS A SECOND, LONGER WINDOW AT ALL. "Every protocol is stale at once"
 * is strong evidence of infrastructure rather than N simultaneous adapter bugs,
 * and it is tempting to call that `down` immediately. Two things argue against
 * doing so at the same threshold. First, the shared dependencies — Soroban RPC
 * and Horizon — are shared by every adapter, so a broad upstream outage takes
 * all of them out together while our own infrastructure is entirely fine;
 * calling that "the cron is dead" sends an operator to the wrong place. Second,
 * a registry this small (three targets today, and one adapter serving several of
 * them) makes "all of them" a much weaker signal than it sounds: with a single
 * protocol listed, "all stale" and "one adapter broken" are the same observation.
 *
 * Doubling the window costs nothing operationally, because `degraded` is ALSO
 * non-200 — a monitor has already fired by then. All the extra 30 minutes buys
 * is the confidence to say which thing broke, which is the only thing the label
 * is for.
 */
export const DEFAULT_DOWN_MULTIPLIER = 2;

/**
 * The overall state.
 *
 * Three values rather than a boolean because "unhealthy" conflates two problems
 * with different owners and different fixes: one adapter failing while the rest
 * are current is a code bug in one file, and nothing succeeding anywhere is the
 * pipeline being down. A single flag makes an operator open the body to find out
 * which, which defeats the point of having a status at all.
 */
export type HealthStatus = 'healthy' | 'degraded' | 'down';

/** Threshold configuration, read from the environment. */
export interface HealthSettings {
  thresholdMinutes: number;
  downMultiplier: number;
}

export const DEFAULT_HEALTH_SETTINGS: HealthSettings = {
  thresholdMinutes: DEFAULT_STALE_MINUTES,
  downMultiplier: DEFAULT_DOWN_MULTIPLIER,
};

/**
 * What the store hands us per protocol. Structurally identical to @stenion/db's
 * `RunHealthEntry` — declared here rather than imported so this module keeps an
 * empty import graph. See the header.
 */
export interface RunFreshness {
  id: string;
  lastSuccessfulRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: 'ok' | 'failed' | null;
}

/** One protocol as `GET /api/v1/health` publishes it. */
export interface HealthProtocol {
  id: string;
  lastSuccessfulRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: 'ok' | 'failed' | null;
  /**
   * Minutes since `lastSuccessfulRunAt`, computed at request time and never
   * stored. Null when the protocol has never scored successfully — null is
   * "there is no successful run to measure from", NOT zero, which would read as
   * perfectly fresh and is the exact inversion of the truth.
   */
  staleMinutes: number | null;
}

/** The `GET /api/v1/health` body. */
export interface HealthBody {
  status: HealthStatus;
  /** Echoed so a consumer can see what the number it is being judged against is. */
  thresholdMinutes: number;
  protocols: HealthProtocol[];
}

/** A finite positive number from an env string, or undefined if it isn't one. */
function positiveNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Read the thresholds from the environment.
 *
 * Mirrors `readRateLimitSettings` in ./_rate-limit exactly, including taking the
 * environment as an argument so it is testable, and including the treatment of a
 * malformed value: fall back to the default rather than throw. A health endpoint
 * that 500s because someone typed `STENION_HEALTH_STALE_MINUTES=thirty` reports
 * an outage that does not exist, and it does so most convincingly at the moment
 * of a deploy — when a real one is most likely and least distinguishable.
 */
export function readHealthSettings(
  env: Record<string, string | undefined> = process.env,
): HealthSettings {
  return {
    thresholdMinutes: positiveNumber(env.STENION_HEALTH_STALE_MINUTES) ?? DEFAULT_STALE_MINUTES,
    downMultiplier: positiveNumber(env.STENION_HEALTH_DOWN_MULTIPLIER) ?? DEFAULT_DOWN_MULTIPLIER,
  };
}

/**
 * Whole minutes between an ISO timestamp and now, or null if there isn't one.
 *
 * Floored, so `staleMinutes: 30` means "at least 30 minutes", and clamped at 0:
 * a run stamped slightly in the future (clock skew between Neon's `now()` and
 * the function's) is fresh, not negative. An unparseable timestamp returns null
 * — the same answer as "never ran", because in both cases we cannot say how old
 * the data is, and inventing a number would be worse than admitting that.
 */
export function minutesSince(iso: string | null, nowMs: number): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((nowMs - ms) / 60_000));
}

/**
 * Is this protocol producing current data?
 *
 * Never having succeeded is NOT current. That is worth stating because elsewhere
 * in Stenion a never-scored protocol (`safetyScore: null`) means "our pipeline
 * has not got there yet" and is deliberately not treated as a bad result. Here
 * the question is different and narrower: this endpoint asks whether the
 * pipeline is producing data for this row, and for a row that has never produced
 * any, the answer is no. It carries no judgement about the protocol.
 */
export function isCurrent(protocol: HealthProtocol, thresholdMinutes: number): boolean {
  return protocol.staleMinutes !== null && protocol.staleMinutes <= thresholdMinutes;
}

/**
 * The per-protocol rows plus the thresholds → the overall state.
 *
 *   healthy   every protocol is current.
 *   degraded  at least one is current and at least one is not — so the pipeline
 *             is demonstrably running and something specific is wrong. Also the
 *             state when everything is stale but not yet past the down window.
 *   down      nothing is current anywhere and the newest success across the whole
 *             registry is older than thresholdMinutes × downMultiplier.
 *
 * An EMPTY registry is `down`, not `healthy`. Vacuous truth is the wrong answer
 * for a probe: "no protocols are stale because there are no protocols" is a
 * database that has been migrated but never indexed, or one pointed at the wrong
 * connection string, and reporting 200 for it would make the endpoint's first
 * ever answer a false negative.
 */
export function overallStatus(protocols: HealthProtocol[], settings: HealthSettings): HealthStatus {
  if (protocols.length === 0) return 'down';

  const current = protocols.filter((p) => isCurrent(p, settings.thresholdMinutes));
  if (current.length === protocols.length) return 'healthy';
  if (current.length > 0) return 'degraded';

  // Nothing is current. How long has that been true? The freshest success
  // anywhere is the most generous reading available, so measuring the down
  // window from it cannot make things look worse than they are.
  const ages = protocols.map((p) => p.staleMinutes).filter((m): m is number => m !== null);
  if (ages.length === 0) return 'down'; // nothing has EVER succeeded

  const downAfterMinutes = settings.thresholdMinutes * settings.downMultiplier;
  return Math.min(...ages) > downAfterMinutes ? 'down' : 'degraded';
}

/**
 * The HTTP status for an overall state.
 *
 * `degraded` and `down` are BOTH 503, so an uptime monitor that only reads the
 * status line catches either without parsing the body — which is the acceptance
 * criterion this endpoint exists to satisfy. The distinction between them is for
 * the human who then opens it, and is carried in `status`, not in the code.
 *
 * 503 rather than 500: nothing has errored. The route did its job, queried
 * successfully, and is telling the truth about a pipeline that is behind. 503 is
 * the status that means exactly that, and it is what monitors and load balancers
 * already understand as "not serving correct data right now, try again".
 */
export function healthHttpStatus(status: HealthStatus): number {
  return status === 'healthy' ? 200 : 503;
}

/**
 * Store rows + settings + the clock → the response body.
 *
 * `nowMs` is a parameter rather than a call to `Date.now()` inside, so every
 * protocol in one response is measured against ONE instant. Reading the clock
 * per protocol would let a slow response report ages that disagree with each
 * other, and would make the whole thing untestable.
 */
export function buildHealthBody(
  rows: readonly RunFreshness[],
  settings: HealthSettings,
  nowMs: number = Date.now(),
): HealthBody {
  const protocols: HealthProtocol[] = rows.map((row) => ({
    id: row.id,
    lastSuccessfulRunAt: row.lastSuccessfulRunAt,
    lastRunAt: row.lastRunAt,
    lastRunStatus: row.lastRunStatus,
    staleMinutes: minutesSince(row.lastSuccessfulRunAt, nowMs),
  }));

  return {
    status: overallStatus(protocols, settings),
    thresholdMinutes: settings.thresholdMinutes,
    protocols,
  };
}
