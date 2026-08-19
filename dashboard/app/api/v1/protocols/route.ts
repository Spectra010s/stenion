// GET /api/v1/protocols — the public leaderboard.
//
// Migrated verbatim from the standalone @stenion/api's GET /protocols: same Store
// method (listProtocolsWithLatestScore), same `{ protocols: [...] }` envelope,
// same ranking (safetyScore desc, never-scored last — done in SQL). This is a
// transport change (node:http server → Next Route Handler), not a logic change.
//
// Versioned under /v1 as of the API-versioning change: the JSON contract is
// unchanged (URL-only move). See ARCHITECTURE.md "API versioning" for the policy —
// additive changes stay on v1, breaking ones get a v2.
//
// Caching and rate limiting were added later and changed NO part of the JSON:
// they are a `Cache-Control` header on the 200 and a new 429 status for clients
// that are over their limit. See ARCHITECTURE.md "Caching and rate limits".

import {
  CORS_HEADERS,
  NO_STORE,
  PREFLIGHT_MAX_AGE_SECONDS,
  cacheTtlSeconds,
  enforceRateLimit,
  getStore,
  jsonResponse,
  publicCacheControl,
} from '../../_shared';

// pg needs the Node.js runtime (not Edge). force-dynamic because the response is
// computed per request from the database — including its own TTL. The caching
// that matters is the shared CDN tier in front of this function, driven by the
// `Cache-Control` header below, not Next's route cache.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  // First, before any database work: refusing a client and then querying anyway
  // would protect nothing. Returns null when the request may proceed.
  const limited = await enforceRateLimit(req);
  if (limited) return limited;

  try {
    const protocols = await getStore().listProtocolsWithLatestScore();
    // TTL from the body's own staleness fields, so a cached response expires
    // before there is a newer run for it to hide. Every protocol's lastRunAt
    // counts — any of them landing changes this body. See ./_cache.
    const ttl = cacheTtlSeconds(protocols.map((p) => p.lastRunAt));
    return jsonResponse({ protocols }, 200, { 'cache-control': publicCacheControl(ttl) });
  } catch (err) {
    // Raw DB errors are logged server-side, never leaked to the client — same
    // generic 500 the standalone API returned. Never cached: a cached 500 would
    // outlive the outage that caused it.
    console.error('GET /api/v1/protocols failed:', err);
    return jsonResponse({ error: 'Internal server error' }, 500, { 'cache-control': NO_STORE });
  }
}

/**
 * CORS preflight for cross-origin browser clients.
 *
 * Cacheable for a day, and not rate limited: the policy is a constant that only
 * changes on deploy, and every preflight a browser has to repeat is a function
 * invocation that answers a question we already answered.
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
