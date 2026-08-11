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
- **pnpm workspaces** monorepo: `core`, `db`, `indexer`, `api`, `dashboard`, `adapters/*` as internal packages importing `@stenion/core`'s `Adapter` interface as a real typed dependency
- Backend: indexer/scheduler pulling Soroban RPC + Horizon data on an interval → **Postgres on Neon free tier** (chosen over Supabase — see "Storage" below), via `@stenion/db` (`pg` driver)
- API: `GET /protocols`, `GET /protocol/:id`
- Frontend: minimal dashboard on Vercel (`.vercel.app` first, `stenion.com` once there's real data)
- Contribution model: DeFiLlama-style — one adapter per protocol, open-source, PR-reviewed

## TypeScript config

- `tsconfig.base.json` (root) — shared settings only (target, strict, esModuleInterop, skipLibCheck), no resolution-specific options
- `tsconfig.node.json` (root) — extends base, sets `module: "nodeNext"` / `moduleResolution: "nodeNext"` — correct for anything that actually runs on Node (matches Node's real runtime resolution, including `exports` field handling)
- Backend packages (`core`, `db`, `indexer`, `api`, `adapters/*`) each extend `tsconfig.node.json`, not base directly
- `dashboard` gets its own config once scaffolded (step 7) — let its framework (Next.js/Vite) generate one, which will default to `bundler` resolution; don't force it to extend `tsconfig.node.json`
- Verify with `pnpm -r exec tsc --showConfig` per package if anything looks off — editor red squiggles can be stale TS server cache, not always a real config bug (restart TS server before assuming the config is wrong)

## Repo structure

```
/adapters   — one package per protocol, implements the shared Adapter interface
/core       — Adapter interface + RiskFactorType enum + scoring engine
/db         — Postgres storage layer: pg pool, typed store, raw-SQL migrations (shared by indexer + api)
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

## Storage — `@stenion/db` (shipped — step 5)

- **Provider: Neon (Postgres) free tier**, chosen over Supabase because local dev is just a connection string — no Docker/CLI/local stack. Neon's cert is publicly valid, so `?sslmode=require` works with normal `pg` verification (no `rejectUnauthorized` override). Code uses plain `pg`, so a switch to Supabase later would be connection-string-only.
- **`@stenion/db` is its own workspace package**, not code buried in the indexer — deliberately, because step 6's API reads the same tables. Both consumers import one typed layer (`createStore`, `getPool`, `RunRecord`) instead of duplicating the connection. Exports: `getPool`/`closePool` (lazy singleton pool), `createStore(pool)` → `{ upsertProtocol, insertRunRecord }`, `loadEnv`/`requireDatabaseUrl`, and the `RunRecord` type (now **owned here** — the persisted contract — and imported by the indexer, not redefined there).
- **Config: `DATABASE_URL`** (postgres:// or postgresql://). Loaded from the nearest `.env` walking up (same convention as the indexer; a single repo-root `.env` covers everything). The indexer validates it up front alongside RPC/Horizon; `@stenion/db` also validates it on first pool use (guards the standalone `migrate` script). `STENION_OUTPUT_FILE`/JSONL are gone.
- **Schema** (`db/migrations/0001_init.sql`):
  - `protocols` — `id` (slug PK, = `ProtocolMetadata.id`), `name`, `chain`, `adapter` (adapter class name, e.g. `BlendAdapter`), `created_at`, `updated_at`. Upserted once at indexer startup from adapter metadata.
  - `risk_scores` — append-only history: `id` (identity PK), `protocol_id` FK, `status` (`ok`/`failed`), `safety_score` (numeric, null on failed), `factors` (jsonb, null on failed), `error` (null on ok), `computed_at` (null on failed), `run_at` (always), `inserted_at`. A `risk_scores_shape` CHECK enforces the ok/failed discriminated union at the DB level. Index on `(protocol_id, run_at DESC)` for latest-score lookups.
- **JSON-vs-columns decision: factors = one `jsonb` column; `safety_score` = its own `numeric` column.** Rule applied: *promote what you rank on (the leaderboard sorts by score → column), JSON what you only display (the factor map is a lossless 1:1 mirror of `RiskFactorMap`, and growing the factor taxonomy — a breaking change per CLAUDE.md — then needs no migration).* `factors` is still queryable later via `factors->'x'->>'value'`.
- **Migrations: raw `.sql` + a ~40-line runner** (`db/src/migrate.ts`), no ORM. `schema_migrations(version)` tracks applied files; each runs once in a transaction, filename order. Run: `pnpm --filter @stenion/db build && pnpm --filter @stenion/db migrate`.
- **Verified end-to-end against a live Neon DB (2026-08-11).** `DATABASE_URL` is set in the repo-root `.env` (Neon pooled endpoint, db `neondb`). Confirmed: migrate applied `0001_init.sql` and is idempotent on re-run (`up to date, nothing to apply`); `pnpm --filter @stenion/indexer start -- --once` landed one real `blend` row — `protocols` = `blend/Blend/stellar/BlendAdapter`, `risk_scores` = `status ok, safety_score 54`, factors queryable via `factors->'collateralSafety'->>'value'` (70/100/16 matching live output); the `risk_scores_shape` CHECK held; `--once` closed the pool and exited cleanly.
- **Known warning (non-blocking):** `pg-connection-string` prints a deprecation notice that `sslmode=require` is currently treated as `verify-full`; that's the *stricter* behavior and Neon's valid cert satisfies it, so nothing to do now. When pg v9 / pg-connection-string v3 lands, `require` will weaken to libpq semantics — revisit then if strict verification is still wanted (pin `sslmode=verify-full`).

## Build order

1. ✅ Scaffold repo (workspaces, pnpm, tsconfig, eslint, basic CI)
2. ✅ Define the `Adapter` interface in `/core`
3. ✅ Blend adapter — built, typechecks, lints clean, verified against live mainnet. Naming/polarity decisions resolved (`*Safety`), committed 2026-08-10.
4. ✅ Minimal indexer/scheduler — `indexer/src/index.ts` runs the Blend adapter on an interval (`STENION_INTERVAL_MS`, default 5 min), try/catch per run, appends each outcome to a JSONL log (`STENION_OUTPUT_FILE`, default `indexer/runs.jsonl`, gitignored). `--once`/`STENION_RUN_ONCE=1` runs a single cycle and exits (used to verify). No retries, no alerting — deliberately dumb. `pnpm --filter @stenion/indexer start` after a build; JSONL is interim storage, replaced by step 5.
5. ✅ Postgres storage — `@stenion/db` package: Neon Postgres, `protocols` + `risk_scores` tables (factors as jsonb, `safety_score` promoted to a column), raw-SQL migrations + runner. Indexer's `writeRecord`/JSONL replaced by `store.insertRunRecord`; run loop and `RunRecord` shape unchanged. Builds + lints clean; **verified end-to-end against the live Neon DB (2026-08-11)** — migration applied + idempotent, real `blend` row landed (`safetyScore 54`). See "Storage" above.
6. **← Next.** Public API: `GET /protocols`, `GET /protocol/:id`.
   - `api` already scaffolded (`api/src/index.ts`, depends on `@stenion/core`). Add `@stenion/db` as a dependency and read through `createStore`/`getPool` — do **not** duplicate the connection. Likely add read methods to the `Store` (e.g. `listProtocolsWithLatestScore()`, `getProtocolWithHistory(id)`) rather than raw SQL in the route handlers.
   - `GET /protocols` = leaderboard: each protocol + its latest `risk_scores` row, ranked by `safety_score` desc. Use the `(protocol_id, run_at DESC)` index (`DISTINCT ON (protocol_id) … ORDER BY protocol_id, run_at DESC`). Remember failed runs have null `safety_score` — decide whether the latest-row is the latest *ok* row or the latest row regardless of status (probably latest ok, with staleness surfaced).
   - `GET /protocol/:id` = that protocol + recent score history (the append-only `risk_scores` rows).
   - Keep the API read-only and payment-blind (leaderboard ranks purely on score — non-negotiable rule). Pick a minimal HTTP layer (bare `node:http` or a tiny framework) — flag if adding a dep.
7. Barebones dashboard hitting the API, deployed to Vercel
8. Connect `stenion.com` once the dashboard shows real data

Local git initialized; commit history tracks scaffold → interface/blend scaffold → Blend adapter (`*Safety` taxonomy) → indexer → Postgres storage (`@stenion/db`) as checkpoints. GitHub org/remote still intentionally not set up — local-only for now. (Step 5 storage work is complete in the working tree but not yet committed.)

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
