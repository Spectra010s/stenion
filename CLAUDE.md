# Stenion — Project Context for Claude Code

## What this is
Open-source, **live risk-intelligence platform for Stellar/Soroban DeFi protocols**, starting with lending protocols (Blend first, then YieldBlox, Kinetic, Templar). Not a TVL tracker (DeFiLlama already does that well for Stellar) — the differentiator is **continuous, on-chain-derived risk scoring**: collateral concentration, oracle staleness, admin key activity, utilization spikes. Static audits and TVL dashboards don't catch this; Stenion does, continuously.

Secondary feature (not the core pitch): a scam/fake-asset warning API layer built on top of StellarExpert's existing scam directory, made real-time/queryable by wallets.

## Non-negotiable rules
- **Payment must never affect the risk score.** Protocols can pay for visibility, speed, or private tooling — never for a better number. This is load-bearing for the whole product's credibility. Do not write any code path where a paid tier changes a score calculation.
- **AI features only explain/summarize real underlying data — never generate an independent risk assessment.** Don't build "AI guesses the risk" — that reintroduces the unverifiable-claim problem the product exists to solve.
- **The real leaderboard is always free, public, ranked purely by score.** Paid "Spotlight" placement is a visually separate, clearly labeled section — never mixed into real rankings.
- Adapters read on-chain data directly (Soroban RPC) — trustless, not self-reported by protocols.

## Tech stack
- TypeScript/JavaScript throughout
- Backend: indexer/scheduler pulling Soroban RPC data on an interval → Postgres (Supabase/Neon free tier to start)
- API: simple REST — `GET /protocols`, `GET /protocol/:id`
- Frontend: minimal dashboard, deploy on Vercel (`.vercel.app` first, `stenion.com` once there's real data to show)
- Contribution model: DeFiLlama-style — one adapter per protocol, open-source, PR-reviewed

## Repo structure (target)
```
/adapters   — one file per protocol, implements the shared Adapter interface
/core       — adapter interface definition + scoring engine
/indexer    — scheduler that runs adapters on an interval, writes to storage
/api        — REST endpoints
/dashboard  — frontend
```

## Build order (do not skip ahead)
1. Scaffold repo (folders above, tsconfig, eslint, basic CI)
2. Define the `Adapter` interface (`fetchRawData()`, `computeRiskFactors()`, `score()`) — get this right before writing any real adapter
3. Build the Blend adapter against real Soroban RPC data — simple, transparent scoring logic over a sophisticated black box
4. Minimal indexer/scheduler running the Blend adapter on an interval
5. Postgres storage: `protocols` table, `risk_scores` table (protocol_id, score, factors JSON, timestamp)
6. Public API: `GET /protocols`, `GET /protocol/:id`
7. Barebones dashboard hitting the API, deployed to Vercel
8. Connect `stenion.com` once the dashboard shows real data

Currently: **blank repo, starting at step 1.**

## Working style
- Be direct — flag problems, don't soften them, don't oversell progress.
- Prefer crude-but-honest over polished-but-fake at every stage. A working score for one protocol beats a beautiful mock for five.
- Don't add scope beyond the current build-order step without flagging it first.
- This is being built solo by a Nigeria-based developer, pre-funding (SCF application planned for December). Infra choices should default to free tiers until there's a reason to pay.
