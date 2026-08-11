# Stenion Scoring Methodology

This document is the **source of truth for how every safety factor is calculated.**
It exists so that anyone — including the protocols being scored — can see, verify, and
challenge the actual rules, not just the output numbers. Every formula below is extracted
directly from the shipped code (currently [`adapters/blend.ts`](adapters/blend.ts) and
[`adapters/kinetic.ts`](adapters/kinetic.ts)); this file is not a summary of intent, it is
the rulebook the adapters must implement.

**One formula, per-protocol data sources.** Every factor's formula, scale, and thresholds
are fixed here and identical across protocols. What legitimately differs per adapter is only
*where the raw inputs are read on-chain* — e.g. Blend reads a per-reserve `max_util` cap,
while Kinetic (K2), being Aave-V3-style, has no such cap and instead anchors the same
utilization formula to its own `OPTIMAL_UTILIZATION_RATE` (see §5). The *anchoring pattern*
("grade against the protocol's own on-chain parameter") is the invariant; the specific
parameter that pattern resolves to is a documented per-protocol fact, not a new threshold.

If the code and this document ever disagree, that is a bug — open an issue (see
[Disputing or changing a threshold](#disputing-or-changing-a-threshold)).

---

## Ground rules (non-negotiable)

1. **The same formula applies to every protocol, with no exceptions.** A factor's formula
   and its thresholds are fixed here, in one shared place. They do not vary per protocol,
   per adapter, or per anything else.
2. **Payment never changes a threshold or a formula.** Protocols can pay for visibility,
   speed, or private tooling — never for a better number. A paid tier cannot move a
   threshold, reweight a factor, or alter a curve. The *only* thing that changes a
   protocol's output is its own real, on-chain data.
3. **Different protocols can and should score differently.** That is the point. What must
   never differ is the *rule* being applied. Blend scoring 54 and a hypothetical protocol
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

### Factor weights

| Factor              | Weight |
|---------------------|--------|
| `oracleSafety`      | 0.25   |
| `collateralSafety`  | 0.20   |
| `adminKeySafety`    | 0.20   |
| `utilizationSafety` | 0.20   |
| `liquiditySafety`   | 0.15   |
| **Total**           | **1.00** |

**Worked example (live Blend Fixed V2 pool, 2026-08-10):**
`70×0.20 + 100×0.25 + 40×0.20 + 24×0.15 + 16×0.20 = 53.8 → 54`.

> **Weights are a v1 judgment call, not an external fact.** Oracle freshness carries the
> most weight because a stale oracle silently poisons every other measurement (collateral
> value, utilization, liquidity are all priced off it). Liquidity carries the least because
> it partly overlaps utilization. There is no external framework these exact weights are
> anchored to yet — they are open to challenge like any threshold below.

---

## The five factors

For each factor: the exact raw on-chain data that feeds it, the exact formula, and why the
thresholds are what they are (anchored to an external/on-chain value where one exists,
labeled an unvalidated v1 judgment call where none does).

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
measure (used by competition regulators and in portfolio analysis) — an *external*
framework rather than a Stenion invention. The anchoring points are not arbitrary either:
`1/n` (a perfectly even split) is the mathematically safest achievable state for `n`
reserves and maps to 100; `1` (everything in one asset) is the worst and maps to 0.
Normalizing by `1/n` means the score grades a pool against the best *it* could do given how
many reserves it has, not against an arbitrary constant.

---

### 2. `oracleSafety` — oracle price-feed freshness (weight 0.25)

**What it measures:** how stale the pool's worst oracle price is. A stale price is exactly
what lets bad debt accrue undetected, so we take the **worst (oldest) reserve**, not the
average.

**Raw on-chain data (Soroban RPC):**
- Per reserve: `lastprice(Asset::Stellar(address))` on the oracle contract → `timestamp`
  (unix seconds, the oracle's own publish time).
- `fetchedAt`: the adapter's read time (unix seconds).
- `age = fetchedAt − timestamp` per reserve.

**Formula** — linear decay on the worst age:

```
Let worst = max age across all reserves
    fresh = 600s   (10 minutes)  → 100
    dead  = 3600s  (60 minutes)  → 0

oracleSafety = clamp( (worst − dead) / (fresh − dead) × 100 , 0, 100 )
```

So `worst ≤ 600s → 100`, `worst ≥ 3600s → 0`, linear in between. If **any** reserve has no
oracle price at all → **0** (a missing feed is treated as maximally unsafe, not skipped).

**Why 10 min / 60 min:** these are an **unvalidated v1 judgment call**, flagged as such. 10
minutes is a conservative "fresh enough for a lending pool" heuristic; 60 minutes is where
we consider a feed effectively dead for risk purposes. The honest correct anchor would be
each oracle's *own* configured resolution/heartbeat (Blend's oracle publishes on an
interval), and moving to read that per-oracle value is the intended v2 — at which point
these constants get replaced by an on-chain anchor. Until then: judgment call, not fact.

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

| Tier | Base | Detected by |
|------|------|-------------|
| Contract-governed admin | **60** | admin address starts with `C…` (flagged neutral baseline — see below) |
| Single master key | **40** | keypair account, not multisig |
| N-of-M multisig (N ≥ 2) | **90** | `signerCount > 1` **AND** `high_threshold > 1` |
| Multisig + timelock | **100** | *RESERVED — see note* |

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

**Why these numbers (v1 judgment calls, partially anchored):**
- The single-key (40) vs multisig (90) *split* is anchored to a real, hard security fact: a
  1-of-1 key is a single point of unilateral compromise; an N-of-M multisig with
  `high_threshold > 1` provably requires more than one party to reconfigure the pool. The
  detection condition (`signerCount > 1 AND high_threshold > 1`) reads Stellar's actual
  account threshold model, not a proxy.
- The **exact** base values (40, 90, 60) and the activity penalty shape (`−3` per op, capped
  at `−30`) are **unvalidated v1 judgment calls.** The cap deliberately keeps structure
  dominant over activity (a busy multisig should still beat an idle single key). There is no
  external framework these specific integers are anchored to — they are open to challenge.

---

### 4. `liquiditySafety` — free-liquidity depth (weight 0.15)

**What it measures:** the absolute withdrawal/liquidation cushion — how much value could
leave before the pool is drained. Distinct from `utilizationSafety`, which measures
proximity to the *configured cap* rather than absolute headroom.

**Raw on-chain data (Soroban RPC):** per reserve, `ResData` (`b_supply`, `b_rate`,
`d_supply`, `d_rate`) and `ResConfig` (`decimals`), used to compute `supplied` and
`borrowed` per the totals formula above.

**Formula** — free-liquidity share of the **worst** reserve:

```
For each reserve with supplied > 0:
    free = clamp( (supplied − borrowed) / supplied × 100 , 0, 100 )

liquiditySafety = min(free) across all such reserves     # worst reserve wins
```

**Why this shape / this anchor:** `(supplied − borrowed) / supplied` is `1 − utilization`,
i.e. the fraction of supplied value that is actually withdrawable *right now*. That is a
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
For each reserve with supplied > 0 and cap > 0:
    util = borrowed / supplied            # computed LIVE from balances, not a config field
    headroom = clamp( (cap − util) / cap × 100 , 0, 100 )

utilizationSafety = min(headroom) across all such reserves    # worst reserve wins
```

**`cap` is per-protocol — it is always the protocol's own on-chain utilization parameter,
never a Stenion constant.** Which parameter that resolves to:

| Protocol | `cap` source | Meaning of the line |
|----------|--------------|---------------------|
| **Blend** | per-reserve `max_util` (`ResData`/`ResConfig`, 7-dec fixed point → `max_util / SCALAR_7`) | a **hard throttle** — Blend throttles and eventually pauses borrowing as utilization nears `max_util` |
| **Kinetic (K2)** | `OPTIMAL_UTILIZATION_RATE` = **0.80** (`contracts/shared/src/constants.rs`) | the interest-rate **kink** — past 80% util, K2's Aave-V3 rate curve steepens sharply to discourage further borrowing |

**Why this anchor (the strongest in the set):** the threshold is **not a Stenion constant at
all — it is the protocol's own on-chain parameter.** The formula grades each reserve against
the exact line the protocol configured, so the "danger line" is set by the protocol, not by
us. This is the pattern every continuous factor should aspire to. Worst-reserve selection is
deliberate for the same reason as liquidity — the binding constraint is the single reserve
closest to its line.

> **⚠️ Two honest caveats on the K2 anchor (flagged, not hidden):**
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

## Disputing or changing a threshold

Every number in this document is meant to be challengeable — especially the ones labeled
"v1 judgment call." If you believe a threshold, weight, or formula is wrong (including if
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

Changes that alter what a factor *means* (e.g. adding or removing a factor) are breaking
changes to the shared taxonomy in `core/src/types.ts` and are held to a higher bar again —
they affect every adapter at once.
