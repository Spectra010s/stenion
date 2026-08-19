// Cache policy for the public API routes.
//
// This module deliberately imports nothing, like ./_http — it is the part of the
// caching decision that is pure arithmetic, and therefore the part worth pinning
// with tests. The wiring (which route sets which header) lives in the routes.
//
// ---------------------------------------------------------------------------
// WHAT IS ACTUALLY DOING THE CACHING
//
// Vercel's CDN, via the `Cache-Control` header these functions build. Not an
// in-process Map: the API runs as serverless functions, each invocation its own
// process, so a module-level cache would be per-instance — a cache that misses
// on every cold start and holds a different answer per warm instance. The CDN is
// a genuinely shared tier in front of the function, and it is the only shared
// cache this project already pays for.
//
// What that buys, honestly: the CDN caches PER EDGE REGION, so the origin sees
// roughly one request per TTL *per region with traffic*, not one globally. And
// the cache key includes the query string, so `?anything=1` is a fresh key and a
// guaranteed miss — the cache reduces cost for well-behaved clients, it does not
// protect the database from a hostile one. That is the rate limiter's job, and
// it is why the limiter has to be accurate rather than decorative.
//
// ---------------------------------------------------------------------------
// WHY THE TTL IS COMPUTED PER RESPONSE INSTEAD OF BEING A CONSTANT
//
// `lastRunAt` / `lastRunStatus` are how a consumer knows whether our data is
// stale (see the staleness model in ARCHITECTURE.md). A fixed TTL of N seconds
// serves a body claiming "last run succeeded at T" for up to N seconds after a
// LATER run has already failed — the cache would be lying in exactly the field
// that exists to stop us lying about freshness. Bounding N doesn't remove that,
// it just shortens it.
//
// So the TTL is derived from the data in the body: cache until the earliest
// moment the next indexer run could plausibly land, and no further. A response
// then expires *before* there is anything newer to hide, and the only residual
// window is the MIN_TTL floor below.
// ---------------------------------------------------------------------------

/**
 * The indexer's cadence, in seconds. The cron-job.org schedule POSTs to
 * `/api/cron/run-indexer` every 5 minutes; the observed median spacing between
 * `run_at` values is 4m59s.
 *
 * THIS NUMBER IS AN ASSUMPTION, NOT A FACT THIS REPO CONTROLS. The schedule
 * lives in the cron-job.org dashboard, not in version control (see CLAUDE.md),
 * so nothing here fails if someone changes it. That is the entire reason for
 * MAX_TTL_SECONDS: it caps how much staleness a wrong assumption here can cost.
 */
export const INDEXER_INTERVAL_SECONDS = 300;

/**
 * How much EARLIER than a clean +300s the next run can stamp its `run_at`.
 *
 * `run_at` is stamped when a protocol's turn in the cycle begins, not when the
 * cron fires (indexer/src/cycle.ts), so a protocol's spacing shifts by however
 * much the protocols ahead of it sped up or slowed down. That is bounded by the
 * cycle budget — `STENION_CYCLE_BUDGET_MS`, default 42s — so 45s covers the
 * worst case of "the cycle ahead of me took the whole budget last time and
 * finished instantly this time".
 *
 * Subtracting it means the deadline is the earliest plausible next run rather
 * than the expected one. Being early costs a cache miss; being late costs the
 * masked-staleness window this whole module exists to close.
 */
export const CYCLE_JITTER_SECONDS = 45;

/**
 * Hard ceiling on the TTL, regardless of what the deadline arithmetic says.
 *
 * Not a load-shedding number — by the time you are caching for 45s you have
 * already removed essentially all repeat load (a continuously-requested route
 * hits the origin 1/TTL times per second whatever the traffic is, so 45s is
 * ~1.3 origin requests/minute/region and 255s would be ~0.24; the difference is
 * nothing to Neon). It is a blast-radius number: INDEXER_INTERVAL_SECONDS is an
 * assumption about a schedule stored outside this repo, and this caps what a
 * wrong assumption costs at 45s of staleness instead of a full cycle's worth.
 */
export const MAX_TTL_SECONDS = 45;

/**
 * Floor on the TTL, so the moment around a landing run doesn't become an
 * uncached hole every client stampedes through. It is also the worst-case window
 * in which a cached body can hide a newer run: past the deadline we hold a
 * response for at most this long.
 */
export const MIN_TTL_SECONDS = 10;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * How long this response may be cached, in whole seconds.
 *
 * Pass every `lastRunAt` the body reports — one for a detail response, one per
 * protocol for the leaderboard. Any of them changing changes the body, so the
 * TTL is the tightest deadline across them.
 *
 * A null or unparseable `lastRunAt` collapses to the floor: "never run" is the
 * state with no deadline to compute and the one most likely to change next, and
 * it is also the cheapest query in the system, so caching it hard buys nothing.
 * An empty list (no protocols at all) is the same case.
 */
export function cacheTtlSeconds(
  lastRunAts: readonly (string | null)[],
  nowMs: number = Date.now(),
): number {
  if (lastRunAts.length === 0) return MIN_TTL_SECONDS;

  const deadlineOffsetMs = (INDEXER_INTERVAL_SECONDS - CYCLE_JITTER_SECONDS) * 1000;
  let ttl = MAX_TTL_SECONDS;

  for (const iso of lastRunAts) {
    if (iso === null) return MIN_TTL_SECONDS;
    const runAtMs = Date.parse(iso);
    if (!Number.isFinite(runAtMs)) return MIN_TTL_SECONDS;
    ttl = Math.min(ttl, Math.floor((runAtMs + deadlineOffsetMs - nowMs) / 1000));
  }

  return clamp(ttl, MIN_TTL_SECONDS, MAX_TTL_SECONDS);
}

/**
 * `Cache-Control` for a cacheable public response.
 *
 * `s-maxage` targets the shared CDN tier; `max-age=0` deliberately keeps private
 * browser caches out of it. A copy sitting in someone's browser is one we cannot
 * see, cannot expire, and gains us nothing — the shared cache already absorbs the
 * load — and it would put a response's age beyond what the `Age` header reports.
 *
 * NO `stale-while-revalidate`, on purpose. SWR is the standard fix for the
 * stampede at expiry, and it works by serving a body PAST its deadline, which is
 * precisely the masked-staleness this module is built to avoid. The stampede it
 * would prevent is bounded by the rate limiter and by this project's traffic; the
 * staleness it would reintroduce is not bounded by anything.
 */
export function publicCacheControl(ttlSeconds: number): string {
  return `public, max-age=0, s-maxage=${ttlSeconds}`;
}

/**
 * `Cache-Control` for anything that must never be shared.
 *
 * Errors and 429s. A 429 is per-client but the CDN cache key is not — it is the
 * URL — so a cacheable 429 would be served to every client that asked next,
 * turning one rate-limited scraper into an outage for everyone else.
 */
export const NO_STORE = 'no-store';

/**
 * How long a browser may cache the CORS preflight for these routes.
 *
 * The public routes are read-only and their CORS policy is a constant, so a
 * browser re-asking on every request is pure waste — and each preflight is a
 * function invocation we pay for. A day is safe because changing the policy is a
 * deploy, not a runtime decision.
 */
export const PREFLIGHT_MAX_AGE_SECONDS = 86_400;
