export type Chain = 'stellar';

export interface ProtocolMetadata {
  /** unique slug used as the primary key across storage and the API, e.g. "blend" */
  id: string;
  name: string;
  chain: Chain;
}

/**
 * Closed set of risk categories every adapter reports against. This shared
 * taxonomy is what makes protocols comparable on the leaderboard/API —
 * adding a category here is a breaking change felt by every adapter, so
 * extend deliberately.
 */
export enum RiskFactorType {
  CollateralConcentration = 'collateralConcentration',
  OracleStaleness = 'oracleStaleness',
  AdminKeyActivity = 'adminKeyActivity',
  LiquidityDepth = 'liquidityDepth',
  UtilizationSpike = 'utilizationSpike',
}

export interface RiskFactor {
  /** 0-100, higher = safer, same convention as the overall score */
  value: number;
  /** this factor's share of the overall score; weights of all non-null factors must sum to 1 */
  weight: number;
  /** short, human-readable explanation of what drove this value, e.g. "top 3 depositors hold 78% of collateral" */
  detail: string;
}

/**
 * Every RiskFactorType key must be present. Use null for a factor that
 * genuinely doesn't apply to a given protocol (e.g. no oracle dependency)
 * rather than omitting the key, so the dashboard can render "N/A" instead
 * of silently dropping a column.
 */
export type RiskFactorMap = Record<RiskFactorType, RiskFactor | null>;

export interface RiskScoreResult {
  /** 0-100, higher = safer */
  score: number;
  factors: RiskFactorMap;
  computedAt: Date;
}
