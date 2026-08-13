// GET /api/v1/protocol/:id — one protocol's detail + recent run history.
//
// Migrated verbatim from the standalone @stenion/api's GET /protocol/:id: same
// Store method (getProtocolDetail), same JSON shape, same 404-on-unknown-id and
// generic-500-on-error behaviour. Transport change only.
//
// Versioned under /v1 as of the API-versioning change: the JSON contract is
// unchanged (URL-only move). See ARCHITECTURE.md "API versioning" for the policy.

import { CORS_HEADERS, getStore, jsonResponse } from '../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Next 15: params is async and must be awaited.
  const { id } = await params;
  try {
    const detail = await getStore().getProtocolDetail(id);
    if (!detail) {
      return jsonResponse({ error: 'Protocol not found', id }, 404);
    }
    return jsonResponse(detail);
  } catch (err) {
    console.error(`GET /api/v1/protocol/${id} failed:`, err);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}

/** CORS preflight for cross-origin browser clients. */
export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
