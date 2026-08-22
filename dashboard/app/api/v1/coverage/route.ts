// GET /api/v1/coverage — protocols Stenion has assessed and deliberately does
// not score. This remains separate from the ranked /api/v1/protocols contract:
// a coverage decision is not a failed or low score.

import { coverageForApi } from '../../../lib/coverage';
import {
  CORS_HEADERS,
  NO_STORE,
  PREFLIGHT_MAX_AGE_SECONDS,
  enforceRateLimit,
  getStore,
  jsonResponse,
  publicCacheControl,
} from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Coverage records are static and normally change only with a deploy. The live
 * leaderboard lookup is a defensive dedupe guard, not their source of truth.
 * One hour substantially reduces repeated database reads while bounding how
 * long a forgotten reciprocal cleanup could leave a now-scored entry cached.
 */
const COVERAGE_CACHE_TTL_SECONDS = 3_600;

export async function GET(req: Request): Promise<Response> {
  const limited = await enforceRateLimit(req);
  if (limited) return limited;

  try {
    const protocols = await getStore().listProtocolsWithLatestScore();
    const coverage = coverageForApi(protocols.map((protocol) => protocol.id));
    return jsonResponse({ coverage }, 200, {
      'cache-control': publicCacheControl(COVERAGE_CACHE_TTL_SECONDS),
    });
  } catch (err) {
    console.error('GET /api/v1/coverage failed:', err);
    return jsonResponse({ error: 'Internal server error' }, 500, { 'cache-control': NO_STORE });
  }
}

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
