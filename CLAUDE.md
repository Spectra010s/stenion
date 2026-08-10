# Stenion — Project Context for Claude Code

## What this is

Open-source, **live risk-intelligence platform for Stellar/Soroban DeFi protocols**, starting with lending protocols (Blend — done — then YieldBlox, Kinetic, Templar). Not a TVL tracker (DeFiLlama already covers that for Stellar) — the differentiator is **continuous, on-chain-derived risk scoring**: collateral concentration, oracle staleness, admin key activity, utilization/liquidity. Static audits and TVL dashboards don't catch this; Stenion does, continuously.

Secondary feature (not the core pitch): a scam/fake-asset warning API layer built on top of StellarExpert's existing scam directory, made real-time/queryable by wallets.

## Non-negotiable rules

- **Payment must never affect the score.** Protocols can pay for visibility, speed, or private tooling — never for a better number.
- **AI features only explain/summarize real underlying data — never generate an independent risk assessment.**
- **The real leaderboard is always free, public, ranked purely by score.** Paid "Spotlight" placement is a visually separate, clearly labeled section.
- Adapters read data directly from on-chain / official Stellar infra (Soroban RPC + Horizon) — trustless, not self-reported by protocols.
- **No fabricated numbers.** When real data genuinely isn't available for a factor, use a clearly-flagged neutral baseline (see adminKeySafety below) — never invent a plausible-looking value.

## ⚠️ OPEN DECISIONS

1. **`status` field**: Blend adapter captures the pool's on-chain `status` in raw data but doesn't feed it into any factor yet. Decide if/how it should affect a score before a second adapter needs the same call made. (Not blocking the indexer — step 4 consumes only the five scored factors, which are now settled.)

_Resolved (2026-08-10): the factor naming and polarity questions that used to live here are settled — see "Score conventions" below. The taxonomy is `*Safety`, higher = safer throughout._

## Score conventions

- **Overall score: higher = safer**, 0-100 scale, field/API name `safetyScore` (not `riskScore`).
- **Every factor is on the same scale as the overall score: 0-100, higher = safer.** The factor names are `*Safety` so a name never disagrees with its number — a `collateralSafety` of 70 means well-diversified (safe), not "70% concentrated." Don't add a factor whose name implies higher = riskier.
- Fixed shared taxonomy across every adapter — not freeform per protocol. The names live in the `RiskFactorType` enum in `core/src/types.ts` (the type/map/enum are still called `RiskFactor*` — they're the *dimensions of risk we assess*, each scored for safety). Every adapter must populate all five:
  ```
  riskFactors: {
    collateralSafety,    // collateral concentration (diversification)
    oracleSafety,        // oracle price-feed freshness
    adminKeySafety,      // admin signer structure + activity
    liquiditySafety,     // free-liquidity depth (withdrawal cushion)
    utilizationSafety,   // headroom below the configured utilization cap
  }
  ```
  How an adapter computes a factor can differ per protocol — the names/scale do not. New factors are added to `core` for everyone, not invented per-adapter.

## Adapter error handling

- Adapter methods throw on failure; the indexer wraps each run in try/catch, records failed/stale runs. Error handling lives in the indexer, not duplicated per adapter.
- The indexer runs adapters through a small `toTarget<T>(adapter)` wrapper (see `indexer/src/index.ts`) that binds the three-method lifecycle and hides each adapter's `TRawData`. This is deliberate: `Adapter<BlendRawData>` is *not* assignable to `Adapter<unknown>` (`computeRiskFactors` is contravariant in `TRawData`), so a heterogeneous adapter list can't be typed as `Adapter<unknown>[]` — the wrapper is how future adapters share one run loop without `any`.
- `core/src/adapter.ts` carries `ADAPTER_INTERFACE_VERSION = 1` — shipped. Future breaking changes bump this rather than rewriting every adapter at once.

## adminKeySafety data source (resolved)

Soroban RPC only exposes the pool's admin _address_, not signer structure or activity. Resolved approach: query **Horizon** (official Stellar infra, not third-party) for the admin account's signer weights/thresholds and recent op count — real signal, matches admin-key activity literally. When the admin is a contract (not a keypair account), Horizon has nothing to introspect — in that case use a clearly-flagged neutral baseline (currently `60`), never a fabricated number.

## Tech stack

- TypeScript/JavaScript throughout
- **Package manager: pnpm**, via corepack (`packageManager` field in root `package.json` pins the version)
- **pnpm workspaces** monorepo: `core`, `indexer`, `api`, `dashboard`, `adapters/*` as internal packages importing `@stenion/core`'s `Adapter` interface as a real typed dependency
- Backend: indexer/scheduler pulling Soroban RPC + Horizon data on an interval → Postgres (Supabase/Neon free tier to start)
- API: `GET /protocols`, `GET /protocol/:id`
- Frontend: minimal dashboard on Vercel (`.vercel.app` first, `stenion.com` once there's real data)
- Contribution model: DeFiLlama-style — one adapter per protocol, open-source, PR-reviewed

## TypeScript config

- `tsconfig.base.json` (root) — shared settings only (target, strict, esModuleInterop, skipLibCheck), no resolution-specific options
- `tsconfig.node.json` (root) — extends base, sets `module: "nodeNext"` / `moduleResolution: "nodeNext"` — correct for anything that actually runs on Node (matches Node's real runtime resolution, including `exports` field handling)
- Backend packages (`core`, `indexer`, `api`, `adapters/*`) each extend `tsconfig.node.json`, not base directly
- `dashboard` gets its own config once scaffolded (step 7) — let its framework (Next.js/Vite) generate one, which will default to `bundler` resolution; don't force it to extend `tsconfig.node.json`
- Verify with `pnpm -r exec tsc --showConfig` per package if anything looks off — editor red squiggles can be stale TS server cache, not always a real config bug (restart TS server before assuming the config is wrong)

## Repo structure

```
/adapters   — one package per protocol, implements the shared Adapter interface
/core       — Adapter interface + RiskFactorType enum + scoring engine
/indexer    — scheduler that runs adapters on an interval, try/catch per run, writes to storage
/api        — REST endpoints
/dashboard  — frontend
```

## Blend adapter (shipped — reference implementation for future adapters)

- `adapters/blend.ts` — `BlendAdapter implements Adapter<BlendRawData>`
- Targets Blend's flagship Fixed V2 pool (`CAJJZSGM…`) on **Stellar mainnet**
- Data sources: public keyless RPC `mainnet.sorobanrpc.com` (pool config, reserve list, per-reserve config/data, oracle price/decimals) + Horizon (admin signer/activity)
- Contract addresses sourced from Blend's own `blend-utils/mainnet.contracts.json`; every method/field name confirmed against `blend-sdk-js` and the Rust contract source — none guessed
- Verified end-to-end against live mainnet data (decoded values sanity-checked against real USDC/XLM/EURC prices and utilization)
- Example live output: `safetyScore: 54` (`collateralSafety` 70, `oracleSafety` 100, `adminKeySafety` 40, `liquiditySafety` 24, `utilizationSafety` 16) — the low liquidity/utilization safety scores are real, reflecting ~76% utilization against a 90% cap
- Committed 2026-08-10 as the first real Blend-adapter checkpoint, after the naming/polarity decisions were resolved to the `*Safety` taxonomy

## Build order

1. ✅ Scaffold repo (workspaces, pnpm, tsconfig, eslint, basic CI)
2. ✅ Define the `Adapter` interface in `/core`
3. ✅ Blend adapter — built, typechecks, lints clean, verified against live mainnet. Naming/polarity decisions resolved (`*Safety`), committed 2026-08-10.
4. ✅ Minimal indexer/scheduler — `indexer/src/index.ts` runs the Blend adapter on an interval (`STENION_INTERVAL_MS`, default 5 min), try/catch per run, appends each outcome to a JSONL log (`STENION_OUTPUT_FILE`, default `indexer/runs.jsonl`, gitignored). `--once`/`STENION_RUN_ONCE=1` runs a single cycle and exits (used to verify). No retries, no alerting — deliberately dumb. `pnpm --filter @stenion/indexer start` after a build; JSONL is interim storage, replaced by step 5.
5. **← Next.** Postgres storage: `protocols` table, `risk_scores` table (protocol_id, safetyScore, factors JSON, timestamp). Replace the indexer's `writeRecord` (JSONL) with a DB write; keep the run loop.
6. Public API: `GET /protocols`, `GET /protocol/:id`
7. Barebones dashboard hitting the API, deployed to Vercel
8. Connect `stenion.com` once the dashboard shows real data

Local git initialized; commit history tracks scaffold → interface/blend scaffold → Blend adapter (`*Safety` taxonomy) → indexer as checkpoints. GitHub org/remote still intentionally not set up — local-only for now.

## Keeping this file current

**Update this file yourself at the end of every session/step — don't wait to be asked.** Before ending a session:

- Mark completed build-order steps ✅ and update which step is current
- Add any new architectural decision, resolved open item, or naming/schema change made during the session
- Remove resolved items from "OPEN DECISIONS" (or move them into the relevant section as settled fact)
- If a new open question/ambiguity came up that wasn't resolved, add it to "OPEN DECISIONS" so the next session sees it immediately

The goal: the next session (or a fresh Claude Code session) should be able to read this file alone and have full, current context — no separate changelog, no relying on chat history from a different tool being available.

## Working style

- Be direct — flag problems, don't soften them, don't oversell progress.
- Prefer crude-but-honest over polished-but-fake. A working score for one protocol beats a beautiful mock for five.
- Don't add scope beyond the current build-order step without flagging it first.
- If anything about an interface, schema, or naming is ambiguous or inconsistent, ask/flag rather than guess or silently resolve — these are expensive to change once more adapters depend on them.
- This is being built solo by a Nigeria-based developer, pre-funding (SCF application planned for December). Infra choices default to free tiers until there's a reason to pay.
