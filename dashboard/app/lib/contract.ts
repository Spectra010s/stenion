// The frozen Stenion API contract — pure types, no runtime dependencies.
//
// These mirror the JSON shapes documented in CLAUDE.md ("Public API"). They are
// declared here (not imported from @stenion/db) on purpose: this file is safe to
// import from ANY code — server components, client components, and the route
// handlers alike — because it pulls in no `pg`/Node modules. The server-only
// data access (which does import @stenion/db) lives in ./api and must never be
// imported by a client component; import the types from HERE instead.

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
  'collateralSafety' | 'oracleSafety' | 'adminKeySafety' | 'liquiditySafety' | 'utilizationSafety';

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
