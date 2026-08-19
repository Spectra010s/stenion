// Shared server-side wiring for the merged public API routes.
//
// This lives under app/api/ but is named with a leading underscore folder-free
// (it's a plain module, not a route.ts), so Next never treats it as an endpoint.
// It is server-only — it imports @stenion/db (pg).
//
// The pure HTTP shaping (CORS_HEADERS, jsonResponse), the cache-TTL policy
// (./_cache) and the rate-limit policy (./_rate-limit) all live in leaf modules
// with no imports, so they can be tested from a plain Node test; they are
// re-exported here so route files keep one import site. They are separate
// because `server-only` below is a bare specifier only Next's bundler resolves,
// which makes this module unimportable from a test — see _http.test.ts.

import 'server-only';
import {
  createRateLimiter,
  createStore,
  getPool,
  loadEnv,
  type RateLimiter,
  type Store,
} from '@stenion/db';

import { jsonResponse } from './_http';
import {
  bucketKey,
  clientIp,
  createDenyCache,
  rateLimitHeaders,
  rateLimitedBody,
  readRateLimitSettings,
  type RateLimitSettings,
} from './_rate-limit';

export { CORS_HEADERS, jsonResponse } from './_http';
export { NO_STORE, PREFLIGHT_MAX_AGE_SECONDS, cacheTtlSeconds, publicCacheControl } from './_cache';

// One Store per server process, reused across warm invocations (the pg Pool is a
// module singleton in @stenion/db). Deliberately never closed — closing would
// break reuse on the next request; the Neon pooler owns connection lifecycle.
let store: Store | undefined;
export function getStore(): Store {
  if (!store) store = createStore(getPool());
  return store;
}

// Same lifecycle as the Store, over the same pool: the limiter's state is a row
// in Postgres, not anything held here, so this object is just the prepared query.
let limiter: RateLimiter | undefined;
function getRateLimiter(): RateLimiter {
  if (!limiter) limiter = createRateLimiter(getPool());
  return limiter;
}

let settings: RateLimitSettings | undefined;
function getSettings(): RateLimitSettings {
  if (!settings) {
    // Populate process.env from the repo-root .env when running locally; a no-op
    // on Vercel, where these come from the project's configured environment.
    loadEnv();
    settings = readRateLimitSettings();
  }
  return settings;
}

/**
 * Per-instance memo of clients already refused, so a flood does not cost one
 * database write per request. It can only ever refuse faster, never allow — see
 * ./_rate-limit for why that asymmetry is what makes a per-instance structure
 * sound here.
 */
const denyCache = createDenyCache();

/**
 * Apply the public API's rate limit to one request.
 *
 * Returns a ready-to-send 429 when the client is over its limit, or `null` when
 * the request should proceed. Callers put it first in the handler, before any
 * database work — refusing a request that then queries anyway would protect
 * nothing.
 *
 * NOT WIRED INTO `POST /api/cron/run-indexer`, deliberately. That route is
 * authenticated with a shared secret and called by our own scheduler; rate
 * limiting it could only ever do one thing, which is block a scheduled run.
 *
 * FAILS OPEN. If the limiter's own query throws — the table is missing because
 * the migration has not been applied yet, the pool is exhausted, Neon is down —
 * the request is allowed and the error is logged. A limiter outage must not
 * become an API outage: the worst case of failing open is the unprotected
 * behaviour we had before this existed, and the worst case of failing closed is
 * a public API that returns 429 to everybody because a guard rail broke.
 */
export async function enforceRateLimit(req: Request): Promise<Response | null> {
  const config = getSettings();
  if (!config.enabled) return null;

  const key = bucketKey(clientIp(req.headers), config.salt);
  const now = Date.now();

  const alreadyBlocked = denyCache.blockedFor(key, now);
  if (alreadyBlocked !== null) return refuse(config, alreadyBlocked, now);

  try {
    const decision = await getRateLimiter().take(key, {
      burst: config.burst,
      refillPerSecond: config.perMinute / 60,
    });
    if (decision.allowed) return null;

    denyCache.block(key, decision.retryAfterSeconds, now);
    return refuse(config, decision.retryAfterSeconds, now);
  } catch (err) {
    console.error('Rate limit check failed; allowing the request:', err);
    return null;
  }
}

function refuse(config: RateLimitSettings, retryAfterSeconds: number, nowMs: number): Response {
  return jsonResponse(
    rateLimitedBody(retryAfterSeconds),
    429,
    rateLimitHeaders(config, retryAfterSeconds, nowMs),
  );
}
