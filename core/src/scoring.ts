/**
 * Shared rulebook pieces that must not differ between adapters.
 *
 * METHODOLOGY.md ground rule 1 is that a factor's formula and thresholds are
 * identical for every protocol; only *where the raw inputs are read* differs per
 * adapter. Anything in this file is a piece of that shared formula, kept in one
 * place so two adapters can't quietly drift apart. Per-protocol input reading
 * stays in the adapters — this file never reaches for chain data.
 */

import type { RiskFactorComponent, RiskFactorMap, RiskScoreResult } from './types';

/**
 * The overall score: a weighted mean of the five factors, renormalized over
 * whichever are non-null.
 *
 * This is METHODOLOGY.md's "Score model" formula and it is emphatically **not**
 * per-protocol — ground rule 1 is that one rulebook applies to every adapter.
 * It lives here, and adapters call it, so two protocols cannot drift onto two
 * different weighted means. Do not reimplement it in an adapter.
 *
 * Renormalizing by the *observed* total weight (rather than dividing by a fixed
 * 1.0) is what makes a null factor genuinely excluded: a protocol for which one
 * factor doesn't apply is graded on the factors that do apply, instead of being
 * dragged toward zero by a missing one.
 *
 * No non-null factors at all → 0, not NaN: with nothing measured we report the
 * unsafe end rather than a division by zero, matching how the individual
 * factors treat "can't assess" (METHODOLOGY.md §1).
 */
export function scoreFactors(factors: RiskFactorMap): RiskScoreResult {
  let weighted = 0;
  let totalWeight = 0;
  for (const factor of Object.values(factors)) {
    if (!factor) continue;
    weighted += factor.value * factor.weight;
    totalWeight += factor.weight;
  }
  const score = totalWeight === 0 ? 0 : Math.round(weighted / totalWeight);
  return { score, factors, computedAt: new Date() };
}

/**
 * Upper bound on the "price is effectively dead" threshold, in seconds.
 *
 * `oracleSafety` anchors freshness to each protocol's own configured max price
 * age (see `freshnessWindow`). That anchoring is deliberately *capped* rather
 * than taken at face value: a protocol that configures a very loose max age —
 * K2's per-asset value is 43200s (12 hours) — would otherwise score better for
 * tolerating staler prices, which is the wrong incentive for a platform
 * protocols are ranked by.
 *
 * The cap is an **unvalidated judgment call**, retained deliberately and
 * flagged as such in METHODOLOGY.md §2. There is no external framework fixing
 * it at one hour; it is the one Stenion-chosen constant left in this factor.
 */
export const STALE_CEILING_SECONDS = 3600;

/**
 * The freshness grading window for one reserve.
 *
 * - `fresh`: the protocol's own publish/refresh interval. A price younger than
 *   one interval is as current as that feed can be, so it scores 100.
 * - `dead`: the protocol's own declared max acceptable price age, capped at
 *   `STALE_CEILING_SECONDS`.
 *
 * Both inputs are the protocol's own on-chain parameters, the same anchoring
 * pattern `utilizationSafety` uses. Which parameter each resolves to is a
 * documented per-protocol fact (METHODOLOGY.md §2), not a per-protocol rule.
 *
 * Degenerate configs are handled rather than trusted: a missing or nonsensical
 * value collapses to a window that still orders newer prices above older ones.
 */
export function freshnessWindow(
  resolutionSeconds: number,
  protocolMaxAgeSeconds: number,
): { fresh: number; dead: number } {
  const fresh = Number.isFinite(resolutionSeconds) && resolutionSeconds > 0 ? resolutionSeconds : 0;
  const declared =
    Number.isFinite(protocolMaxAgeSeconds) && protocolMaxAgeSeconds > 0
      ? protocolMaxAgeSeconds
      : STALE_CEILING_SECONDS;
  const dead = Math.min(declared, STALE_CEILING_SECONDS);
  // A feed whose publish interval is at or beyond its own staleness limit gives
  // no usable range; widen by one interval so the score still degrades with age
  // instead of collapsing to a step function.
  return dead > fresh ? { fresh, dead } : { fresh, dead: fresh + Math.max(1, fresh) };
}

/**
 * Minimum share of a pool's own total supplied USD for a reserve to be scored
 * by `liquiditySafety` (§4) and `utilizationSafety` (§5).
 *
 * Both factors select the WORST reserve, so a reserve holding almost nothing can
 * set a protocol's published number. That is a real misreading: on the
 * 2026-08-16 K2 snapshot a $3.00 PYUSD reserve was the binding reserve on both
 * factors across a $1,571 pool. Nobody's capital was meaningfully exposed to it.
 *
 * **This 0.5% is an unvalidated judgment call.** Unlike `minPositionUsd` below
 * there is no external or on-chain framework fixing it — it is, with
 * `STALE_CEILING_SECONDS`, one of the two Stenion-chosen constants left in the
 * continuous factors, and it is flagged as such in METHODOLOGY.md §4.
 *
 * It is deliberately set at the LOW end of the band that works. Excluding a
 * small but genuinely-used reserve is a worse error than leaving a dust one in:
 * the first hides real risk, the second only reports a misleading number. 0.25%
 * would have flipped on the live K2 reserve between two consecutive days
 * ($3.00 then, $4.00 now, against a $3.85 line); 0.5% clears it both times.
 */
export const MIN_RESERVE_POOL_SHARE = 0.005;

/** Whether a reserve is large enough to be scored, and the figures it was judged on. */
export interface ReserveSize {
  /** true when §4/§5 should score this reserve */
  scored: boolean;
  /** its supplied value in USD, or null when it could not be priced */
  suppliedUsd: number | null;
  /** its share of the pool's total supplied USD, or null when that can't be computed */
  share: number | null;
}

/**
 * The minimum-size filter for §4/§5, applied identically to every protocol.
 *
 * A reserve is scored if EITHER test passes, and excluded only when both fail:
 *
 * - **(A) the protocol's own floor** — `suppliedUsd >= minPositionUsd`, the
 *   smallest exposure the protocol itself declares worth having. Where a
 *   protocol declares one this is a real on-chain anchor, the same pattern §5's
 *   `cap` uses; pass null where it declares none.
 * - **(B) the relative floor** — `share >= MIN_RESERVE_POOL_SHARE`.
 *
 * The OR is load-bearing, because each leg covers a demonstrated failure of the
 * other. Absolute-only breaks a small pool: any floor sized for a real market
 * excludes every reserve of K2's $1.5k pool, sending both factors to
 * can't-assess and DROPPING its score. Relative-only breaks a large one: 0.5%
 * of Blend's $186M is ~$930k, so a reserve holding half a million dollars of
 * real capital would be silently dropped — leg A keeps it at $5.
 *
 * Deliberate behaviours, all erring toward INCLUSION:
 *
 * - **No prices at all → nothing is filtered.** §4/§5 are otherwise pure balance
 *   ratios that work with the oracle down; when it is, this degrades to exactly
 *   the pre-filter behaviour rather than refusing to score. Documented in
 *   METHODOLOGY.md §4 because it means those two numbers mean something slightly
 *   different during an oracle outage.
 * - **An individual unpriced reserve is kept**, not treated as zero-value. We
 *   could not measure it, which is not the same as it being empty.
 *
 * Note the filter cannot empty the scored set on any real pool: shares sum to 1,
 * so the largest is always >= 1/n, which clears 0.5% for any n <= 200. Callers
 * must still route a fully-excluded pool through their existing can't-assess
 * path — see the counter placement in each adapter.
 */
export function sizeReserves(
  suppliedUsd: readonly (number | null)[],
  minPositionUsd: number | null,
): ReserveSize[] {
  let total = 0;
  for (const usd of suppliedUsd) {
    if (usd !== null && Number.isFinite(usd) && usd > 0) total += usd;
  }
  // Nothing priced anywhere: the filter has no denominator, so it does not run.
  if (total <= 0) return suppliedUsd.map(() => ({ scored: true, suppliedUsd: null, share: null }));

  const floor =
    minPositionUsd !== null && Number.isFinite(minPositionUsd) && minPositionUsd > 0
      ? minPositionUsd
      : null;

  return suppliedUsd.map((usd) => {
    if (usd === null || !Number.isFinite(usd)) {
      return { scored: true, suppliedUsd: null, share: null };
    }
    const share = usd / total;
    const scored = (floor !== null && usd >= floor) || share >= MIN_RESERVE_POOL_SHARE;
    return { scored, suppliedUsd: usd, share };
  });
}

/** A reserve `sizeReserves` set aside, carried far enough to be disclosed. */
export interface ExcludedReserve extends ReserveSize {
  /** the reserve's asset contract address */
  asset: string;
  /**
   * What this reserve would have contributed to the factor had it been scored —
   * the number the filter suppressed. Null only when it had none to contribute
   * (e.g. §5's no-configured-cap case).
   */
  wouldHaveScored: number | null;
}

/**
 * The disclosure for reserves the minimum-size filter set aside.
 *
 * Excluding a reserve from scoring is not the same as it not existing, so the
 * excluded set is published rather than silently dropped — as a `value: null`
 * component, the established form for "measured, shown, deliberately not graded"
 * (METHODOLOGY.md §2c). It names each reserve, its supplied USD, its share of
 * the pool, and crucially **the score it would have contributed**, so a reader
 * can see the number we suppressed and disagree with us about it.
 *
 * Returns an empty object, not an empty array, so the caller can spread it: a
 * factor that excluded nothing publishes no components at all.
 */
export function excludedComponent(
  excluded: readonly ExcludedReserve[],
  measures: string,
): { components?: RiskFactorComponent[] } {
  if (excluded.length === 0) return {};
  const listed = excluded
    .map((e) => {
      const usd = e.suppliedUsd === null ? 'unpriced' : `$${formatUsd(e.suppliedUsd)}`;
      const share = e.share === null ? 'unknown share' : `${(e.share * 100).toFixed(2)}% of pool`;
      const would =
        e.wouldHaveScored === null
          ? 'would not have scored'
          : `would have scored ${e.wouldHaveScored}`;
      return `${e.asset.slice(0, 6)}… ${usd} (${share}), ${would}`;
    })
    .join('; ');
  return {
    components: [
      {
        id: 'excludedReserves',
        label: 'Reserves excluded as too small',
        value: null,
        detail: `${excluded.length} reserve(s) below the minimum scorable size, so not graded for ${measures}: ${listed}`,
      },
    ],
  };
}

/** Two decimal places under $1000, none above — enough to tell $3.00 from $36.56. */
function formatUsd(value: number): string {
  return value >= 1000 ? Math.round(value).toLocaleString('en-US') : value.toFixed(2);
}
