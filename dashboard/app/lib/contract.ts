// The frozen Stenion API contract — pure types, no runtime dependencies.
//
// These mirror the JSON shapes documented in CLAUDE.md ("Public API"). They are
// declared here (not imported from @stenion/db) on purpose: this file is safe to
// import from ANY code — server components, client components, and the route
// handlers alike — because it pulls in no `pg`/Node modules. The server-only
// data access (which does import @stenion/db) lives in ./api and must never be
// imported by a client component; import the types from HERE instead.

export type RunStatus = 'ok' | 'failed';

/**
 * Present when an entry is a market running on ANOTHER protocol's contracts
 * rather than on its own — the YieldBlox pool, which runs Blend's V2 pool
 * contract byte-for-byte, is the case this exists for.
 *
 * Anything rendering a protocol's name MUST render this beside it when it is
 * non-null. That is not a style preference: without it the registry says the
 * ecosystem has four independent lending protocols when it has two protocols
 * and four markets, and a reader who scans the list and leaves has been
 * misinformed. Null means the entry runs on its own contracts — never "unknown".
 *
 * `host` is a display name, not a protocol id, and links to nothing: Stenion's
 * `blend` entry is itself one Blend market, so pointing at it would claim the
 * pool runs on that entry rather than on the host protocol's contract.
 */
export interface ProtocolDeployment {
  /** the host protocol's display name, e.g. "Blend" */
  host: string;
  /** short label naming the deployment, e.g. "Blend V2 pool" */
  label: string;
}

/**
 * How restricted a market is, as its own contracts currently gate it — named by
 * what a user cannot do rather than by any protocol's own vocabulary.
 *
 * NEVER A SCORE, and never rendered as one. `exitDisabled` is not "worse" on a
 * scale; it is a statement that withdrawals are refused. The registry
 * deliberately does not grade any of this — nothing on chain distinguishes an
 * admin freezing a pool to contain a threat from an admin walking away from it,
 * and the two protocols' restricted states are not even the same shape (Blend
 * never blocks a withdrawal at any status; K2's pause blocks all of them). See
 * METHODOLOGY.md, "Operational state is published, never scored".
 */
export type OperationalLevel =
  'active' | 'borrowingDisabled' | 'entryDisabled' | 'exitDisabled' | 'notOperational';

/** One user-facing operation a market can refuse. */
export type PoolOperation = 'supply' | 'withdraw' | 'borrow' | 'repay' | 'liquidate';

/**
 * A market's live restrictions as of its latest successful run.
 *
 * Anything rendering a protocol's SCORE must render this beside it when the
 * level is anything but `active` — the same rule, for the same reason, as
 * ProtocolDeployment. A halted market and a fully open one can publish the same
 * number, and a reader who scans the registry and leaves must not have been
 * shown only the number.
 *
 * Null means the state was not read — a protocol that has never scored, or a run
 * predating the field. It never means "nothing is restricted".
 */
export interface OperationalState {
  level: OperationalLevel;
  /** the protocol's own reading, verbatim, e.g. "PoolConfig.status = 4" */
  source: string;
  /** exactly which operations are refused, in a canonical order */
  blocked: PoolOperation[];
  /**
   * Who could have set this, as far as the chain says — never why. `admin`: only
   * an admin could have. `protocol`: the protocol's own mechanism did.
   * `indeterminate`: both paths could produce it, or the value carries no origin.
   */
  origin: 'admin' | 'protocol' | 'indeterminate';
  /** one sentence on what was read and what it means for a user */
  detail: string;
  /** when the reading was taken, ISO 8601 */
  asOf: string;
}

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
  /** see ProtocolDeployment — null for an entry on its own contracts */
  deployedOn: ProtocolDeployment | null;
  safetyScore: number | null;
  computedAt: string | null;
  /** see OperationalState — null means "not read", never "unrestricted" */
  operationalState: OperationalState | null;
  lastRunAt: string | null;
  lastRunStatus: RunStatus | null;
}

/**
 * A named sub-signal inside a factor. A numeric `value` is a scored component
 * that fed the parent factor; `value: null` is a DISCLOSURE — a real on-chain
 * quantity published deliberately without a score, because grading it would
 * invent comparability the data doesn't support (METHODOLOGY.md §2c/§2d). Null is
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
  /** see ProtocolDeployment — null for an entry on its own contracts */
  deployedOn: ProtocolDeployment | null;
  safetyScore: number | null;
  computedAt: string | null;
  factors: RiskFactorMap | null;
  /** see OperationalState — null means "not read", never "unrestricted" */
  operationalState: OperationalState | null;
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
