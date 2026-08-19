// Public read-only API
//
// Two endpoints, both served straight from the Postgres tables step 5 wrote
// (via @stenion/db). Nothing is recomputed here — the indexer owns scoring on
// its interval; this process only reads and shapes the stored rows into the
// agreed JSON contract:
//
//   GET /v1/protocols     — leaderboard: every protocol with its latest-ok
//                           safetyScore + computedAt, ranked by score desc, plus
//                           lastRunAt/lastRunStatus so a stale score is visible.
//   GET /v1/protocol/:id  — one protocol's detail: latest-ok safetyScore, the
//                           five *Safety factors ({value,weight,detail}), staleness
//                           fields, and recent run history (newest first).
//
// The paths are versioned to match what the live dashboard routes serve
// (/api/v1/* there; this standalone server has no /api mount prefix). This
// package is dormant — see ARCHITECTURE.md "Why @stenion/api exists but isn't
// deployed" — but if it's ever spun back up it must not serve paths that
// contradict the documented versioning policy.
//
// Deliberately minimal per step 6: no auth, no rate limiting, no pagination —
// those are separate concerns, not built speculatively. The leaderboard ranks
// purely on safety_score (payment-blind, a non-negotiable rule).
//
// ---------------------------------------------------------------------------
// NOT AT PARITY WITH THE DEPLOYED ROUTES. READ THIS BEFORE SPINNING IT BACK UP.
//
// The dashboard's route handlers gained CDN caching and a rate limiter; this
// server has NEITHER, and that gap is deliberate rather than an oversight to
// port across. Both of those are deployment concerns, not API concerns:
//
//   - The cache is a `Cache-Control` header interpreted by Vercel's CDN. A
//     standalone service has no CDN in front of it by default, so the same
//     header would be a no-op — the shared cache tier has to come from wherever
//     this is actually deployed (a reverse proxy, a CDN, or an in-process cache,
//     which only becomes viable once there is a single long-lived process).
//   - The rate limiter's counter lives in Postgres SPECIFICALLY because
//     serverless has no shared memory. A single long-lived Node process does,
//     so paying a database round trip per request here would be the wrong
//     trade — this is exactly the case where an in-memory bucket is correct.
//
// So: whoever revives this owns both decisions afresh. What must NOT change on
// the way is the JSON contract or the versioned paths, which are shared.
//
// One rule does carry over verbatim, because it is a correctness property of the
// data rather than of the transport: WHATEVER CACHES THIS, IT MUST NOT MASK
// `lastRunAt` / `lastRunStatus`. Those two fields are how a consumer knows our
// data is stale, so a cache that serves a stale `lastRunStatus` is lying about
// freshness in the one place we promise not to. The deployed routes solve it by
// deriving each response's TTL from the `lastRunAt` values in its own body
// (dashboard/app/api/_cache.ts) rather than using a fixed TTL — the reasoning,
// and the bound it buys, are in ARCHITECTURE.md "Caching and rate limits".
// ---------------------------------------------------------------------------
//
// Connection: reuses @stenion/db's getPool(), which reads the same repo-root
// DATABASE_URL the indexer uses — Neon's *pooled* (-pooler / PgBouncer)
// endpoint. That's the right one under Vercel serverless: many short-lived
// function instances each open a connection and the pooler multiplexes them,
// avoiding Postgres connection exhaustion. No second/duplicated connection.

import { createStore, getPool, type Store } from '@stenion/db';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

// CORS: this API serves only public, read-only, payment-blind data, so any
// origin may read it (a wallet, the dashboard's dev server, its deployed
// domain, any third party). `*` is the correct, simplest policy here — there is
// nothing origin-specific to protect. Only GET is exposed; OPTIONS is answered
// for completeness. Deliberately not a configurable/generic CORS layer — two
// GET routes over public data don't warrant one.
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
} as const;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...CORS_HEADERS,
  });
  res.end(payload);
}

/**
 * Route one request. Both handlers return the shapes agreed as the public
 * contract (see the header comment). A `history[]` entry from getProtocolDetail
 * is a discriminated union on `status`:
 *   - status: 'ok'     → { safetyScore, computedAt, runAt }
 *   - status: 'failed' → { error, runAt }
 * so a consumer switches on `status` rather than probing for fields; factors are
 * intentionally not included per history row (only on the top-level current score).
 */
async function handle(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  // CORS preflight: a browser may send OPTIONS before a cross-origin GET. Answer
  // it directly with the CORS headers and no body (simple GETs won't trigger it,
  // but responding keeps any stricter client happy).
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Only GET is supported; anything else is a clean 405 rather than a 404.
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // Parse the path; the host is irrelevant (a dummy base satisfies the URL API).
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');

  if (pathname === '/v1/protocols') {
    const protocols = await store.listProtocolsWithLatestScore();
    sendJson(res, 200, { protocols });
    return;
  }

  // GET /v1/protocol/:id — match and extract the id segment.
  const detailMatch = /^\/v1\/protocol\/([^/]+)$/.exec(pathname);
  if (detailMatch) {
    const id = decodeURIComponent(detailMatch[1]);
    const detail = await store.getProtocolDetail(id);
    if (!detail) {
      sendJson(res, 404, { error: 'Protocol not found', id });
      return;
    }
    sendJson(res, 200, detail);
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

/**
 * Build the request handler over a Store. Kept separate from server startup so
 * it can be reused as a serverless function handler later (step 7/deploy)
 * without standing up a listening server. Any thrown error (e.g. DB
 * unreachable) is caught here and returned as a generic 500 — the raw DB error
 * is logged server-side, never leaked to the client.
 */
export function createRequestHandler(store: Store) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    handle(req, res, store).catch((err) => {
      console.error('Request failed:', err);
      sendJson(res, 500, { error: 'Internal server error' });
    });
  };
}

function main(): void {
  const store = createStore(getPool());
  const handler = createRequestHandler(store);

  // Default 3001 so `pnpm --filter @stenion/api start` is reachable without extra
  // env (matches dashboard/.env.local's STENION_API_URL); override with API_PORT.
  // Without a default this is Number(undefined) → NaN → a random OS-assigned port.
  const port = Number(process.env.API_PORT) || 3001;

  const server = createServer(handler);
  server.listen(port, () => {
    console.log(`stenion api listening on http://localhost:${port}`);
  });
}

// Only start a server when run directly (`node dist/index.js`); importing this
// module for the exported handler (serverless) must not open a port.
if (require.main === module) {
  main();
}
