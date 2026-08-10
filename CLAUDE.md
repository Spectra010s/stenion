# Stenion — Project Context for Claude Code

## What this is

Open-source, **live risk-intelligence platform for Stellar/Soroban DeFi protocols**, starting with lending protocols (Blend first, then YieldBlox, Kinetic, Templar). Not a TVL tracker (DeFiLlama already does that well for Stellar) — the differentiator is **continuous, on-chain-derived risk scoring**: collateral concentration, oracle staleness, admin key activity, utilization spikes. Static audits and TVL dashboards don't catch this; Stenion does, continuously.

Secondary feature (not the core pitch): a scam/fake-asset warning API layer built on top of StellarExpert's existing scam directory, made real-time/queryable by wallets.

## Non-negotiable rules

- **Payment must never affect the score.** Protocols can pay for visibility, speed, or private tooling — never for a better number. Load-bearing for the whole product's credibility. No paid tier may alter a score calculation.
- **AI features only explain/summarize real underlying data — never generate an independent risk assessment.** Don't build "AI guesses the risk."
- **The real leaderboard is always free, public, ranked purely by score.** Paid "Spotlight" placement is a visually separate, clearly labeled section — never mixed into real rankings.
- Adapters read on-chain data directly (Soroban RPC) — trustless, not self-reported by protocols.

## Score conventions

- **Higher = safer**, 0-100 scale.
- Field/API name is `safetyScore`, never `riskScore` — avoids polarity confusion (a high "risk score" reads as bad, but here high is good).
- Risk taxonomy is **fixed and shared across every adapter** — not freeform per protocol. Every adapter must populate all five categories:
  ```
  riskFactors: {
    collateralRisk: number,
    oracleRisk: number,
    adminKeyRisk: number,
    liquidityRisk: number,
    utilizationRisk: number,
  }
  ```
  _How_ an adapter computes a category can differ per protocol (different oracle, different staleness threshold) — the category names and 0-100 scale per category do not. Extending the taxonomy with a new category is a deliberate, reviewed decision (applies to all adapters), not something one adapter does unilaterally.

## Adapter error handling

- Adapter methods (`fetchRawData()`, `computeRiskFactors()`, `score()`) **throw on failure** — no `{ok, data} | {ok, error}` result-type wrapping. Lower ceremony for community adapter contributors; the indexer wraps each adapter run in try/catch and records a failed/stale run there. Error handling lives in one place (the indexer), not duplicated per adapter.
- The `Adapter` interface carries an `ADAPTER_INTERFACE_VERSION` const so a future v2 (e.g. partial-failure-aware error handling) can be introduced without breaking every existing adapter at once. Don't build v2 speculatively — just keep the version seam in place.

## Tech stack

- TypeScript/JavaScript throughout
- **Package manager: pnpm**, managed via corepack (`packageManager` field in root `package.json` pins the version — don't let it drift to npm)
- **pnpm workspaces** monorepo: root manages `core`, `indexer`, `api`, `dashboard`, and `adapters/*` as internal packages, so `/adapters` and `/indexer` both import `@stenion/core`'s `Adapter` interface as a real typed package, not fragile relative imports
- Backend: indexer/scheduler pulling Soroban RPC data on an interval → Postgres (Supabase/Neon free tier to start)
- API: simple REST — `GET /protocols`, `GET /protocol/:id`
- Frontend: minimal dashboard, deploy on Vercel (`.vercel.app` first, `stenion.com` once there's real data to show)
- Contribution model: DeFiLlama-style — one adapter per protocol, open-source, PR-reviewed

## Repo structure

```
/adapters   — one package per protocol, implements the shared Adapter interface
/core       — Adapter interface definition + scoring engine
/indexer    — scheduler that runs adapters on an interval, try/catch per run, writes to storage
/api        — REST endpoints
/dashboard  — frontend
```

## Build order

1. ✅ Scaffold repo (workspaces, pnpm, tsconfig, eslint, basic CI)
2. ✅ Define the `Adapter` interface in `/core` — done, includes taxonomy + throw/catch + version const
3. **← Current step.** Build the Blend adapter against real Soroban RPC data. Simple, transparent scoring logic over a sophisticated black box.
4. Minimal indexer/scheduler running the Blend adapter on an interval
5. Postgres storage: `protocols` table, `risk_scores` table (protocol_id, safetyScore, factors JSON, timestamp)
6. Public API: `GET /protocols`, `GET /protocol/:id`
7. Barebones dashboard hitting the API, deployed to Vercel
8. Connect `stenion.com` once the dashboard shows real data

Local git is initialized with a committed checkpoint after steps 1–2. GitHub org/remote intentionally not set up yet — local-only for now, push later.

## Working style

- Be direct — flag problems, don't soften them, don't oversell progress.
- Prefer crude-but-honest over polished-but-fake at every stage. A working score for one protocol beats a beautiful mock for five.
- Don't add scope beyond the current build-order step without flagging it first.
- If anything about an interface or schema is ambiguous, ask rather than guess — these are the pieces that are expensive to change once adapters depend on them.
- This is being built solo by a Nigeria-based developer, pre-funding (SCF application planned for December). Infra choices should default to free tiers until there's a reason to pay.
