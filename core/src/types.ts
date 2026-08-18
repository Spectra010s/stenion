export type Chain = 'stellar';

/**
 * Version of the scoring rulebook in METHODOLOGY.md that produced a score.
 *
 * Bumped whenever a change makes scores non-comparable with earlier stored
 * rows — a new/changed formula, threshold, or weight. It is *not* an adapter
 * version and not an API version: every adapter implements one shared rulebook
 * (METHODOLOGY.md ground rule 1), so this is a single shared constant that the
 * indexer stamps onto each run, not something an adapter chooses.
 *
 * Stored rows can't be recomputed — `risk_scores` keeps only outputs, never the
 * raw on-chain inputs — so history is not backfilled across a bump. The point of
 * this field is to make the discontinuity legible rather than silent.
 *
 * 1 — the current five-factor rulebook, including `oracleSafety` scoring price
 *     age *and* manipulation resistance. This is the first version anyone can
 *     be downstream of: the development-era history that ran under earlier,
 *     unpublished iterations was discarded rather than migrated, so no stored
 *     row carries anything but 1. See METHODOLOGY.md, "Current version".
 *
 * There is no version 2 yet. The next change that alters what a number means
 * makes one — and the machinery below (the stamp, the DB column, the chart's
 * break rendering) exists and is tested precisely so that bump is legible on
 * the day it happens, not built in a hurry then.
 */
export const METHODOLOGY_VERSION = 1 as const;

/**
 * Off-chain places a reader can go to check a protocol for themselves.
 *
 * These are the protocol's OWN properties, listed because a score is only
 * useful next to the thing it scores — not because Stenion vouches for any of
 * them. Every consumer that renders these must carry the same disclaimer that
 * covers logos: presence here is not endorsement, partnership, or any
 * relationship. The dashboard renders them `rel="noopener noreferrer nofollow"`.
 *
 * Both members are optional because they are genuinely optional facts: a
 * protocol may publish no documentation site at all. Omit what doesn't exist
 * rather than pointing at a placeholder — a dead link is worse than no link.
 */
export interface ProtocolLinks {
  /** the protocol's own front page, e.g. "https://www.blend.capital" */
  site?: string;
  /** published user/developer documentation, if any */
  docs?: string;
}

export interface ProtocolMetadata {
  /** unique slug used as the primary key across storage and the API, e.g. "blend" */
  id: string;
  name: string;
  chain: Chain;
  /**
   * Root-relative path to the protocol's logo as stored in the dashboard's
   * `public/` tree, e.g. "/assets/protocols/blend.svg".
   *
   * A PATH WE HOST, never a URL on the protocol's own CDN. Hotlinking breaks
   * whenever they reorganise their assets, and the resulting 404 shifts layout
   * on a page whose whole job is to be scannable. See CONTRIBUTING.md for the
   * asset spec (format, size, where the file goes).
   *
   * Omit when the protocol publishes no usable mark. That is a supported state,
   * not a gap: the dashboard renders a deliberate initials tile instead. Never
   * invent or redraw a mark to fill this in.
   */
  logo?: string;
  /**
   * The single on-chain contract this protocol's score is actually derived from
   * — Blend's pool, Kinetic's router. Published so a reader can open it in an
   * explorer and check the inputs behind a number rather than taking it on
   * faith; that verifiability is the whole pitch.
   *
   * MUST be the contract this adapter INSTANCE was configured with, not the
   * module default. Build it in the constructor from the resolved id (see
   * BlendAdapter) so an adapter pointed at a different pool cannot publish a
   * link to the pool it did not score.
   *
   * Stenion picks the explorer, not the adapter — this is the raw C-address,
   * and the dashboard builds the URL. That keeps the choice of explorer one
   * decision in one place instead of a string every adapter has to repeat.
   */
  contractId?: string;
  /** the protocol's own site/docs — see ProtocolLinks for the endorsement caveat */
  links?: ProtocolLinks;
  /**
   * Which adapter produced this protocol's scores, e.g. "BlendAdapter".
   * Persisted to `protocols.adapter` and published on GET /api/v1/protocol/:id
   * as the provenance label a reader uses to find the adapter in the repo.
   *
   * MUST be a string literal. Never `this.constructor.name` or anything else
   * derived from a runtime identifier: the workspace packages are bundled and
   * minified into the dashboard's serverless functions, which renames the
   * classes. Deriving it is how every row in `protocols` came to read `w`
   * instead of `BlendAdapter`/`KineticAdapter` — correct in every test and in
   * local dev, wrong in the only environment that actually writes the data.
   * It sits here with id/name/chain because it is the same kind of value:
   * a fixed string the build cannot rewrite.
   */
  adapterRef: string;
}

/**
 * Closed set of risk dimensions every adapter reports against. This shared
 * taxonomy is what makes protocols comparable on the leaderboard/API —
 * adding a dimension here is a breaking change felt by every adapter, so
 * extend deliberately.
 *
 * Naming/polarity: every member is a `*Safety` dimension scored on the same
 * scale as the overall score — 0-100, higher = safer (see RiskFactor.value).
 * The name direction deliberately matches the value direction so a factor's
 * name never disagrees with its number (a `collateralSafety` of 70 means
 * well-diversified/safe, not 70%-concentrated). Do not add a member whose
 * name implies "higher = riskier".
 */
export enum RiskFactorType {
  CollateralSafety = 'collateralSafety',
  OracleSafety = 'oracleSafety',
  AdminKeySafety = 'adminKeySafety',
  LiquiditySafety = 'liquiditySafety',
  UtilizationSafety = 'utilizationSafety',
}

/**
 * A named sub-signal inside a factor.
 *
 * Two distinct uses, deliberately both allowed:
 *
 * - **Scored component** (`value` set): a sub-score that feeds its parent
 *   factor's `value`. The dashboard can show the breakdown so a composite
 *   factor isn't an opaque single number.
 * - **Disclosure** (`value` null): a real, readable on-chain quantity we
 *   publish but deliberately do *not* score, because scoring it would invent
 *   comparability the underlying data doesn't support. `detail` carries the raw
 *   figure. See METHODOLOGY.md §2 on why deviation-bound *tightness* is
 *   disclosed rather than graded.
 *
 * A null `value` is therefore never "missing data" — it means "measured, shown,
 * and intentionally not graded."
 */
export interface RiskFactorComponent {
  /** stable machine-readable key, e.g. "priceFreshness", "deviationBound" */
  id: string;
  /** short human label for display, e.g. "Price freshness" */
  label: string;
  /** 0-100, higher = safer — or null for a disclosure-only component (see above) */
  value: number | null;
  /** what this component measured, including the raw on-chain figure it came from */
  detail: string;
}

export interface RiskFactor {
  /** 0-100, higher = safer, same convention as the overall score */
  value: number;
  /** this factor's share of the overall score; weights of all non-null factors must sum to 1 */
  weight: number;
  /** short, human-readable explanation of what drove this value, e.g. "top 3 depositors hold 78% of collateral" */
  detail: string;
  /**
   * Optional breakdown of the sub-signals behind `value`. Additive and
   * optional: a factor computed from a single signal omits it, and consumers
   * that don't know about it are unaffected. Where present, the scored
   * components (those with a non-null `value`) are what `value` was derived
   * from — this is a view into the calculation, not extra commentary.
   */
  components?: RiskFactorComponent[];
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
