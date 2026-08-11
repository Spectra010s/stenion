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

1. **Pause/`status` field — now surfaced by TWO adapters, still not scored.** Blend captures the pool's on-chain `status`; Kinetic captures `is_paused()` as `paused`. Both are in raw data but **neither feeds a factor** — kept deliberately consistent across the two adapters (a paused/frozen pool arguably deserves a score hit, but that's a taxonomy decision affecting every adapter, so not done ad hoc). The "before a second adapter needs the same call" trigger has now fired (Kinetic makes it), so this is riper: decide whether pause state becomes a scored signal (new factor? a multiplier? a display-only flag?) before a third adapter. Still not blocking — the indexer consumes only the five scored factors.
2. **Oracle *manipulation* vs *staleness* (surfaced 2026-08-11).** `oracleSafety` scores price **age** only. The YieldBlox/Blend $10M hack (and the same risk on Kinetic, which shares the Reflector-family feed) was a **fresh but manipulated** price — which scores 100. A future oracle-robustness factor (TWAP/deviation/oracle-type awareness) is a candidate, but it's a new taxonomy member (breaking change for every adapter) so it's flagged, not invented. See `METHODOLOGY.md` §2 / step 9 notes.

_Resolved (2026-08-10): the factor naming and polarity questions that used to live here are settled — see "Score conventions" below. The taxonomy is `*Safety`, higher = safer throughout._

## Score conventions

- **Overall score: higher = safer**, 0-100 scale, field/API name `safetyScore` (not `riskScore`).
- **Every factor is on the same scale as the overall score: 0-100, higher = safer.** The factor names are `*Safety` so a name never disagrees with its number — a `collateralSafety` of 70 means well-diversified (safe), not "70% concentrated." Don't add a factor whose name implies higher = riskier.
- Fixed shared taxonomy across every adapter — not freeform per protocol. The names live in the `RiskFactorType` enum in `core/src/types.ts` (the type/map/enum are still called `RiskFactor*` — they're the _dimensions of risk we assess_, each scored for safety). Every adapter must populate all five:

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

- **`METHODOLOGY.md` (repo root) is the source of truth for every factor's formula, thresholds, and weights.** It's the public-facing rulebook (protocols can read and challenge it). A new adapter must **match** the formulas documented there — same thresholds, same anchoring pattern (continuous factors anchored to the protocol's own on-chain caps where they exist; `adminKeySafety` is a defined tier table) — not invent new thresholds inline. Code and `METHODOLOGY.md` are not allowed to drift: any change to a formula/threshold changes both together, at the same review bar. If you touch factor logic, update `METHODOLOGY.md` in the same change.

## Adapter error handling

- Adapter methods throw on failure; the indexer wraps each run in try/catch, records failed/stale runs. Error handling lives in the indexer, not duplicated per adapter.
- The indexer runs adapters through a small `toTarget<T>(adapter)` wrapper (see `indexer/src/index.ts`) that binds the three-method lifecycle and hides each adapter's `TRawData`. This is deliberate: `Adapter<BlendRawData>` is _not_ assignable to `Adapter<unknown>` (`computeRiskFactors` is contravariant in `TRawData`), so a heterogeneous adapter list can't be typed as `Adapter<unknown>[]` — the wrapper is how future adapters share one run loop without `any`.
- `core/src/adapter.ts` carries `ADAPTER_INTERFACE_VERSION = 1` — shipped. Future breaking changes bump this rather than rewriting every adapter at once.

## adminKeySafety data source (resolved)

Soroban RPC only exposes the pool's admin _address_, not signer structure or activity. Resolved approach: query **Horizon** (official Stellar infra, not third-party) for the admin account's signer weights/thresholds and recent op count — real signal, matches admin-key activity literally. When the admin is a contract (not a keypair account), Horizon has nothing to introspect — in that case use a clearly-flagged neutral baseline (currently `60`), never a fabricated number.

`adminKeySafety` is formalized as a **tier table** (contract-governed `60` neutral baseline / single-key `40` / N-of-M multisig `90` / multisig+timelock `100` _reserved, not yet detectable_) minus a continuous activity penalty (`−3` per admin op in 30d, capped `−30`). Tier values were agreed with the maintainer (2026-08-11), not invented; the full definition and rationale live in `METHODOLOGY.md` (the source of truth). The current Blend code implements exactly this — the timelock tier is documented but unreachable until an on-chain timelock signal is available.

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

## Kinetic adapter (shipped 2026-08-11 — second protocol, first non-Blend interface)

- `adapters/kinetic.ts` — `KineticAdapter implements Adapter<KineticRawData>`. First adapter that exercises a genuinely different on-chain shape than Blend (validates the shared taxonomy against a non-Blend protocol).
- **What Kinetic is:** the protocol formerly called Kinetic, rebranded **K2** (`k2lend.com`; docs `docs.k2lend.com`). Audited by Halborn + Watchpug + Code4rena (`code-423n4/2026-04-k2`), monitored by Hypernative. **Aave-V3-style single-pool-multi-asset**: one `kinetic_router` fronts up to 64 reserves — currently 4 (USDC, XLM, PYUSD, SolvBTC). This is a real, distinct protocol — **not** a Blend pool (contrast YieldBlox, which is, and was skipped — see step 9).
- **Mainnet wiring** (`KINETIC_ROUTER = CCTUJZLY…`, from `docs.k2lend.com/contracts`, same trust posture as Blend's deploy config). Oracle (`price_oracle CCHRZE2K…`) and admin address are **read live from the router's instance storage** (keys `ORACLE`/`PADMIN`), not hardcoded.
- **Read interface — every method/field confirmed against the audited Rust source, none guessed:** `router.get_reserves_list()`, `router.get_current_reserve_data(asset) -> ReserveData` (has `a_token_address`/`debt_token_address`/`configuration` bitmap/indices), `router.is_paused()`, `aToken/debtToken.total_supply() -> i128` (underlying units, index already applied — so no RAY math needed our side), `price_oracle.get_asset_price_data(Asset::Stellar(addr)) -> PriceData { price (14dp), timestamp }`. Asset decimals decoded from the `ReserveConfiguration.data_low` bitmap (bits 42-49).
- **Factor mapping:** four factors (`collateralSafety`, `oracleSafety`, `adminKeySafety`, `liquiditySafety`) use the **identical Blend formula**. The oracle **carries a publish timestamp** (SEP-40 `PriceData`), so `oracleSafety` is the exact Blend staleness formula; a `PriceTooOld`/unconfigured price errors the sim → treated as null → scores 0 (same as Blend's missing-price handling).
- **The one divergence — `utilizationSafety`:** K2 has **no Blend-style per-reserve `max_util` cap** (it's Aave-V3: `supply_cap`/`borrow_cap` amount caps + an interest-rate kink). Per maintainer decision (2026-08-11), `utilizationSafety` anchors to K2's `OPTIMAL_UTILIZATION_RATE` (**0.80**, from `shared/src/constants.rs`): `headroom = (0.8 − util)/0.8`, worst reserve. Same *anchoring pattern* as Blend (the protocol's own on-chain utilization parameter), different parameter — **documented in `METHODOLOGY.md` §5** with two flagged caveats (kink ≠ hard pause; per-reserve overrides live in the un-audited `interest_rate` contract so the global 0.80 default is used).
- **Verified end-to-end against live mainnet (2026-08-11):** `fetchRawData` returned 4 reserves, `paused=false`, admin a contract (`CC4UQND4…` → neutral 60); prices decoded sane (USDC/PYUSD ~$1.00, XLM $0.16, SolvBTC ~$63.7k; decimals 7/7/7/8). Live output: **`safetyScore: 21`** (`collateralSafety` 14, `oracleSafety` 0, `adminKeySafety` 60, `liquiditySafety` 28, `utilizationSafety` 10). The low score is **real, not a bug**: ~95% of supplied value sits in XLM (young/small pool → high HHI) and one stablecoin feed was genuinely ~6.4h stale (oracle 0 — exactly the kind of live risk Stenion exists to surface). Indexer `--once` landed both `blend` (54) and `kinetic` (21) rows in the live Neon DB; both appear on `listProtocolsWithLatestScore()` with all five factors persisted.
- **Known shared characteristic (not a Kinetic-specific bug):** dust/near-empty reserves can win the worst-reserve selection in `liquiditySafety`/`utilizationSafety` (e.g. the ~0-balance SolvBTC reserve). Blend behaves identically; worst-reserve is deliberate per `METHODOLOGY.md`. A minimum-size filter would be a shared methodology change, not an adapter tweak — out of scope here.
- **Uncommitted** in the working tree (like the step-7 dashboard) — commit when ready.

## Storage — `@stenion/db` (shipped — step 5)

- **Provider: Neon (Postgres) free tier**, chosen over Supabase because local dev is just a connection string — no Docker/CLI/local stack. Neon's cert is publicly valid, so `?sslmode=require` works with normal `pg` verification (no `rejectUnauthorized` override). Code uses plain `pg`, so a switch to Supabase later would be connection-string-only.
- **`@stenion/db` is its own workspace package**, not code buried in the indexer — deliberately, because step 6's API reads the same tables. Both consumers import one typed layer (`createStore`, `getPool`, `RunRecord`) instead of duplicating the connection. Exports: `getPool`/`closePool` (lazy singleton pool), `createStore(pool)` → `{ upsertProtocol, insertRunRecord }`, `loadEnv`/`requireDatabaseUrl`, and the `RunRecord` type (now **owned here** — the persisted contract — and imported by the indexer, not redefined there).
- **Config: `DATABASE_URL`** (postgres:// or postgresql://). Loaded from the nearest `.env` walking up (same convention as the indexer; a single repo-root `.env` covers everything). The indexer validates it up front alongside RPC/Horizon; `@stenion/db` also validates it on first pool use (guards the standalone `migrate` script). `STENION_OUTPUT_FILE`/JSONL are gone.
- **Schema** (`db/migrations/0001_init.sql`):
  - `protocols` — `id` (slug PK, = `ProtocolMetadata.id`), `name`, `chain`, `adapter` (adapter class name, e.g. `BlendAdapter`), `created_at`, `updated_at`. Upserted once at indexer startup from adapter metadata.
  - `risk_scores` — append-only history: `id` (identity PK), `protocol_id` FK, `status` (`ok`/`failed`), `safety_score` (numeric, null on failed), `factors` (jsonb, null on failed), `error` (null on ok), `computed_at` (null on failed), `run_at` (always), `inserted_at`. A `risk_scores_shape` CHECK enforces the ok/failed discriminated union at the DB level. Index on `(protocol_id, run_at DESC)` for latest-score lookups.
- **JSON-vs-columns decision: factors = one `jsonb` column; `safety_score` = its own `numeric` column.** Rule applied: _promote what you rank on (the leaderboard sorts by score → column), JSON what you only display (the factor map is a lossless 1:1 mirror of `RiskFactorMap`, and growing the factor taxonomy — a breaking change per CLAUDE.md — then needs no migration)._ `factors` is still queryable later via `factors->'x'->>'value'`.
- **Migrations: raw `.sql` + a ~40-line runner** (`db/src/migrate.ts`), no ORM. `schema_migrations(version)` tracks applied files; each runs once in a transaction, filename order. Run: `pnpm --filter @stenion/db build && pnpm --filter @stenion/db migrate`.
- **Verified end-to-end against a live Neon DB (2026-08-11).** `DATABASE_URL` is set in the repo-root `.env` (Neon pooled endpoint, db `neondb`). Confirmed: migrate applied `0001_init.sql` and is idempotent on re-run (`up to date, nothing to apply`); `pnpm --filter @stenion/indexer start -- --once` landed one real `blend` row — `protocols` = `blend/Blend/stellar/BlendAdapter`, `risk_scores` = `status ok, safety_score 54`, factors queryable via `factors->'collateralSafety'->>'value'` (70/100/16 matching live output); the `risk_scores_shape` CHECK held; `--once` closed the pool and exited cleanly.
- **Known warning (non-blocking):** `pg-connection-string` prints a deprecation notice that `sslmode=require` is currently treated as `verify-full`; that's the _stricter_ behavior and Neon's valid cert satisfies it, so nothing to do now. When pg v9 / pg-connection-string v3 lands, `require` will weaken to libpq semantics — revisit then if strict verification is still wanted (pin `sslmode=verify-full`).

## Public API — `@stenion/api` (shipped — step 6)

- **Framework: bare `node:http`**, no new dependency (two static reads need no middleware). Entry `api/src/index.ts`.
- **Read-only, payment-blind, no auth/rate-limit/pagination** (those are deferred, not built speculatively). Leaderboard ranks purely on `safety_score` — a non-negotiable rule.
- **Reads only** — the indexer still owns scoring on its interval; the API never recomputes, it shapes stored `risk_scores`/`protocols` rows into JSON.
- **Connection: reuses `@stenion/db`'s `getPool()` + `createStore`** — the same repo-root `DATABASE_URL`, which is Neon's **pooled** (`-pooler`/PgBouncer) endpoint. Correct for Vercel serverless (many short-lived instances multiplexed through the pooler). No second/duplicated connection. Same `pg-connection-string` `sslmode=require`→`verify-full` deprecation warning as the indexer/db — non-blocking, see "Storage".
- **Read methods live on the `Store`** (`@stenion/db`), not in route handlers: `listProtocolsWithLatestScore()` → `LeaderboardEntry[]`, `getProtocolDetail(id)` → `ProtocolDetail | null`. Both use the `(protocol_id, run_at DESC)` index via two `LEFT JOIN LATERAL … LIMIT 1` subqueries per protocol (latest _ok_ score for the number shown; latest run of any status for the staleness flag). `DETAIL_HISTORY_LIMIT = 50`.
- **Staleness model (settled):** the displayed `safetyScore` is always the latest **ok** run (null if never scored); the newest run of any status is surfaced separately as `lastRunAt`/`lastRunStatus`. A leaderboard that's honest about freshness beats one with holes on a failed cycle.
- **`createRequestHandler(store)` is exported** (server startup is guarded by `require.main === module`) so the same handler can be reused as a Vercel serverless function without opening a port. `main()` `listen`s on `API_PORT` (**default `3000`** — added step 7; previously `Number(undefined)` → a random port).
- **CORS (added step 7):** every response carries `access-control-allow-origin: *` + `access-control-allow-methods: GET, OPTIONS` + `access-control-allow-headers: content-type`; `OPTIONS` is answered `204`. Deliberately not a configurable/generic CORS layer — `*` is the correct policy for public, read-only, payment-blind data (a wallet, the dashboard, any third party may read it). Note the dashboard itself doesn't _need_ this (it reads the API server-side — see "Dashboard"); CORS is for future direct/browser/third-party clients.
- **Frozen contract** (what the dashboard + any third party depend on — changing a field is a breaking change):

  `GET /protocols` — envelope (not a bare array, so freshness/count metadata can be added later without breaking), sorted by `safetyScore` desc, never-scored last:

  ```json
  {
    "protocols": [
      {
        "id": "blend",
        "name": "Blend",
        "chain": "stellar",
        "safetyScore": 54,
        "computedAt": "…Z",
        "lastRunAt": "…Z",
        "lastRunStatus": "ok"
      }
    ]
  }
  ```

  `safetyScore`/`computedAt` are `null` until the first ok run.

  `GET /protocol/:id`:

  ```json
  {
    "id": "blend",
    "name": "Blend",
    "chain": "stellar",
    "adapter": "BlendAdapter",
    "safetyScore": 54,
    "computedAt": "…Z",
    "factors": {
      "collateralSafety": { "value": 70, "weight": 0.2, "detail": "…" },
      "…": {}
    },
    "lastRunAt": "…Z",
    "lastRunStatus": "ok",
    "history": [
      { "status": "ok", "safetyScore": 54, "computedAt": "…Z", "runAt": "…Z" },
      { "status": "failed", "error": "…", "runAt": "…Z" }
    ]
  }
  ```

  Top-level `safetyScore`/`computedAt`/`factors` = latest ok run (all `null` if never scored; a single factor member may be `null` per the taxonomy). `history` = up to 50 recent rows, newest first, a **discriminated union on `status`** (`ok` → `safetyScore`/`computedAt`/`runAt`; `failed` → `error`/`runAt`). `history` rows deliberately **omit factors** — they're still in the `risk_scores` jsonb, so adding them to the array shape later is a cheap backward-compatible change if step 7 needs per-factor history. Unknown id → `404 {"error":"Protocol not found","id":…}`; non-GET → `405`; other errors → `500 {"error":"Internal server error"}` (raw DB errors logged server-side, never leaked).

- **Run:** `pnpm --filter @stenion/db build && pnpm --filter @stenion/api build && pnpm --filter @stenion/api start` (needs `DATABASE_URL` + migrated tables). **Verified end-to-end against the live Neon DB (2026-08-11):** real `blend` row on both endpoints (`safetyScore 54`, all five factors with `detail`), 404/405/route-not-found/500 paths all confirmed.

## Dashboard — `@stenion/dashboard` (shipped — step 7)

- **Framework: Next.js 15, App Router** (React 19). Chosen over Vite because Vercel is the deploy target (first-party integration, zero-config), it gives Server Components for the fetch model below, and file-based routing maps 1:1 to the two pages. Its own `tsconfig.json` (bundler resolution, `jsx: preserve`, `next` TS plugin) — **does not** extend `tsconfig.node.json`, per "TypeScript config".
- **Fetch model (settled): server-side.** Both pages are async Server Components that fetch the API from Node (on Vercel), never from the browser. Consequences: (1) the API base URL is a **server-only** env var **`STENION_API_URL`** (no `NEXT_PUBLIC_` prefix — the browser never sees or calls the API); default `http://localhost:3000`. (2) CORS is **not required** for the dashboard's own render path (server-to-server bypasses the browser same-origin policy) — the CORS added to the API is purely for future direct/browser/third-party clients. Both routes are `ƒ` (dynamic, `export const dynamic = 'force-dynamic'` + `cache: 'no-store'`) so they always show the freshest stored score, not a build-time snapshot.
- **Pages:**
  - `app/page.tsx` — leaderboard from `GET /protocols`: ranked table (rank, name→detail link, chain, `safetyScore` with a coarse color band, staleness pill from `lastRunStatus`). Empty state if nothing scored; a `notice` (not a crash) if the API is unreachable.
  - `app/protocol/[id]/page.tsx` — detail from `GET /protocol/:id` (Next 15 async `params`): big score hero + staleness pill, then the **five `*Safety` factors each with value, weight %, a bar, and the real `detail` string** (this is the product pitch — _why_ the score is what it is), then a "Recent runs" history strip (ok/failed dots) from the `history` array. `null` factor → "N/A" row (not dropped). Unknown id → `notFound()` → `app/not-found.tsx` (404).
- **Shared code:** `app/lib/api.ts` (typed fetch helpers + contract types — **duplicated from the HTTP contract, not imported from `@stenion/db`**: the dashboard depends on the JSON shape, not the DB layer) and `app/lib/format.ts` (timestamp/staleness/score-band helpers). Styling is one hand-written `app/globals.css` — minimal/functional per house style, no UI framework.
- **Not yet deployed** (see step 8). `outputFileTracingRoot` is pinned to the repo root in `next.config.mjs` (Next was inferring a stray home-dir lockfile as the root).
- **Run locally:** start the API (`API_PORT=3000 node api/dist/index.js`, needs `DATABASE_URL` + migrated tables), then `pnpm --filter @stenion/dashboard dev` (set `STENION_API_URL` if the API isn't on `:3000`). Build: `pnpm --filter @stenion/dashboard build`.
- **Verified end-to-end against the live Neon DB (2026-08-11):** `next build` clean (both routes `ƒ`); running `next start` against the live API, `/` rendered Blend `54` + "live" pill and `/protocol/blend` rendered all five factor `detail` strings (e.g. "top reserve holds 64%… HHI 0.53", "76% util vs 90% cap"); `/protocol/nope` → 404. API CORS headers + `OPTIONS 204` confirmed via `curl`.

### pnpm build-script note (added step 7)

Adding Next pulled `sharp` (a native dep of `next/image`, which the dashboard doesn't use). pnpm 11 **skips** unapproved build scripts _and_ exits non-zero (`ERR_PNPM_IGNORED_BUILDS`), which also breaks `pnpm --filter <pkg> <script>` (its deps-status precheck re-runs install). Resolved in **`pnpm-workspace.yaml`**: `ignoredBuiltDependencies: [sharp]` (acknowledge the skip) + `strictDepBuilds: false` (demote the skip from a hard error to a warning). `**/.next/**` and `**/next-env.d.ts` are in `eslint.config.js` ignores so root `eslint .` doesn't lint Next's generated output.

## Build order

1. ✅ Scaffold repo (workspaces, pnpm, tsconfig, eslint, basic CI)
2. ✅ Define the `Adapter` interface in `/core`
3. ✅ Blend adapter — built, typechecks, lints clean, verified against live mainnet. Naming/polarity decisions resolved (`*Safety`), committed 2026-08-10.
4. ✅ Minimal indexer/scheduler — `indexer/src/index.ts` runs the Blend adapter on an interval (`STENION_INTERVAL_MS`, default 5 min), try/catch per run, appends each outcome to a JSONL log (`STENION_OUTPUT_FILE`, default `indexer/runs.jsonl`, gitignored). `--once`/`STENION_RUN_ONCE=1` runs a single cycle and exits (used to verify). No retries, no alerting — deliberately dumb. `pnpm --filter @stenion/indexer start` after a build; JSONL is interim storage, replaced by step 5.
5. ✅ Postgres storage — `@stenion/db` package: Neon Postgres, `protocols` + `risk_scores` tables (factors as jsonb, `safety_score` promoted to a column), raw-SQL migrations + runner. Indexer's `writeRecord`/JSONL replaced by `store.insertRunRecord`; run loop and `RunRecord` shape unchanged. Builds + lints clean; **verified end-to-end against the live Neon DB (2026-08-11)** — migration applied + idempotent, real `blend` row landed (`safetyScore 54`). See "Storage" above.
6. ✅ Public API — `@stenion/api`: read-only `GET /protocols` + `GET /protocol/:id`, served straight from the step-5 Postgres tables (nothing recomputed live). Bare `node:http`, no new dependency. Reuses `@stenion/db`'s `getPool()`/`createStore` (the Neon **pooled** connection — no duplicated connection). Read methods live on the `Store`, not in route handlers. Builds + lints clean; **verified end-to-end against the live Neon DB (2026-08-11)** — real `blend` row served on both endpoints, 404/405/500 paths confirmed. See "Public API" below.
7. ✅ Barebones dashboard — **Next.js 15 App Router** (`@stenion/dashboard`), reads the two shipped endpoints, renders real live `blend` data on both pages. CORS added to the API first (the step-6 gap). Builds + typechecks + lints clean; **verified end-to-end against the live Neon DB (2026-08-11)** — leaderboard shows Blend `54` + "live" pill, detail page shows all five `*Safety` factors with their real `detail` strings, 404 path works. **Not yet deployed to Vercel** — that's the one remaining action, now the first task of step 8 (needs the maintainer's `vercel` login; an outward-facing deploy, not done autonomously). See "Dashboard" below.
> **⚠️ EXECUTION ORDER FROM HERE (decided 2026-08-11, after going back and forth on priority):**
> **step 9 (more adapters: YieldBlox → Kinetic) → step 10 (dashboard/site build-out) → step 8 (deploy)**,
> in that order even though the step _numbers_ are out of order. Rationale: build **real
> multi-protocol data first**, so the eventual homepage/positioning has genuine substance
> behind it (a leaderboard with Blend + YieldBlox + Kinetic) rather than one protocol propped
> up by marketing copy, and so deploy happens once against a site that's actually worth
> showing. **Deploy (step 8) is deliberately deferred until after 9 and 10** — do not deploy
> as part of the adapter/site work. The step numbers are historical (8 was written before this
> re-sequencing); trust this execution-order note, not the numeric order, if they disagree.

8. **Deferred until after steps 9 + 10.** Deploy the dashboard + connect the domain. Not done in the adapter/site sessions — it's an outward-facing action needing the maintainer's `vercel` login and a stable, real multi-protocol site to point at.
   - **Deploy to Vercel** (`.vercel.app` first). Two deployables in this monorepo: the Next.js `dashboard` and the `@stenion/api` handler (`createRequestHandler` is exported for serverless reuse). Simplest: deploy the API to its own Vercel project (or as a route), deploy the dashboard as a second project, set the dashboard's **`STENION_API_URL`** env var (server-only, _not_ `NEXT_PUBLIC_`) to the deployed API origin. `DATABASE_URL` (Neon pooled) goes on whichever project runs the API.
   - Next inferred the wrong workspace root at build time (a stray `C:\Users\USER\pnpm-lock.yaml` in the home dir) — already pinned via `outputFileTracingRoot` in `dashboard/next.config.mjs`, so Vercel traces workspace deps correctly. Keep that.
   - Then connect **`stenion.com`** as a custom domain once there's real data live and stable on `.vercel.app`.
   - **GitHub remote** is still not set up (local-only). Vercel's Git integration wants a remote; either push to GitHub first (the DeFiLlama-style contribution model needs a public repo anyway) or use `vercel deploy` from the CLI without Git. Decide at deploy time.

9. **← CURRENT.** More protocol adapters — real multi-protocol data before the site build-out.
   - **YieldBlox — NOT built as a standalone adapter (finding, 2026-08-11).** Research established YieldBlox is **not an independent Soroban lending protocol**. The original 2021 YieldBlox was pre-Soroban (built on Stellar Turrets). The YieldBlox DAO later adopted **Blend as its backbone**; what exists today as "YieldBlox" is a **community-managed pool on Blend V2**, using the identical Blend pool interface (`ResConfig`/`ResData`, Reflector `lastprice`) — so a "YieldBlox adapter" would just be `BlendAdapter` pointed at a different `poolId`, i.e. duplicated Blend logic presenting a Blend pool as an independent protocol. Maintainer decision (2026-08-11): **skip standalone-YieldBlox; go straight to Kinetic** (the genuine independent second protocol). YieldBlox can later be represented as a second Blend *pool* via a small multi-pool refactor of `blend.ts` if wanted — tracked as a possible future item, not built now.
     - **Methodology edge case surfaced by the YieldBlox hack (~$10M, late Feb 2026):** the exploit was oracle **manipulation of a _fresh_ price** (USTRY pushed ~$1.05→$100 via aggressive Stellar-DEX buys; the Reflector oracle reported that fresh, manipulated price with no TWAP/deviation filter), **not staleness**. Stenion's `oracleSafety` only measures price _age_, so a fresh-but-manipulated price scores 100 — **Stenion as currently specified would not have flagged this exploit.** Honest limitation, recorded here and (if adopted) in `METHODOLOGY.md`; a candidate future factor (oracle-type / TWAP / deviation awareness), deliberately **not** invented inline (no new thresholds per the ground rules).
   - ✅ **Kinetic adapter (K2) — SHIPPED (2026-08-11).** `adapters/kinetic.ts` — `KineticAdapter implements Adapter<KineticRawData>`. Genuinely independent Soroban lending protocol (Kinetic, rebranded **K2** / `k2lend.com`; audited by Halborn + Watchpug + Code4rena `code-423n4/2026-04-k2`; monitored by Hypernative). **Aave-V3-style single-pool-multi-asset** — one `kinetic_router` fronts up to 64 reserves (currently 4: USDC, XLM, PYUSD, SolvBTC). Same `Adapter` pattern, same fixed `*Safety` taxonomy, **same `METHODOLOGY.md` formulas** — every method/field confirmed against the audited Rust source, none guessed. Registered in the indexer alongside Blend via `toTarget()`. See "Kinetic adapter" section below.
   - Each adapter: `fetchRawData()` (Soroban RPC + Horizon), `computeRiskFactors()` (shared taxonomy), `score()` (unchanged weighted formula). Registered in the indexer's `buildTargets()` via the existing `toTarget<T>()` wrapper so the run loop stays heterogeneous-but-typed (Kinetic's `TRawData` ≠ Blend's — exactly why the wrapper exists).
   - **← NEXT after Kinetic: a third adapter, or move to step 10 (site build-out).** Candidates for the next protocol are open — the original list named "YieldBlox, Kinetic, Templar"; YieldBlox is a Blend pool (skipped, see above), Kinetic is done, so **Templar** is the next named candidate. Verify it's a live, independent, on-chain-readable Stellar/Soroban protocol first (the YieldBlox/Kinetic research showed this can't be assumed). Alternatively the maintainer may judge two real protocols (Blend + Kinetic) enough substance to proceed to the site build-out (step 10). Decide at the start of the next session.

10. **After the adapters.** Dashboard/site build-out — homepage, About, docs, nav — on top of the barebones step-7 dashboard, now backed by real multi-protocol data from step 9. Positioning/copy comes _after_ the data exists, not before. Then, and only then, step 8 (deploy).

Local git initialized; commit history tracks scaffold → interface/blend scaffold → Blend adapter (`*Safety` taxonomy) → indexer → Postgres storage (`@stenion/db`) → public API (`d8fc512`) as checkpoints. GitHub org/remote still intentionally not set up — local-only for now. (Step 6 API is the last committed checkpoint; **step 7 dashboard + the CORS/port changes to `@stenion/api` are complete in the working tree but uncommitted** — commit when ready.)

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
