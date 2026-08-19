// GET /api/v1/protocol/:id — one protocol's detail + recent run history.
//
// Migrated verbatim from the standalone @stenion/api's GET /protocol/:id: same
// Store method (getProtocolDetail), same JSON shape, same 404-on-unknown-id and
// generic-500-on-error behaviour. Transport change only.
//
// Versioned under /v1 as of the API-versioning change: the JSON contract is
// unchanged (URL-only move). See ARCHITECTURE.md "API versioning" for the policy.
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
} from '../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Before the database work, and before awaiting params: an unknown id is still
  // a query, so id enumeration has to be limited like anything else.
  const limited = await enforceRateLimit(req);
  if (limited) return limited;

  // Next 15: params is async and must be awaited.
  const { id } = await params;
  try {
    const detail = await getStore().getProtocolDetail(id);
    if (!detail) {
      // Not cached. A 404 is the answer for an id that does not exist YET — a
      // protocol added in the next cycle would otherwise keep 404ing from a
      // shared cache after it went live. Enumeration of unknown ids is the rate
      // limiter's problem, not the cache's.
      return jsonResponse({ error: 'Protocol not found', id }, 404, { 'cache-control': NO_STORE });
    }
    // TTL from this protocol's own lastRunAt, so the response expires before its
    // next run could contradict the lastRunStatus it is reporting. See ./_cache.
    const ttl = cacheTtlSeconds([detail.lastRunAt]);
    return jsonResponse(detail, 200, { 'cache-control': publicCacheControl(ttl) });
  } catch (err) {
    console.error(`GET /api/v1/protocol/${id} failed:`, err);
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
