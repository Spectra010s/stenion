// GET /api/v1/health — is the indexer still producing data?
//
// A machine-readable freshness signal, added because there was previously no way
// to answer that question short of querying Neon by hand or eyeballing a
// timestamp in the UI. Scoring silently stopping is one of Stenion's worst
// failure modes precisely because nothing goes red: the site keeps serving
// last-known scores and every page renders fine while the numbers age.
//
// Follows the same skeleton as the other /v1 routes — rate limit first, one Store
// call, jsonResponse, generic 500, OPTIONS preflight — with two deliberate
// differences, both documented below: it is NOT CDN-cached, and it can answer
// 503. The policy it serves (what "stale" means, the three states, which status
// each gets) is in ../../_health.ts, which is a pure leaf so it can be tested.
//
// Versioned under /v1 like every other public path; see ARCHITECTURE.md
// "API versioning". Public and unauthenticated on purpose: it publishes run
// timestamps and nothing else — no scores, no errors, no configuration — which
// is strictly less than /v1/protocols already exposes.

import {
  CORS_HEADERS,
  NO_STORE,
  PREFLIGHT_MAX_AGE_SECONDS,
  enforceRateLimit,
  getStore,
  jsonResponse,
  publicCacheControl,
} from '../../_shared';
import { buildHealthBody, healthHttpStatus, readHealthSettings } from '../../_health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  // First, like every other public route: this one is cheap, but it is still a
  // database query, and an endpoint designed to be polled is the last one that
  // should be exempt from the limiter. At 60/min a monitor probing every 30
  // seconds uses 2.
  const limited = await enforceRateLimit(req);
  if (limited) return limited;

  try {
    // ONE query — see @stenion/db's listRunHealth. Two LATERAL index walks per
    // protocol over the index the leaderboard already uses, no score columns, no
    // factors jsonb, no per-protocol fan-out.
    const rows = await getStore().listRunHealth();
    const body = buildHealthBody(rows, readHealthSettings());

    // NEVER CACHED, unlike the other three /v1 routes, and this is the one place
    // this route deliberately departs from them.
    //
    // ./_cache exists to stop a cached body masking `lastRunAt`/`lastRunStatus`,
    // and it does that by expiring before the next indexer run could contradict
    // it. That works there because the thing being hidden changes only when a run
    // lands. Here it does not: staleness advances with the wall clock, so a body
    // built at 29 minutes stale and cached for 45 seconds is still being served,
    // saying `healthy` with a 200, once the true answer has become `degraded`
    // with a 503. The window is small, but this is the endpoint whose entire
    // purpose is to be believed about freshness — a health check that can be
    // stale is a contradiction, not a tradeoff.
    //
    // The 503s must not be cached either, and for a stronger reason: the CDN
    // cache key is the URL, so a cached 503 would go on being served to everyone
    // after the pipeline recovered, turning a resolved incident into an ongoing
    // one. `no-store` covers both cases with one rule.
    //
    // What it costs: one database round trip per request, uncushioned. Measured
    // from a dev machine on 2026-08-22, warm: 0.4-1.1s for listRunHealth against
    // 1.1-1.2s for the leaderboard query, both dominated by network round trip
    // rather than by the query. So this is no more expensive than the route that
    // IS cached, it does strictly less work per row, and it is bounded above by
    // the rate limiter.
    //
    // KNOWN CAVEAT, measured rather than assumed: a COLD Neon (scaled to zero)
    // took ~20s to answer the first query. Vercel's default route timeout is 10s,
    // so a probe landing on a cold database gets a platform 504 instead of this
    // route's own 503. That is left alone deliberately rather than papered over
    // with a raised `maxDuration`. Neon only goes cold if nothing has touched it
    // for a long while, which on this deployment means the indexer has stopped —
    // exactly the case where the answer is "unhealthy" anyway. A monitor reads
    // 504 and 503 the same way, so the verdict survives; only the body is lost,
    // and buying it back would mean making every healthy probe wait longer.
    return jsonResponse(body, healthHttpStatus(body.status), { 'cache-control': NO_STORE });
  } catch (err) {
    // Same generic 500 and same no-store as the other routes. Note this is NOT
    // the unhealthy path: a 503 above means the query succeeded and the pipeline
    // is behind, a 500 here means we could not find out. Keeping them on separate
    // codes is what lets a monitor tell "the indexer is stopped" from "the health
    // check itself is broken".
    console.error('GET /api/v1/health failed:', err);
    return jsonResponse({ error: 'Internal server error' }, 500, { 'cache-control': NO_STORE });
  }
}

/**
 * CORS preflight for cross-origin browser clients.
 *
 * Cacheable for a day and not rate limited, exactly as on the other public
 * routes: the policy is a constant that only changes on deploy. Caching the
 * preflight is unrelated to caching the response — the preflight answers "may I
 * ask?", which does not go stale, not "what is the answer?", which does.
 */
export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'access-control-max-age': String(PREFLIGHT_MAX_AGE_SECONDS),
      'cache-control': publicCacheControl(PREFLIGHT_MAX_AGE_SECONDS),
    },
  });
}
