/**
 * Each category's factor declarations: which factors its rulebook scores, what
 * each one is weighted, and what to call it.
 *
 * WHY THIS EXISTS. A weight is a piece of the shared rulebook — METHODOLOGY.md
 * ground rule 1 — and until now the ten numbers that make up lending's weighting
 * were written out ten times, as `const weight = 0.25` literals inside the two
 * adapters' factor methods. Nothing but review stopped one of them drifting, and
 * a drift would not have been loud: both adapters would still have produced a
 * plausible score, from two different weightings, and only the totals would have
 * disagreed. That is precisely the failure `scoreFactors` was moved into core to
 * prevent, applied to the numbers the mean is taken over rather than to the mean
 * itself.
 *
 * WHY IT IS PER CATEGORY. A weight is only meaningful against a factor set, and
 * the factor set is what a category *is* — `utilizationSafety` weighted 0.20
 * means nothing to an AMM that has no borrow cap. So this is keyed the same way
 * `CATEGORY_OPERATIONS` and `METHODOLOGY_VERSIONS` are, and for the same reason:
 * a `Record<ProtocolCategory, …>` that has gained a key is a compile error at
 * every place a new category must be registered.
 *
 * ONE ENTRY TODAY. Nothing here adds a category or a factor. What is scoped is
 * *where lending's five weights are declared*, not what any of them is — every
 * value below is the value METHODOLOGY.md has always published, and no score
 * moved when they were gathered here.
 *
 * WHY A LEAF WITH ONE TYPE-ONLY IMPORT. `weights.test.ts` and
 * `scoring.test.ts` both VALUE-import this module under `node --test`, whose
 * type-stripping loader resolves an import graph literally. The
 * `import type` below is erased before Node sees the file, so at runtime this
 * module imports nothing at all — the same shape `category.ts` and
 * `operational-state.ts` keep, and for the same reason. Don't add a value
 * import here.
 *
 * WHAT THIS IS NOT. It is not the dashboard's label table. `FACTOR_ORDER` in
 * `dashboard/app/lib/contract.ts` holds short *column headers* for a narrow
 * table, on the dashboard's own hand-maintained mirror of the API contract —
 * that mirror redeclares `RiskFactorMap` too, deliberately, so it does not
 * import core. The labels here are the canonical human names for the factors,
 * matching how METHODOLOGY.md titles each one.
 */

import type { ProtocolCategory } from './category';

/**
 * One factor's entry in a category's rulebook.
 *
 * `weight` is this factor's share of the overall score. A category's weights sum
 * to 1.00 — asserted in `weights.test.ts`, because the renormalization in
 * `scoreFactors` divides by the *observed* total and so would happily produce a
 * confident-looking number from a set that summed to 0.9.
 */
export interface FactorDeclaration {
  /** share of the overall score; a category's weights sum to 1.00 */
  readonly weight: number;
  /** canonical human name, e.g. "Oracle trustworthiness" */
  readonly label: string;
}

/** A category's published factor set, keyed by factor key. */
export interface CategoryFactors {
  /** display name of the category — also its METHODOLOGY.md section heading */
  readonly label: string;
  readonly factors: Readonly<Record<string, FactorDeclaration>>;
}

/**
 * Lending's five factors and their weights, in `RiskFactorType` order.
 *
 * These are METHODOLOGY.md's "Factor weights" table, and the two are pinned
 * against each other by `scoring.test.ts` — which parses the table out of the
 * document rather than restating it, so a drift in *either* direction fails.
 * Both adapters then pin themselves against this map, so the chain runs
 * adapter → here → the published rulebook with no hand-written copy in it.
 *
 * The weights themselves are an unvalidated judgment call and METHODOLOGY.md
 * says so; this module is where they live, not an argument that they are right.
 */
export const CATEGORY_FACTORS = {
  lending: {
    label: 'Lending',
    factors: {
      collateralSafety: { weight: 0.2, label: 'Collateral concentration' },
      oracleSafety: { weight: 0.25, label: 'Oracle trustworthiness' },
      adminKeySafety: { weight: 0.2, label: 'Admin key control' },
      liquiditySafety: { weight: 0.15, label: 'Free-liquidity depth' },
      utilizationSafety: { weight: 0.2, label: 'Utilization headroom' },
    },
  },
} as const satisfies Record<ProtocolCategory, CategoryFactors>;

/**
 * Lending's declarations, unwrapped — what the Blend and Kinetic adapters read.
 *
 * A convenience, not a second source: it is the same object
 * `CATEGORY_FACTORS.lending.factors` names. An adapter reads
 * `LENDING_FACTORS.oracleSafety.weight` where it used to write `0.25`.
 */
export const LENDING_FACTORS = CATEGORY_FACTORS.lending.factors;
