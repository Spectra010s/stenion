import type { OperationalState } from './operational-state';
import { ProtocolMetadata, RiskFactorMap, RiskScoreResult } from './types';

/**
 * Version of the Adapter contract itself (not of any protocol). Bumped only
 * when the shape of the interface below changes in a way adapters must react
 * to — a required method, a changed signature, a new error model.
 *
 * 1 — fetchRawData / computeRiskFactors / score.
 * 2 — adds the required `operationalState(raw)` method (issue #15). Required,
 *     not optional, deliberately: an optional method is one every future adapter
 *     can quietly skip, which is precisely the retrofit debt that decision was
 *     made to stop accumulating. This constant exists so that forcing every
 *     implementor to update is a labelled event rather than a silent break, and
 *     this is the first time it has been used for one.
 */
export const ADAPTER_INTERFACE_VERSION = 2 as const;

/**
 * The contract every protocol adapter implements.
 *
 * Lifecycle, driven by the indexer on an interval:
 *   1. fetchRawData()       — pull raw on-chain state via Soroban RPC
 *   2. computeRiskFactors() — reduce raw state into the shared factor taxonomy
 *   3. score()               — reduce factors into a single comparable number
 *   4. operationalState()   — classify the market's live restrictions, unscored
 *
 * These are separate methods rather than one run() call so the
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

  /**
   * The market's live operational state — which user operations its own gating
   * logic currently refuses. Published beside the score and **never scored**;
   * see `operational-state.ts` and METHODOLOGY.md for why.
   *
   * Takes the same raw data `computeRiskFactors` does, so no extra RPC round
   * trip is spent on it and the state published alongside a score is the state
   * that was true when that score's inputs were read. Synchronous for the same
   * reason: everything it needs is already in `rawData`, and an implementation
   * that has to await something is reaching for the chain a second time.
   *
   * Classify with `toOperationalState` (and `mostRestrictive` where a protocol
   * gates per reserve) rather than constructing the object by hand — that
   * function is the shared rule, and hand-rolling it is how two adapters come to
   * disagree about what "frozen" means.
   */
  operationalState(rawData: TRawData): OperationalState;
}
