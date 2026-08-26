import type { OperationalState } from './operational-state';
import { ProtocolCategory, ProtocolMetadata, RiskFactorMap, RiskScoreResult } from './types';

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
 * 3 — adds the required `metadata.category` field and a `TCategory` parameter
 *     that scopes `operationalState`'s vocabulary to it (issue #76). Required
 *     for the same reason `operationalState` was: a protocol with no category is
 *     not a protocol we know how to score, and an optional field would default
 *     the first adapter of every future category into lending's rulebook. Every
 *     implementor must name its category; nothing infers one.
 */
export const ADAPTER_INTERFACE_VERSION = 3 as const;

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
 *
 * TCategory is the rulebook this adapter is scored under. It is threaded through
 * `metadata` and `operationalState` so those two cannot disagree: an adapter
 * declaring `category: 'lending'` is checked against lending's operation
 * vocabulary, not against the union of every category's. Defaulted to the whole
 * union so a heterogeneous list (`Adapter<unknown>[]`, the indexer's run loop)
 * still types, exactly as it did before this parameter existed.
 */
export interface Adapter<
  TRawData = unknown,
  TCategory extends ProtocolCategory = ProtocolCategory,
> {
  readonly metadata: ProtocolMetadata<TCategory>;

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
   *
   * The operations this may report are `TCategory`'s, not a global set — see
   * `CATEGORY_OPERATIONS`. `OperationalLevel` is shared across categories and is
   * the same ladder for all of them.
   */
  operationalState(rawData: TRawData): OperationalState<TCategory>;
}
