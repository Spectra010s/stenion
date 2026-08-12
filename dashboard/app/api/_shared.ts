// Shared server-side helpers for the merged public API routes.
//
// This lives under app/api/ but is named with a leading underscore folder-free
// (it's a plain module, not a route.ts), so Next never treats it as an endpoint.
// It is server-only — it imports @stenion/db (pg).

import 'server-only';
import { createStore, getPool, type Store } from '@stenion/db';

// CORS for the PUBLIC data routes only. Stenion's /protocols + /protocol/:id serve
// public, read-only, payment-blind data — any origin may read them (a wallet, a
// third-party dashboard, anyone), so `*` is the correct, simplest policy, carried
// over verbatim from the standalone @stenion/api. NOTE: the Stenion dashboard's
// own pages do NOT rely on this — they read the Store in-process (see app/lib/api.ts),
// never cross-origin. CORS here is purely for external browser clients. The cron
// route deliberately gets NO CORS (it's secret-gated, not public).
export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

/** JSON response carrying the CORS headers, matching the shipped API contract. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

// One Store per server process, reused across warm invocations (the pg Pool is a
// module singleton in @stenion/db). Deliberately never closed — closing would
// break reuse on the next request; the Neon pooler owns connection lifecycle.
let store: Store | undefined;
export function getStore(): Store {
  if (!store) store = createStore(getPool());
  return store;
}
