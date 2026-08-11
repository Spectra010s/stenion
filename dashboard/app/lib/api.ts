// Server-side API client.
//
// Per the step-7 decision, the dashboard reads @stenion/api from the SERVER
// (React Server Components), never from the browser. So:
//   - STENION_API_URL is a server-only env var (no NEXT_PUBLIC_ prefix); the
//     browser never learns the API origin and never calls it directly.
//   - No CORS is needed for this path (server-to-server). The API sends CORS
//     headers anyway for future direct/third-party clients.
//
// These types mirror the frozen contract documented in CLAUDE.md ("Public API").
// They are duplicated here rather than imported from @stenion/db on purpose: the
// dashboard depends on the HTTP contract (the JSON shape), not on the database
// layer's internals. If the contract changes, that's a breaking change caught here.

const API_BASE = process.env.STENION_API_URL;

export type RunStatus = 'ok' | 'failed';

export interface LeaderboardEntry {
  id: string;
  name: string;
  chain: string;
  safetyScore: number | null;
  computedAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: RunStatus | null;
}

export interface RiskFactor {
  value: number;
  weight: number;
  detail: string;
}

// The five *Safety factors, higher = safer. A member may be null if a factor
// genuinely doesn't apply to a protocol (render "N/A", don't drop it).
export type RiskFactorKey =
  | 'collateralSafety'
  | 'oracleSafety'
  | 'adminKeySafety'
  | 'liquiditySafety'
  | 'utilizationSafety';

export type RiskFactorMap = Record<RiskFactorKey, RiskFactor | null>;

export type HistoryEntry =
  | { status: 'ok'; safetyScore: number; computedAt: string; runAt: string }
  | { status: 'failed'; error: string; runAt: string };

export interface ProtocolDetail {
  id: string;
  name: string;
  chain: string;
  adapter: string;
  safetyScore: number | null;
  computedAt: string | null;
  factors: RiskFactorMap | null;
  lastRunAt: string | null;
  lastRunStatus: RunStatus | null;
  history: HistoryEntry[];
}

// Human-friendly order + labels for the factor rows on the detail page.
export const FACTOR_ORDER: { key: RiskFactorKey; label: string }[] = [
  { key: 'collateralSafety', label: 'Collateral' },
  { key: 'oracleSafety', label: 'Oracle' },
  { key: 'adminKeySafety', label: 'Admin key' },
  { key: 'liquiditySafety', label: 'Liquidity' },
  { key: 'utilizationSafety', label: 'Utilization' },
];

/**
 * Fetch the leaderboard. `cache: 'no-store'` because scores update on the
 * indexer's interval — the dashboard should always show the freshest stored row,
 * not a build-time snapshot.
 */
export async function getProtocols(): Promise<LeaderboardEntry[]> {
  const res = await fetch(`${API_BASE}/protocols`, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`GET /protocols failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { protocols: LeaderboardEntry[] };
  return body.protocols;
}

/**
 * Fetch one protocol's detail. Returns null on a 404 (unknown id) so the page
 * can render Next's notFound() cleanly; any other non-ok status throws.
 */
export async function getProtocolDetail(id: string): Promise<ProtocolDetail | null> {
  const res = await fetch(`${API_BASE}/protocol/${encodeURIComponent(id)}`, {
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GET /protocol/${id} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as ProtocolDetail;
}
