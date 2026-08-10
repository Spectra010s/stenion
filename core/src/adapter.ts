import { ProtocolMetadata, RiskFactorMap, RiskScoreResult } from './types';

/**
 * Version of the Adapter contract itself (not of any protocol). Bumped only
 * when the shape of the interface below changes in a way adapters must react
 * to — e.g. a future partial-failure-aware error model. Kept as a seam so a v2
 * can be introduced without breaking every existing adapter at once; do not
 * build v2 behavior speculatively against it.
 */
export const ADAPTER_INTERFACE_VERSION = 1 as const;

/**
 * The contract every protocol adapter implements.
 *
 * Lifecycle, driven by the indexer on an interval:
 *   1. fetchRawData()       — pull raw on-chain state via Soroban RPC
 *   2. computeRiskFactors() — reduce raw state into the shared factor taxonomy
 *   3. score()               — reduce factors into a single comparable number
 *
 * These are three separate methods rather than one run() call so the
 * indexer can persist/inspect intermediate output, and so scoring logic
 * can be unit-tested against fixed factor inputs without touching RPC.
 *
 * Errors: adapters throw on failure (RPC unreachable, malformed response,
 * missing contract data, etc). The indexer is responsible for catching
 * per-adapter failures and recording a failed/stale run rather than
 * crashing the whole cycle — adapters themselves should not swallow errors.
 *
 * TRawData is intentionally adapter-specific: Blend's raw shape has
 * nothing in common with, say, YieldBlox's.
 */
export interface Adapter<TRawData = unknown> {
  readonly metadata: ProtocolMetadata;

  fetchRawData(): Promise<TRawData>;

  computeRiskFactors(rawData: TRawData): Promise<RiskFactorMap>;

  score(factors: RiskFactorMap): RiskScoreResult;
}
