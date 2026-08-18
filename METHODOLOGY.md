# Stenion Scoring Methodology

This document is the **source of truth for how every safety factor is calculated.**
It exists so that anyone — including the protocols being scored — can see, verify, and
challenge the actual rules, not just the output numbers. Every formula below is extracted
directly from the shipped code (currently [`adapters/blend.ts`](adapters/blend.ts) and
[`adapters/kinetic.ts`](adapters/kinetic.ts)); this file is not a summary of intent, it is
the rulebook the adapters must implement.

**One formula, per-protocol data sources.** Every factor's formula, scale, and thresholds
are fixed here and identical across protocols. What legitimately differs per adapter is only
_where the raw inputs are read on-chain_ — e.g. Blend reads a per-reserve `max_util` cap,
while Kinetic (K2), being Aave-V3-style, has no such cap and instead anchors the same
utilization formula to its own `OPTIMAL_UTILIZATION_RATE` (see §5). The _anchoring pattern_
("grade against the protocol's own on-chain parameter") is the invariant; the specific
parameter that pattern resolves to is a documented per-protocol fact, not a new threshold.

If the code and this document ever disagree, that is a bug — open an issue (see
[Disputing or changing a threshold](#disputing-or-changing-a-threshold)).

---

## Current version

**Methodology v1** — the rulebook described by this document, in full, including `oracleSafety`
scoring both price freshness and manipulation resistance (§2), and the minimum-size filter §4
and §5 select reserves through ([The minimum-size filter](#the-minimum-size-filter)).

**Versioning begins here.** `methodology_version = 1` is the only version this rulebook
defines, and the only one any stored row will carry. A version 2 was briefly live in the code
— stamped onto runs between 2026-08-14 11:25 and 2026-08-18 11:30 UTC, before the rulebook was
flattened back to v1 — and that history is discarded rather than migrated, for the same reason
the development-era history was: it was computed under a rulebook that no longer exists, and
nobody was downstream of it. After that discard there is no v1-versus-v2 boundary in
`risk_scores`, and none to look for.

### Earlier development history was discarded, not migrated

Before this point Stenion accumulated a few weeks of scored runs during development, under
earlier iterations of these rules. **That history was deleted rather than carried forward, and
this is a deliberate, recorded choice rather than a silent one.** Three reasons, stated plainly:

- **It contained scores computed under two known bugs**, since fixed. Those numbers were wrong
  under their own rulebook, not merely scored under a different one.
- **It predates the oracle robustness work** (§2), so its `oracleSafety` values measured price
  age alone — a signal we now consider misleading rather than merely incomplete.
- **Nobody was downstream of it.** Every row came from our own cron during development; no
  external consumer had been built against the API, and the only reader of the history was our
  own score chart. Marking a discontinuity in a dataset nobody had read would have been
  bookkeeping, not disclosure.

A clean history starting from a rulebook we actually stand behind is more honest than a
marked-up one carrying forward numbers we know were wrong. **This is the last time that
reasoning applies.** From here on, history is never deleted and never backfilled — the version
stamp exists so a change is labeled instead.

### What bumps the version, going forward

**Bump when a change alters what a number means** — a factor starting or stopping measuring
something, a threshold's anchor changing, a re-weighting, or any formula change that moves
scores for unchanged on-chain state. **Don't bump** for a fix that makes the implementation
match the rule already documented here (the stored scores were wrong, not scored under a
different rulebook — say so in the changelog instead), for adding a protocol or an adapter, or
for wording, disclosure, and presentation changes. The test is simple: if comparing an old score
to a new one would mislead, bump; if the old score was just incorrect under this same rulebook,
don't.

### Scores across a boundary are not comparable

No boundary survives in the stored data — the v2 rows above were discarded — but the machinery
that marks one is live and tested, because the first real bump must be legible on the day it
happens rather than built in a hurry then:

- The indexer stamps `risk_scores.methodology_version` from `METHODOLOGY_VERSION` in
  [`core/src/types.ts`](core/src/types.ts) at write time. An adapter has no say in it.
- The score-history chart on each protocol page **breaks the line** at a version change rather
  than drawing through it, and the run list labels the break. Both paths are covered by fixture
  tests, since live data cannot exercise them.
- The version is returned on every history point and on the protocol detail from
  `GET /api/v1/protocol/:id`. To check which rulebook produced a stored score, read that column
  — don't infer it from the date.

History is **not backfilled across a bump, and cannot be** — `risk_scores` stores only outputs
(the score and the factor map), never the raw on-chain inputs a run was computed from, so no
one, including us, can recompute an old row under new rules.

---

## Ground rules (non-negotiable)

1. **The same formula applies to every protocol, with no exceptions.** A factor's formula
   and its thresholds are fixed here, in one shared place. They do not vary per protocol,
   per adapter, or per anything else.
2. **Payment never changes a threshold or a formula.** Protocols can pay for visibility,
   speed, or private tooling — never for a better number. A paid tier cannot move a
   threshold, reweight a factor, or alter a curve. The _only_ thing that changes a
   protocol's output is its own real, on-chain data.
3. **Different protocols can and should score differently.** That is the point. What must
   never differ is the _rule_ being applied. Blend scoring 54 and a hypothetical protocol
   scoring 80 is a result of their data, not of two different rulebooks.
4. **No fabricated numbers.** Where real data genuinely isn't available for a factor, the
   score uses a clearly-flagged neutral baseline (called out explicitly below) — never an
   invented, plausible-looking value.
5. **AI never sets a score.** Any AI feature only explains or summarizes the numbers these
   formulas produce. It never generates an independent risk assessment.

---

## Score model

- **Overall score: 0–100, higher = safer.** API/field name `safetyScore`.
- **Every factor is on the same scale: 0–100, higher = safer.** Factor names end in
  `*Safety` so a name never disagrees with its number — a `collateralSafety` of 70 means
  well-diversified (safe), not "70% concentrated."
- The overall score is a **weighted mean of the five factors**, renormalized over whichever
  factors are non-null (so a genuinely inapplicable factor doesn't drag the score toward
  zero rather than being excluded):

  ```
  safetyScore = round( Σ(factor.value × factor.weight) / Σ(factor.weight) )
  ```

A factor may publish a **`components`** breakdown — the sub-signals behind its value.
Components with a numeric `value` are what the factor was computed from; components with
a `null` value are **disclosures**: real, readable on-chain quantities we publish but
deliberately do not grade, because scoring them would invent comparability the data does
not support (see §2c and §2d). A null component is never missing data.

### Methodology versions

Every scored run is stamped with the rulebook version that produced it
(`risk_scores.methodology_version`, from `METHODOLOGY_VERSION` in
[`core/src/types.ts`](core/src/types.ts)), and it is surfaced on the API's protocol detail
and on each history point. The changelog:

| Version | Effective | Change                                                                                                                                                                                                                 |
| ------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**   | initial   | The five-factor model as documented here. `oracleSafety` scores price freshness **and** manipulation resistance (§2); `liquiditySafety`/`utilizationSafety` score only reserves clearing the minimum-size filter (§4). |

One row, and that is the point: v1 is where versioning starts, not where it started counting
again. Development-era history under earlier iterations of these rules was discarded rather
than migrated — what that was and why it was deleted is at the top of this document, along with
what does and doesn't warrant a bump. See [Current version](#current-version).

#### Corrections that did not bump the version

Fixes where the **implementation disagreed with this document** and the document was right. The
rulebook did not change, so these are not version boundaries and stored scores remain comparable
across them — but they are recorded here rather than left silent, because a score did change shape
even if no published number moved.

> The entry below was verified against the development-era history that has since been
> discarded (see [Current version](#current-version)), so its row counts are no longer
> re-checkable. It is kept as the record of a correction, not as a live claim about stored
> data. The fix itself is in the shipped v1 rulebook.

| Date (UTC)   | Correction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2026-08-16` | `liquiditySafety` (§4) and `utilizationSafety` (§5) returned **100** when no reserve qualified for their minimum, in both adapters. Both are a minimum over a filtered set of reserves; over an empty set that is undefined, not the top of the scale — so an unassessable pool published "maximally safe" from no data, contrary to ground rule 4. Both now return **0**, matching `collateralSafety`'s existing treatment of the same case. **No published score was affected:** the path had never executed — verified by scanning the entire stored history of both protocols for the signature the defect leaves in a factor's `detail` (a `worst reserve (…)` naming no asset, since `worstAsset` stayed empty when nothing was measured), with zero matches. Re-checked on `2026-08-16` against 1,923 rows; `liquiditySafety` has ranged 20–34 and `utilizationSafety` 10–18 across that history, never approaching the 100 the empty path would have published. |

#### Amendments folded into v1

Changes to the rulebook made **while v1 was still being finalized as the comparability
baseline** — before any surviving stored history existed. These are not version boundaries: v1
is defined as the rulebook this document describes, and these are part of that definition
rather than a departure from it. None of them left a step in a published history, because the
history they predate was discarded rather than carried forward. Each gets a row anyway, so that
what v1 means is traceable rather than assumed: "no bump required" does not mean "no record
required".

**This section closes when the next change lands.** From that point the rule in
[What bumps the version](#what-bumps-the-version-going-forward) applies without exception, and
a change that alters what a number means bumps to v2.

| Date (UTC)   | Amendment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `2026-08-18` | §4 and §5 gained the [minimum-size filter](#the-minimum-size-filter): both now select the worst reserve only among reserves clearing the protocol's own declared minimum exposure **or** 0.5% of the pool's supplied USD. This changes what the two factors measure, which is why it is recorded rather than treated as a correction. **No live score moved when it landed** — verified against both protocols on the day: Blend excludes nothing (its smallest reserve is ~$3.4M against a $5.00 `min_collateral`), and K2's dust reserve had already stopped being its worst reserve. **What it changes, measured on the frozen 2026-08-16 snapshot:** `liquiditySafety` 34 → 44 and `utilizationSafety` 18 → 30 (score 24 → 28), by excluding a $3.00 reserve holding 0.19% of a $1,571 pool. |

**History is not backfilled across a version bump, and cannot be.** `risk_scores` stores
only outputs — the score and the factor map — never the raw on-chain inputs a run was
computed from, so an old row cannot be recomputed under new rules by us or by anyone. The
discontinuity is real and permanent; the version stamp exists so it is legible rather than
appearing as an unexplained step in a chart.

### Factor weights

| Factor              | Weight   |
| ------------------- | -------- |
| `oracleSafety`      | 0.25     |
| `collateralSafety`  | 0.20     |
| `adminKeySafety`    | 0.20     |
| `utilizationSafety` | 0.20     |
| `liquiditySafety`   | 0.15     |
| **Total**           | **1.00** |

**Worked example (live Blend Fixed V2 pool, 2026-08-14, methodology v1):**
`70×0.20 + 100×0.25 + 40×0.20 + 22×0.15 + 14×0.20 = 53.1 → 53`.

> **Weights are an unvalidated judgment call, not an external fact.** `oracleSafety` carries the most
> weight because an untrustworthy price silently poisons every other measurement —
> collateral value, utilization and liquidity are all priced off it. Liquidity carries the
> least because it partly overlaps utilization. There is no external framework these exact
> weights are anchored to yet — they are open to challenge like any threshold below.
>
> **Oracle robustness was folded into `oracleSafety` rather than given its own factor**,
> partly for this reason: a sixth member would have forced a redistribution across all five,
> layering a second unanchored judgment call on top of one already flagged as unanchored. The
> taxonomy in [`core/src/types.ts`](core/src/types.ts) stays at five factors.

---

## The five factors

For each factor: the exact raw on-chain data that feeds it, the exact formula, and why the
thresholds are what they are (anchored to an external/on-chain value where one exists,
labeled an unvalidated judgment call where none does).

Two fixed-point scalars appear throughout, taken from
`blend-contracts-v2/pool/src/constants.rs`:

- `SCALAR_7 = 10^7` — decimals for `c_factor`, `l_factor`, `util`, `max_util`.
- `SCALAR_12 = 10^12` — decimals for `d_rate`, `b_rate`.

A reserve's human-unit totals (used by several factors) are:

```
supplied = b_supply × b_rate / (SCALAR_12 × 10^assetDecimals)
borrowed = d_supply × d_rate / (SCALAR_12 × 10^assetDecimals)
```

---

### 1. `collateralSafety` — collateral concentration (weight 0.20)

**What it measures:** how spread out the pool's supplied value is across its reserves. A
pool whose value sits in one asset is far more exposed to a single de-peg or liquidation
cascade than a balanced one.

**Raw on-chain data (Soroban RPC, no third party):**

- Per reserve, from the pool contract's persistent storage:
  - `ResData` entry → `b_supply`, `b_rate`
  - `ResConfig` entry → `decimals`
- Oracle price per asset: `lastprice(Asset::Stellar(address))` on the pool's configured
  oracle contract → `price`, and the oracle's `decimals()`.
- USD value per reserve: `suppliedUsd = supplied × (price / 10^oracleDecimals)`.

**Formula** — a normalized Herfindahl–Hirschman Index (HHI) over each reserve's share of
total supplied USD:

```
Let vᵢ = supplied USD of reserve i (only priced reserves with vᵢ > 0)
    n  = number of such reserves
    sᵢ = vᵢ / Σv                 (each reserve's share)
    HHI = Σ sᵢ²                   (ranges from 1/n for a perfectly even split, to 1)

collateralSafety = clamp( (1 − HHI) / (1 − 1/n) × 100 , 0, 100 )
```

Edge cases: **0 priced reserves → 0** (can't assess, treated as unsafe rather than
guessed); **exactly 1 priced reserve → 0** (fully concentrated by definition).

**Why HHI / why these anchors:** HHI is the standard, widely-published concentration
measure (used by competition regulators and in portfolio analysis) — an _external_
framework rather than a Stenion invention. The anchoring points are not arbitrary either:
`1/n` (a perfectly even split) is the mathematically safest achievable state for `n`
reserves and maps to 100; `1` (everything in one asset) is the worst and maps to 0.
Normalizing by `1/n` means the score grades a pool against the best _it_ could do given how
many reserves it has, not against an arbitrary constant.

---

### 2. `oracleSafety` — price trustworthiness: freshness _and_ manipulation resistance (weight 0.25)

> **Why this factor is not just price age.** An age-only oracle factor scores a fresh but
> manipulated price 100 — which is precisely the configuration behind the February 2026
> YieldBlox/Blend incident. Freshness alone is not a weak signal on that axis, it is a
> misleading one, so this factor takes the binding constraint of freshness and manipulation
> resistance. Earlier development-era scores did measure age alone; that history was
> discarded rather than carried forward, and no stored row was computed that way — see
> [Current version](#current-version).

**What it measures:** whether the prices this pool actually runs on can be trusted. Two
things must both hold, and the factor takes **the binding constraint of the two** — a
bounded stale price and a fresh unbounded price are both untrustworthy, for different
reasons:

```
oracleSafety = min( priceFreshness , deviationBound )
```

Both sub-signals take the **worst reserve**, the same convention as every other factor:
the binding constraint is the single weakest reserve, and averaging would hide it. Both
are published in the factor's `components` array so the composite is never an opaque
number.

**Every reserve at the binding value is named, not one of them.** When several reserves tie
on a sub-signal the `detail` lists all of them; when _all_ of them tie it says so rather than
singling one out. This is reporting only — the published value is the same minimum either way
— but it is load-bearing for reading a score honestly. Blend prices its whole pool from one
aggregator publish round, so its reserves carry identical ages and **always** tie on freshness.
Naming one of them would make an iteration-order artifact read as a diagnosis, and a reserve
name that is really a tie-break is worse than no name at all.

#### 2a. `priceFreshness` — how stale the worst price is

**Raw on-chain data (Soroban RPC):** per reserve, the price's publish `timestamp` from
the method the protocol's own pool calls; `fetchedAt` is the adapter's read time;
`age = fetchedAt − timestamp`.

```
fresh = the protocol's own publish/refresh interval        → 100
dead  = min( protocol's own max acceptable price age, 3600s ) → 0

priceFreshness = clamp( (age − dead) / (fresh − dead) × 100 , 0, 100 )
```

No usable price for a reserve → **0** (a missing feed is maximally unsafe, not skipped).

**Both anchors are the protocol's own on-chain parameters**, the same anchoring pattern
`utilizationSafety` uses. Which parameter each resolves to is a documented per-protocol
fact, not a per-protocol rule:

| Protocol         | `fresh` source                                                                                                                                     | `dead` source                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Blend**        | `oracles()[i].resolution` on the pool's oracle aggregator (**300s**)                                                                               | `max_age()` on the same aggregator (**900s**)                                                          |
| **Kinetic (K2)** | `PriceCacheTtl` on the price oracle (**30s**) — the window inside which K2 itself treats a price as current; K2 exposes no publish-interval getter | the **tighter** of the per-asset `max_age` (43200s) and the global `price_staleness_threshold` (3600s) |

Taking the tighter of two limits a protocol declared is not a Stenion threshold — both
numbers are K2's, and the binding one is the one that governs.

> **⚠️ The 3600s cap on `dead` is the one Stenion constant left in this factor, and it is
> an unvalidated judgment call.** Anchoring purely to a protocol's own max age would
> mean a protocol scores _better_ for tolerating staler prices — K2's per-asset `max_age`
> is 12 hours, which would make a six-hour-old price score ~50. That is the wrong
> incentive for a platform protocols are ranked by, so the anchor is capped. There is no
> external framework fixing the cap at one hour; it is open to challenge like any
> threshold here. It lives in one place, `STALE_CEILING_SECONDS` in
> [`core/src/scoring.ts`](core/src/scoring.ts).

#### 2b. `deviationBound` — can a single update move the price arbitrarily far?

**Binary, not a curve:**

```
deviationBound = 100  if the pool's price path bounds a single-step move, and that bound is armed
                 0    otherwise
```

| Protocol         | Bounded when                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Blend**        | the aggregator's per-asset `max_dev` satisfies `0 < max_dev < 100` — the contract's own condition in `oracle-aggregator/src/price_data.rs` |
| **Kinetic (K2)** | `max_price_change_bps > 0` **and** `get_last_price(asset)` returns a present, non-zero baseline                                            |

**Why the extra clause for K2.** The two contracts fail in opposite directions when there
is no prior price to compare against. Blend's aggregator fails **closed**: with no older
record it returns `None` and the reserve simply cannot be priced. K2's
`validate_price_change` fails **open**: with no stored baseline it returns `Ok` and lets
any price through, so a configured bound with no baseline is inert. Checking the baseline
is what distinguishes a breaker that is configured from one that is actually armed — and
the no-baseline case is exactly the newly-listed-thin-asset scenario that the YieldBlox
incident ran through.

**Why this is anchored, and what it isn't.** The scored quantity is the presence and
arming of a bound, and it is read from the protocol's own on-chain configuration — the
same pattern as `utilizationSafety`'s `max_util`. `max_dev = 0` does not mean "a tight
bound of zero"; the aggregator's own type documentation says _"If this is 0, the oracle
will just fetch the last price within the resolution time"_ — the check is skipped
entirely. That is provably the condition that permits an unbounded single-step move.

**Base assets are excluded, not scored 0.** The Blend aggregator's `lastprice`
short-circuits its `Base` and `BaseAssets` to exactly `1.0` at the current ledger time
without consulting any upstream feed. Those reserves have no oracle-derived price to
grade, so they are dropped from both sub-signals and the count of excluded assets is
disclosed. (Whether such a peg _holds_ is a real risk — but it is a collateral/peg
question, not an oracle-robustness one, and inventing a number for it here would be the
kind of fabrication ground rule 4 forbids.)

#### 2c. Per-feed price ages are disclosed, never scored

`priceFreshness` grades the **worst** reserve, which is the right thing to score but hides the
**spread** — and on real data the spread is the informative part. A factor value of 0 reads as
a general condition of the oracle. "Two feeds have not updated in hours while two others update
every few seconds, through one contract and one source" is a specific, checkable statement
about which feeds are being maintained, and it is the one a depositor can act on.

So every reserve's price age is published as a **disclosure-only component** (`priceAges`,
`value: null`), ordered oldest-first, alongside a count of how many exceed **the protocol's own
declared staleness limit** — Blend's aggregator `max_age`, K2's `price_staleness_threshold`.
The count is therefore a statement about the protocol's own rules, not about a Stenion line. A
reserve with no usable price at all sorts as the oldest rather than the freshest.

It is not scored, because it would double-count: these are the same ages `priceFreshness` was
computed from, republished so that the grading can be checked rather than taken on faith. It is
published on healthy pools as well as unhealthy ones — a disclosure that appears only where
trouble is expected gives a reader no baseline to compare against.

#### 2d. Bound tightness is disclosed, never scored

The raw bound is published as a **disclosure-only component** (`value: null`) — visible,
never graded. Grading it would invent comparability the underlying data does not support:

|                     | Blend `max_dev`                                              | K2 `max_price_change_bps`                                 |
| ------------------- | ------------------------------------------------------------ | --------------------------------------------------------- |
| Scope               | per asset                                                    | global                                                    |
| Units               | whole percent (`60` = 60%)                                   | basis points (`2000` = 20%)                               |
| **Baseline**        | the previous **upstream record**, one `resolution` step back | `get_last_price` — the last price the contract **served** |
| **Bounds move per** | **publish interval (300s)**                                  | **query** — no fixed time spacing                         |

Both compute `|new − old| / old`, and the unit difference normalizes trivially. The
baseline difference does not: "20% per arbitrary interval" and "60% per five minutes" are
different quantities, so the intuitive reading that K2's bound is three times tighter than
Blend's is unsound. Publishing the numbers side by side without a score is the honest
treatment.

#### What was considered and deliberately rejected

Recorded so these are not re-proposed as improvements later. Each was investigated against
the February 2026 YieldBlox incident — the test being whether it would have distinguished
the manipulated price from a legitimate one **at the time**, since a signal that looks
sophisticated but would not have caught the actual attack is worse than none: it
manufactures confidence.

- **Filtering `oracleSafety` by reserve size, the way §4/§5 are filtered.**
  **Rejected on principle, not on impact** — and the distinction it turns on is the reason
  §4/§5 may be size-filtered while this factor may not:

  > **§4 and §5 measure current state. §2 measures a vulnerability.** How drained a reserve is
  > right now means little when the reserve holds $4, because the exposure is capped by what is
  > actually in there. Whether a price can be trusted is not capped that way, because the
  > attacker's move is to _grow_ a position against the mispriced asset. **A dust reserve with a
  > stale price is an open door, not a small room.** Its balance today says nothing about what
  > can be borrowed against it tomorrow.

  And it would blind the factor to the exact scenario it exists for: a newly-listed thin asset
  with a bad price is the shape the February 2026 YieldBlox incident ran through, which §2b
  already names. A filter that removes thin assets from an oracle-trust factor removes the
  attack it was built to catch.

- **A Stenion-computed deviation from the oracle's price history** (calling Reflector's
  `prices(asset, N)` ourselves and comparing the latest price to a trailing mean).
  **Rejected — this would have made the platform actively worse.** It is a _coincident_
  indicator, not a leading one: it can only fire while an attack is in progress, and only
  if the indexer happens to sample inside the manipulation window. The indexer runs every
  five minutes, so the overwhelmingly likely outcome is that it reads clean and Stenion
  publishes a confident `oracleSafety` of 100 _during_ an active exploit. It also measures
  a code path the pools never consult: neither Blend's aggregator nor K2's oracle exposes
  price history to the pool at all. A signal that is usually silent during the event it
  claims to detect, computed over data the protocol does not use, is not a weak signal —
  it is a misleading one.
- **TWAP.** Not available: the deployed Reflector contracts (`version() == 6`) expose no
  `twap` method — the exported interface is `base, assets, decimals, resolution, price,
prices, lastprice, last_timestamp, history_retention_period, …`. Earlier Reflector
  versions had one; the live contracts do not. Neither protocol's oracle passes history
  through either. And on the merits it would not have helped: the attacker held the only
  trades in the window, so a short TWAP over a dead order book _is_ the manipulated price.
- **Oracle type / provider identity** ("is it Reflector?"). Zero discriminating power: the
  exploited pool and the healthy Blend pool both price through Reflector-family feeds via
  the same `oracle-aggregator` contract family. What differed was configuration, not
  provider.
- **Number of upstream sources.** Both pools had exactly one upstream oracle, so it would
  not have separated them. It is also not comparable across protocols: a count is only
  readable where a contract happens to publish one (K2's upstream RedStone adapter exposes
  `unique_signer_threshold() == 3`; Reflector's node consensus is not exposed on-chain at
  all), so counting would systematically understate feeds that keep their aggregation
  internal.
- **SDEX order-book depth via Horizon.** Conceptually the right quantity — thin market
  depth is what made the manipulation cheap — and mechanically readable. Rejected for now
  on three grounds: order books are trivially spoofable with walls that are never hit; it
  only applies to assets priced off the Stellar DEX; and it cannot be validated
  retroactively, because the exploited market has since been rebuilt. Tracked as a
  candidate in [`ROADMAP.md`](ROADMAP.md) rather than shipped on intuition.

#### What this factor would have said on 2026-02-22

Running the shipped adapter against the exploited pool and the healthy one today, same
rulebook, no special-casing:

| Pool                                        | `priceFreshness` | `deviationBound`                                    | `oracleSafety` |
| ------------------------------------------- | ---------------- | --------------------------------------------------- | -------------- |
| Blend Fixed V2 (`CAJJZSGM…`)                | 100              | 100 — all reserves bounded (`max_dev` 60/20/20)     | **100**        |
| YieldBlox (`CCCCIQSD…`, the exploited pool) | 100              | 0 — XLM and AQUA carry `max_dev: 0`, check disabled | **0**          |

Both pools' prices are fresh, so an age-only factor scores both 100. This factor separates
them, and on the axis that actually failed.

> **⚠️ Two honest limits on that claim, stated rather than glossed:**
>
> 1. **The historical `max_dev` is a deduction, not a reading.** Soroban RPC serves no
>    historical contract state, so the exact value USTRY carried on 2026-02-22 cannot be
>    read back. What is verifiable: the deployed aggregator skips the deviation check
>    entirely when `max_dev` is `0` or `≥ 100`, and rejects the price outright otherwise —
>    so a ~100× single-step move is arithmetically incapable of passing any bound between
>    1 and 99. USTRY's bound must therefore have been disabled. USTRY today carries
>    `max_dev: 10`; XLM and AQUA in that same live contract still carry `0`.
> 2. **Semantics were verified against the public repo, not that binary.** The exploited
>    pool's aggregator (wasm `8cf43882…`) and Blend Fixed V2's (`41df0489…`) are different
>    builds. Both export the same eleven functions, and the `max_dev` logic above is read
>    from [blend-capital/oracle-aggregator](https://github.com/blend-capital/oracle-aggregator);
>    it has not been decompiled from the exploited pool's specific binary.

> **⚠️ K2's enforcement is an inference, held to the same standard.** `max_price_change_bps`
> is enforced on every return path of `get_asset_price_data` in K2's audited source
> (`code-423n4/2026-04-k2`), and the deployed wasm contains both the `max_price_change_bps`
> and `PriceChangeTooLarge` symbols. But the live `kinetic_router` does not call that
> method — it calls `get_asset_prices_vec_fresh`, one of nine functions present in the
> deployed oracle and absent from the audited source, whose source is not public. The
> audited sibling `get_asset_prices_vec` does enforce the breaker, and all three methods
> return identical data today. We score it as enforced on that basis. **That is an
> inference, not a verification**, and it is written up as a finding in its own right —
> see the Kinetic entry in the registry.

---

### 3. `adminKeySafety` — admin signer structure + activity (weight 0.20)

**What it measures:** how much unilateral, live control a single party has over the pool. A
lone hot key that can reconfigure the pool is the sharpest centralization risk; multisig
and inactivity are safer.

**Raw on-chain data:**

- The admin **address** comes from the pool contract's instance storage (`Admin`, or
  `Config.admin`) via Soroban RPC.
- If the admin is a **keypair account** (`G…`), signer structure and activity come from
  **Horizon** (official Stellar infra, not a third party):
  - `GET /accounts/{address}` → `thresholds.high_threshold`, `signers[]` (→ `signerCount`)
  - `GET /accounts/{address}/operations?order=desc&limit=200` → `created_at` of each op;
    `recentOps` = count within the last **30 days**.
- If the admin is a **contract** (`C…`), Horizon has no account entry to introspect —
  there is genuinely nothing to measure.

**Formula — a tiered base (categorical, NOT a curve) minus a continuous activity penalty:**

This factor is deliberately **tiered**, not a continuous function, because signer structure
is categorical. The base value is chosen by tier:

| Tier                    | Base    | Detected by                                                           |
| ----------------------- | ------- | --------------------------------------------------------------------- |
| Contract-governed admin | **60**  | admin address starts with `C…` (flagged neutral baseline — see below) |
| Single master key       | **40**  | keypair account, not multisig                                         |
| N-of-M multisig (N ≥ 2) | **90**  | `signerCount > 1` **AND** `high_threshold > 1`                        |
| Multisig + timelock     | **100** | _RESERVED — see note_                                                 |

Then a continuous activity penalty is subtracted:

```
activityPenalty = min(30, recentOps × 3)          # capped so structure still dominates
adminKeySafety  = clamp( base − activityPenalty , 0, 100 )
```

**⚠️ The "Multisig + timelock" (100) tier is reserved and not yet reachable.** No
on-chain timelock signal is exposed to the adapter through Horizon today, so nothing is ever
scored 100 by this factor at present. It is documented as the intended top tier so that when
a timelock signal becomes detectable, the tier already exists rather than being invented ad
hoc. This is an **aspirational placeholder, explicitly flagged, not a live rule.**

**⚠️ The contract-governed baseline (60) is a flagged neutral value, not a measurement.**
When the admin is a contract, we cannot introspect its governance via Horizon. Rather than
fabricate a plausible signer/activity number, we assign a fixed, clearly-labeled neutral
baseline of 60 and say so in the factor's `detail` string. This is honest ignorance, not a
score.

**Why these numbers (unvalidated judgment calls, partially anchored):**

- The single-key (40) vs multisig (90) _split_ is anchored to a real, hard security fact: a
  1-of-1 key is a single point of unilateral compromise; an N-of-M multisig with
  `high_threshold > 1` provably requires more than one party to reconfigure the pool. The
  detection condition (`signerCount > 1 AND high_threshold > 1`) reads Stellar's actual
  account threshold model, not a proxy.
- The **exact** base values (40, 90, 60) and the activity penalty shape (`−3` per op, capped
  at `−30`) are **unvalidated judgment calls.** The cap deliberately keeps structure
  dominant over activity (a busy multisig should still beat an idle single key). There is no
  external framework these specific integers are anchored to — they are open to challenge.

---

### 4. `liquiditySafety` — free-liquidity depth (weight 0.15)

**What it measures:** the absolute withdrawal/liquidation cushion — how much value could
leave before the pool is drained. Distinct from `utilizationSafety`, which measures
proximity to the _configured cap_ rather than absolute headroom.

**Raw on-chain data (Soroban RPC):** per reserve, `ResData` (`b_supply`, `b_rate`,
`d_supply`, `d_rate`) and `ResConfig` (`decimals`), used to compute `supplied` and
`borrowed` per the totals formula above.

**Formula** — free-liquidity share of the **worst** reserve, over reserves large enough to be
scored (see [The minimum-size filter](#the-minimum-size-filter) below):

```
For each reserve with supplied > 0 that passes the minimum-size filter:
    free = clamp( (supplied − borrowed) / supplied × 100 , 0, 100 )

liquiditySafety = min(free) across all such reserves     # worst reserve wins
```

Edge cases, both → **0**: **no reserve with `supplied > 0`**, and **every reserve excluded by
the minimum-size filter**. A minimum over an empty set is undefined, not the top of the scale
— an unassessable pool is reported as unassessable, the same way §1 treats having nothing to
price. Returning 100 here would publish "maximally safe" derived from no data, which ground
rule 4 forbids. The two are reported with different `detail` strings: "the pool is empty" and
"everything in it is too small to grade" are different findings.

---

### The minimum-size filter

Applies to **`liquiditySafety` (§4) and `utilizationSafety` (§5) only**, identically for every
protocol.

**The problem it solves.** Both factors select the _worst_ reserve, so a reserve holding
effectively nothing can set a protocol's published number. On the 2026-08-16 Kinetic snapshot a
**$3.00** PYUSD reserve — 0.19% of a $1,571 pool — was the worst reserve on both factors and
set `liquiditySafety` to 34 and `utilizationSafety` to 18. Nobody's capital was meaningfully
exposed to it. That is a misleading number, not a conservative one.

**The rule.** A reserve is scored if **either** test passes, and excluded only when **both**
fail:

| Leg   | Test                                                                | Anchor                                                       |
| ----- | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| **A** | `suppliedUsd ≥` the protocol's own declared minimum viable exposure | the protocol's own on-chain parameter, where it declares one |
| **B** | `suppliedUsd ≥` **0.5% of the pool's own total supplied USD**       | none — an unvalidated judgment call (see below)              |

Leg A is per-protocol in exactly the sense §5's `cap` is: the _pattern_ ("grade against a
parameter the protocol set itself") is the invariant, and which parameter it resolves to is a
documented per-protocol fact.

| Protocol         | Leg A source                                                                                                                        | Value                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **Blend**        | `PoolConfig.min_collateral`, read live from pool instance storage, denominated in the oracle's base asset (`Other:USD`, 7 decimals) | `50000000` = **$5.00** |
| **Kinetic (K2)** | **none — K2 declares no minimum-exposure parameter on chain.** Leg B alone applies.                                                 | n/a                    |

`min_collateral` is Blend's _own_ dust guard: the smallest collateral a position may hold and
still borrow, set where liquidating a position stops being economically worthwhile. A reserve
whose entire supplied value sits below it cannot host even one position the protocol itself
considers viable. That is the same question this filter asks, which is why it is borrowed
rather than invented.

**K2's absence is verified, not assumed.** The router's instance storage and every reserve's
`ReserveConfiguration` bitmap were read looking for an equivalent. What K2 exposes is `MINSWAP`
(a slippage bound), `FLPREMMAX`, `HFLIQTH`/`PLIQHF` (health-factor lines) and a supply/borrow
cap pair in `data_high` — all maxima or unrelated. If K2 ever ships a minimum, leg A turns on
for it with no rule change.

**Why both legs, and not one.** Each covers a failure the other has, both demonstrated on live
data:

- **Absolute-only breaks a small pool.** Any floor sized for a real market ($1k, $10k) excludes
  _all four_ of K2's reserves — its entire pool is ~$1,500. Both factors would go to
  cannot-assess and K2's score would **drop**, from 28 to 15. Worse than the problem.
- **Relative-only breaks a large pool.** 0.5% of Blend's $186M is ~$928,000, so a reserve
  holding half a million dollars of real capital would be silently dropped. Leg A keeps it at
  $5.

> **The 0.5% in leg B is an unvalidated judgment call.** There is no external or on-chain
> framework fixing it; with `STALE_CEILING_SECONDS` (§2) it is one of only two Stenion-chosen
> constants left in the continuous factors, and it is open to challenge like any threshold here.
>
> It is deliberately set at the **low** end of the band that works, because the two directions
> of error are not symmetric. Too low leaves a dust reserve in, which reports a misleading
> number. Too high excludes a small but genuinely-used reserve, which **hides real risk** —
> strictly worse. 0.25% would have flipped on the live K2 reserve between two consecutive days
> ($3.00, then $4.00, against a $3.85 line); 0.5% clears it both times with margin.

**Excluded reserves are disclosed, never silently dropped.** Each affected factor publishes an
`excludedReserves` component with a `null` value — the same "measured, shown, deliberately not
graded" form as §2c/§2d — naming each excluded reserve, its supplied USD, its share of the pool,
and **the score it would have contributed**. A reader can therefore see the number the filter
suppressed and disagree with the exclusion, instead of never learning of it.

> **⚠️ This filter gives §4 and §5 an oracle dependency they did not previously have.** Both are
> otherwise pure balance ratios that need no price at all; the filter is USD-denominated.
> **When no reserve can be priced, the filter does not run and every reserve is scored** — the
> two factors degrade to exactly their pre-filter behaviour rather than refusing to score. That
> is the right fallback, but it means a pool's liquidity and utilization numbers mean something
> slightly different during an oracle outage: they are unfiltered, and a dust reserve can bind
> them again. An individual unpriced reserve is likewise kept, never read as worthless —
> "could not measure" is not "empty".

**The filter cannot empty the scored set on a real pool.** Shares sum to 1, so the largest
reserve always holds at least `1/n`, which clears 0.5% for any `n ≤ 200`. The all-excluded
branch above is therefore unreachable in practice — it is implemented and tested synthetically
anyway, because that is precisely where a "cannot assess" could quietly become a 100 again.

**Why this shape / this anchor:** `(supplied − borrowed) / supplied` is `1 − utilization`,
i.e. the fraction of supplied value that is actually withdrawable _right now_. That is a
direct on-chain quantity, not a modeled one — the anchor is the pool's own balances. Taking
the **worst reserve** rather than a pool-wide average is deliberate: liquidity crises happen
in the single most-drained reserve, and averaging would hide it. The mapping (free % → score
%) is 1:1 and intentionally has no free parameters to tune, so there is nothing arbitrary to
anchor.

---

### 5. `utilizationSafety` — headroom below the configured cap (weight 0.20)

**What it measures:** how close live utilization is to the protocol's own on-chain
utilization stress line — the point the protocol itself defines as "borrowing should stop
growing here." Approaching it is a concrete, protocol-defined stress signal.

**Formula** — headroom below the protocol's utilization line, worst reserve:

```
For each reserve with supplied > 0 and cap > 0 that passes the minimum-size filter:
    util = borrowed / supplied            # computed LIVE from balances, not a config field
    headroom = clamp( (cap − util) / cap × 100 , 0, 100 )

utilizationSafety = min(headroom) across all such reserves    # worst reserve wins
```

The [minimum-size filter](#the-minimum-size-filter) is §4's, unchanged and applied identically
here — one rule, both factors.

Edge cases, all → **0**, for the same reason as §4: **no reserve with `supplied > 0`**, **every
reserve excluded by the minimum-size filter**, and **no reserve with `cap > 0`**. The second is the sharper one — reserves can hold real debt while
declaring no utilization ceiling at all, and grading that as full headroom would measure distance
to a line nobody set. The two are reported with different `detail` strings, since "the pool is
empty" and "the pool declares no ceiling" are different findings.

**`cap` is per-protocol — it is always the protocol's own on-chain utilization parameter,
never a Stenion constant.** Which parameter that resolves to:

| Protocol         | `cap` source                                                                              | Meaning of the line                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Blend**        | per-reserve `max_util` (`ResData`/`ResConfig`, 7-dec fixed point → `max_util / SCALAR_7`) | a **hard throttle** — Blend throttles and eventually pauses borrowing as utilization nears `max_util`                |
| **Kinetic (K2)** | `OPTIMAL_UTILIZATION_RATE` = **0.80** (`contracts/shared/src/constants.rs`)               | the interest-rate **kink** — past 80% util, K2's Aave-V3 rate curve steepens sharply to discourage further borrowing |

**Why this anchor (the strongest in the set):** the threshold is **not a Stenion constant at
all — it is the protocol's own on-chain parameter.** The formula grades each reserve against
the exact line the protocol configured, so the "danger line" is set by the protocol, not by
us. This is the pattern every continuous factor should aspire to. Worst-reserve selection is
deliberate for the same reason as liquidity — the binding constraint is the single reserve
closest to its line.

> **⚠️ Two honest caveats on the K2 anchor (flagged, not hidden):**
>
> 1. K2's kink is a **rate inflection, not a hard pause** — past 80% util K2 keeps lending
>    (just expensively), whereas Blend's `max_util` is an actual throttle. The two lines mean
>    slightly different things; the formula treats "distance to the protocol's declared
>    utilization ceiling" uniformly, which is the intended abstraction.
> 2. `OPTIMAL_UTILIZATION_RATE` is read as K2's **global default (0.80)**. Per-reserve kink
>    overrides, if any, live in K2's `interest_rate` strategy contract, which is **out of
>    scope in the audited source** (`code-423n4/2026-04-k2`) and so not independently
>    verifiable — if a reserve overrides the default this factor uses the documented 80%, not
>    that reserve's exact kink. Revisit if K2 exposes a readable per-reserve optimal-util.

---

## Findings are published, not scored — and how they must be written

Verifiable observations we can't or won't grade go in the protocol page's Findings section
(`dashboard/app/lib/protocol-notes.ts`), never into a factor. **Nothing there is read by any
scoring path**, and a note — favourable or not — can never move a number.

**A note must survive the history it was drawn from.** Twice now a Findings note has outlived
the stored runs behind it: once when the development-era history was discarded, and again when
the briefly-live v2 rows were. Score history is not an archive — it is discarded across a
rulebook change and cannot be recomputed, because `risk_scores` keeps only outputs. A note
written as "our history shows X" therefore decays into an unverifiable claim on a page whose
entire pitch is that you don't have to trust us.

So every note citing our own observations follows the same form:

1. **Cite a closed window, with both ends stated.** "Between 2026-08-11 18:16 and 2026-08-18
   15:55 UTC, 1,469 runs" — not "93% of runs", which silently means something different every
   time the cron fires. A reader re-running the query later must be able to tell that a
   different number is a later window, not a contradiction.
2. **Say the counts are a snapshot of that window** and do not update.
3. **Phrase the underlying claim so it stays checkable from chain after the history is gone.**
   Our runs are evidence that a condition _persisted_; the condition itself must be one anyone
   can observe today, directly from the contracts. If the only support for a claim is rows in
   our database, it is not a finding — it is an assertion.
4. **Give the exact verification steps** — contract, method, field, and what to compare against.
   If we can't say how a reader would check it themselves, it doesn't go in.
5. **Claim only what was measured.** Where a sub-signal wasn't recorded separately, say so and
   scope the claim to the runs that carry it, rather than generalising across all of them.

---

## Disputing or changing a threshold

Every number in this document is meant to be challengeable — especially the ones labeled
"unvalidated judgment call." If you believe a threshold, weight, or formula is wrong (including if
you are a protocol being scored):

1. **Open a GitHub issue** against this repository describing the specific threshold/formula
   and why you think it's wrong. Anchor your argument to something external where possible (a
   protocol's own on-chain parameter, a published risk framework, observed data) rather than
   preference.
2. **Or open a pull request** editing this file directly with the proposed change and its
   justification. A change to `METHODOLOGY.md` **must** be accompanied by the matching change
   to the adapter code (and vice versa) — the two are not allowed to drift.
3. **Maintainer review is required, at the same bar as adapter code changes.** A methodology
   change affects every protocol's number, so it is reviewed at least as carefully as a code
   change — not merged on preference, and never merged because a scored party requested it.
   Per the ground rules above, **no change is ever accepted in exchange for payment.**

Changes that alter what a factor _means_ (e.g. adding or removing a factor) are breaking
changes to the shared taxonomy in `core/src/types.ts` and are held to a higher bar again —
they affect every adapter at once.
