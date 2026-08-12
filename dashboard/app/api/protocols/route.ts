// GET /api/protocols — the public leaderboard.
//
// Migrated verbatim from the standalone @stenion/api's GET /protocols: same Store
// method (listProtocolsWithLatestScore), same `{ protocols: [...] }` envelope,
// same ranking (safetyScore desc, never-scored last — done in SQL). This is a
// transport change (node:http server → Next Route Handler), not a logic change.

import { CORS_HEADERS, getStore, jsonResponse } from '../_shared';

// pg needs the Node.js runtime (not Edge). force-dynamic + no caching so every
// request reflects the freshest stored row, matching the old cache:'no-store'.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const protocols = await getStore().listProtocolsWithLatestScore();
    return jsonResponse({ protocols });
  } catch (err) {
    // Raw DB errors are logged server-side, never leaked to the client — same
    // generic 500 the standalone API returned.
    console.error('GET /api/protocols failed:', err);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}

/** CORS preflight for cross-origin browser clients. */
export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
