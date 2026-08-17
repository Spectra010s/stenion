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
  /**
   * Root-relative path to a logo this app hosts under `public/`, or null when
   * the protocol publishes no usable mark. Null is a rendered state, not an
   * error — <ProtocolLogo> draws a deliberate initials tile.
   */
  logo: string | null;
  safetyScore: number | null;
  computedAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: RunStatus | null;
}

/**
 * A named sub-signal inside a factor. A numeric `value` is a scored component
 * that fed the parent factor; `value: null` is a DISCLOSURE — a real on-chain
 * quantity published deliberately without a score, because grading it would
 * invent comparability the data doesn't support (METHODOLOGY.md §2c). Null is
 * never "missing data" here.
 */
export interface RiskFactorComponent {
  id: string;
  label: string;
  value: number | null;
  detail: string;
}

export interface RiskFactor {
  value: number;
  weight: number;
  detail: string;
  /** optional breakdown of the sub-signals behind `value` */
  components?: RiskFactorComponent[];
}

// The five *Safety factors, higher = safer. A member may be null if a factor
// genuinely doesn't apply to a protocol (render "N/A", don't drop it).
export type RiskFactorKey =
  'collateralSafety' | 'oracleSafety' | 'adminKeySafety' | 'liquiditySafety' | 'utilizationSafety';

export type RiskFactorMap = Record<RiskFactorKey, RiskFactor | null>;

export type HistoryEntry =
  | {
      status: 'ok';
      safetyScore: number;
      /** rulebook version this point was scored under; scores across versions aren't comparable */
      methodologyVersion: number;
      computedAt: string;
      runAt: string;
    }
  | { status: 'failed'; error: string; runAt: string };

export interface ProtocolDetail {
  id: string;
  name: string;
  chain: string;
  adapter: string;
  /** see LeaderboardEntry.logo */
  logo: string | null;
  /**
   * The Soroban contract this protocol's score is derived from — a raw
   * C-address, not an explorer URL. The dashboard builds the URL itself (see
   * lib/explorer.ts) so the choice of explorer is one decision in one place.
   */
  contractId: string | null;
  /**
   * The protocol's own site/docs, null when it publishes none. Rendered as the
   * subject's own properties, never as a recommendation — see the attribution
   * note that accompanies them in the UI.
   */
  site: string | null;
  docs: string | null;
  safetyScore: number | null;
  computedAt: string | null;
  factors: RiskFactorMap | null;
  /** rulebook version behind the current score (null if never scored) */
  methodologyVersion: number | null;
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
