// Public read-only API 
//
// Two endpoints, both served straight from the Postgres tables step 5 wrote
// (via @stenion/db). Nothing is recomputed here — the indexer owns scoring on
// its interval; this process only reads and shapes the stored rows into the
// agreed JSON contract:
//
//   GET /protocols      — leaderboard: every protocol with its latest-ok
//                         safetyScore + computedAt, ranked by score desc, plus
//                         lastRunAt/lastRunStatus so a stale score is visible.
//   GET /protocol/:id   — one protocol's detail: latest-ok safetyScore, the
//                         five *Safety factors ({value,weight,detail}), staleness
//                         fields, and recent run history (newest first).
//
// Deliberately minimal per step 6: no auth, no rate limiting, no pagination —
// those are separate concerns, not built speculatively. The leaderboard ranks
// purely on safety_score (payment-blind, a non-negotiable rule).
//
// Connection: reuses @stenion/db's getPool(), which reads the same repo-root
// DATABASE_URL the indexer uses — Neon's *pooled* (-pooler / PgBouncer)
// endpoint. That's the right one under Vercel serverless: many short-lived
// function instances each open a connection and the pooler multiplexes them,
// avoiding Postgres connection exhaustion. No second/duplicated connection.

import { createStore, getPool, type Store } from '@stenion/db';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
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
  // Only GET is supported; anything else is a clean 405 rather than a 404.
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // Parse the path; the host is irrelevant (a dummy base satisfies the URL API).
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');

  if (pathname === '/protocols') {
    const protocols = await store.listProtocolsWithLatestScore();
    sendJson(res, 200, { protocols });
    return;
  }

  // GET /protocol/:id — match and extract the id segment.
  const detailMatch = /^\/protocol\/([^/]+)$/.exec(pathname);
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
  const port = Number(process.env.API_PORT);

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
