import { ProtocolMetadata, RiskFactorMap, RiskScoreResult } from './types';

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
