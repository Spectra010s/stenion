# Contributing to Stenion

Thanks for wanting to contribute. The main contribution path is **writing an adapter for a new
protocol** — DeFiLlama-style: one open-source, PR-reviewed adapter per protocol. This guide is
meant to be complete enough that you can ship an adapter without needing to ask questions first.

Before you start, read [`METHODOLOGY.md`](METHODOLOGY.md) (the exact formulas your adapter must
implement) and skim [`ARCHITECTURE.md`](ARCHITECTURE.md) (how your adapter fits into the system).

## Ground rules (read these first)

An adapter that breaks any of these will not be merged, regardless of how good the code is:

1. **Read trustless on-chain data only.** Adapters pull from Soroban RPC and Horizon (official
   Stellar infrastructure) — never self-reported numbers from a protocol's API or docs. If a value
   isn't derivable from the chain, it doesn't go in the score.
2. **No fabricated numbers.** Where real data genuinely isn't available for a factor, use a
   clearly-flagged neutral baseline and say so in the factor's `detail` string (see
   `adminKeySafety`'s contract-admin case in `METHODOLOGY.md` for the canonical example). Never
   invent a plausible-looking value.
3. **Anchor thresholds to the protocol's real parameters — don't invent new ones.** The formulas,
   scales, and thresholds are fixed in `METHODOLOGY.md` and identical across protocols. What
   legitimately differs per adapter is only *where you read the raw inputs on-chain*. If your
   protocol has a different on-chain parameter that a continuous factor should anchor to (e.g. Blend
   reads a per-reserve `max_util`; K2 has none and anchors to `OPTIMAL_UTILIZATION_RATE`), that's a
   documented per-protocol fact you add to `METHODOLOGY.md` — **not** a new threshold you invent
   inline. See [Changing a formula or threshold](#changing-a-formula-or-threshold).
4. **Confirm the actual on-chain structure — don't assume it mirrors Blend or K2.** Every
   method/field name in the shipped adapters was confirmed against the protocol's audited source or
   SDK, none guessed. Do the same. And confirm the protocol is actually an *independently scoreable
   native-Soroban lending protocol* before you write scoring logic — see
   [Is this protocol even in scope?](#is-this-protocol-even-in-scope).
5. **Payment never affects the score.** This isn't something your code touches directly, but it's
   why the rules above are strict: the number has to be defensible as purely data-derived.

## The `Adapter` interface

Every adapter implements `Adapter<TRawData>` from `@stenion/core` ([`core/src/adapter.ts`](core/src/adapter.ts)).
`TRawData` is your protocol's own raw shape — it has nothing in common with another protocol's, so
it stays internal to your adapter.

```ts
export interface Adapter<TRawData = unknown> {
  readonly metadata: ProtocolMetadata;          // { id: slug, name, chain: 'stellar' }

  fetchRawData(): Promise<TRawData>;             // pull raw on-chain state (RPC + Horizon)

  computeRiskFactors(rawData: TRawData): Promise<RiskFactorMap>;  // → the five *Safety factors

  score(factors: RiskFactorMap): RiskScoreResult;                 // → weighted safetyScore
}
```

Three separate methods (not one `run()`) so the indexer can inspect intermediate output and so
`score()` can be unit-tested against fixed factor inputs without touching RPC.

## The `*Safety` taxonomy — populate all five

Every adapter must populate the same fixed five factors from `RiskFactorType`
([`core/src/types.ts`](core/src/types.ts)). This shared taxonomy is what makes protocols comparable
— it is **not** freeform per protocol.

```ts
riskFactors: {
  collateralSafety,    // collateral concentration (diversification)  — weight 0.20
  oracleSafety,        // oracle price-feed freshness                  — weight 0.25
  adminKeySafety,      // admin signer structure + activity            — weight 0.20
  liquiditySafety,     // free-liquidity depth (withdrawal cushion)    — weight 0.15
  utilizationSafety,   // headroom below the configured utilization cap — weight 0.20
}
```

Conventions you must not break:

- **Scale: 0–100, higher = safer**, for both the overall score and every factor — same direction
  throughout. A `collateralSafety` of 70 means *well-diversified* (safe), not "70% concentrated."
- **Names end in `*Safety`** so a name never disagrees with its number. Don't add a factor whose
  name implies "higher = riskier."
- **Every key must be present.** Use `null` (not omission) for a factor that genuinely doesn't
  apply to your protocol, so the dashboard renders "N/A" instead of silently dropping it. The
  `score()` weighted mean renormalizes over the non-null factors.
- **Each factor carries a `detail` string** — a short, human-readable explanation of what drove the
  value (e.g. "top reserve holds 95% of supplied value"). This is what the dashboard shows and what
  makes the number auditable. Write a real one.

**How** a factor is computed can differ per protocol; the names, scale, and thresholds do not. New
factors are added to `@stenion/core` for everyone at once — never invented per-adapter.

`score()` is the same weighted mean for every adapter (copy it from `adapters/blend.ts`):

```ts
score(factors: RiskFactorMap): RiskScoreResult {
  let weighted = 0, totalWeight = 0;
  for (const factor of Object.values(factors)) {
    if (!factor) continue;                    // null factors are excluded, weights renormalize
    weighted += factor.value * factor.weight;
    totalWeight += factor.weight;
  }
  const score = totalWeight === 0 ? 0 : Math.round(weighted / totalWeight);
  return { score, factors, computedAt: new Date() };
}
```

## Error handling — throw, don't swallow

The error model is deliberately simple and lives in the indexer, not duplicated per adapter:

- **Adapters throw on failure** — RPC unreachable, malformed response, missing contract data, a
  price that won't decode, anything. Do not catch-and-continue with a fake value; do not return a
  partial factor map with guessed numbers.
- **The indexer wraps each run in try/catch** and records a failed/stale run for that protocol,
  without aborting the cycle or crashing the process. One protocol failing never affects another.
- A missing/undecodable oracle price is *not* an error to swallow — per `METHODOLOGY.md` it's a
  real signal and scores `0` (a missing feed is maximally unsafe). Follow the methodology for what's
  "no data → 0" versus what's "genuinely broken → throw."

## Is this protocol even in scope?

Before writing scoring logic, confirm the protocol is an **independently-scoreable native-Soroban
lending protocol**. Two real, significant protocols were investigated and *deliberately skipped*
because they aren't (details in [`ROADMAP.md`](ROADMAP.md)):

- **YieldBlox** — turned out to be a community-managed pool *on Blend V2*, not an independent
  protocol. An adapter would just be `BlendAdapter` pointed at a different pool.
- **Templar** — its lending market state lives on **NEAR**, not Stellar; only its price oracle is
  native Soroban. Reading NEAR would break the trustless-Stellar rule.

So: confirm reserves, utilization, liquidity, admin, and oracle are all readable via **Soroban RPC +
Horizon** from the protocol's *own* contracts (not another chain, not another protocol's pool)
before you commit to an adapter. Confirming this from the contracts first — rather than assuming it
mirrors Blend/K2 — is the whole point.

## Local development setup

**Prerequisites:** Node 20+, pnpm via corepack, and a Postgres database (Neon free tier works).

```bash
corepack enable
pnpm install

cp .env.example .env        # fill in DATABASE_URL; RPC/Horizon default to public mainnet endpoints

pnpm --filter @stenion/db build
pnpm --filter @stenion/db migrate
```

Then, iterating on your adapter:

1. Add your adapter file at `adapters/<protocol>.ts` and export it from
   [`adapters/index.ts`](adapters/index.ts).
2. Register it in the indexer's `buildTargets()` ([`indexer/src/index.ts`](indexer/src/index.ts))
   via the existing `toTarget<T>()` wrapper — that's what lets your adapter's `TRawData` coexist in
   one typed run loop with the others.
3. Run a single live cycle and check the output lands in Postgres:

   ```bash
   pnpm --filter @stenion/core build
   pnpm --filter @stenion/adapters build
   pnpm --filter @stenion/indexer build
   pnpm --filter @stenion/indexer start -- --once
   ```

4. View it on the site:

   ```bash
   pnpm --filter @stenion/dashboard dev     # http://localhost:3000
   ```

**Verify against real values.** Sanity-check decoded prices/decimals/utilization against known
mainnet reality (a stablecoin should read ~$1.00, XLM its real price, utilization a plausible
percentage). The Blend and Kinetic adapters were both verified end-to-end against live mainnet
before merge — do the same and note it in your PR.

Before opening a PR, from the repo root:

```bash
pnpm build         # all packages compile
pnpm lint          # eslint clean
pnpm typecheck     # tsc clean
```

> **Local hazard:** never run `next build`/`next start`/a second `next dev` against the same
> checkout while a dev server is up — they share one `.next` and corrupt each other. Vercel builds
> in isolation, so this is a local-only issue.

## Adding a dependency

This project defaults to **no new dependencies unless there's a real reason** (it's solo and
pre-funding, on free tiers). If your adapter needs a package beyond `@stellar/stellar-sdk` and what
`@stenion/core` provides, call it out explicitly in the PR with the justification — don't add it
quietly.

## Changing a formula or threshold

Code and `METHODOLOGY.md` are **not allowed to drift**. If you touch factor logic — a threshold, a
weight, an anchor — you change both in the same PR, at the same review bar.

Everything in `METHODOLOGY.md` is meant to be challengeable, including by protocols being scored.
To propose a change:

1. **Open an issue** describing the specific threshold/formula and why it's wrong, anchored to
   something external where possible (a protocol's own on-chain parameter, a published risk
   framework, observed data) — not preference.
2. **Or open a PR** editing `METHODOLOGY.md` *and* the adapter code together, with justification.
3. Adding or removing a factor is a **breaking change to the shared taxonomy** in
   `core/src/types.ts` — it affects every adapter at once and is held to a higher bar again.

## PR review expectations

Your PR should:

- Implement all five `*Safety` factors per the `METHODOLOGY.md` formulas (or `null` with a real
  reason), each with a meaningful `detail` string.
- Confirm every on-chain method/field name against the protocol's audited source or SDK — say so,
  and link it.
- Include the live-mainnet verification (what you ran, what the output was, why it's plausible).
- Pass `pnpm build`, `pnpm lint`, `pnpm typecheck` from the repo root.
- Update `METHODOLOGY.md` in the same PR if — and only if — you introduced a per-protocol anchoring
  fact (like K2's `OPTIMAL_UTILIZATION_RATE`).

Reviews are careful, because a merged adapter puts a public number on a real protocol. **No change
is ever accepted in exchange for payment** — that's the whole premise of the project.
