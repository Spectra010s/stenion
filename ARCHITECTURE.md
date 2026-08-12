# Stenion Architecture

The technical shape of the system: how the code is organized, how data flows from the chain to a
score on the dashboard, and how it's deployed. For *how a score is calculated*, see
[`METHODOLOGY.md`](METHODOLOGY.md); for *how to add a protocol*, see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Monorepo layout

Stenion is a [pnpm workspaces](https://pnpm.io/workspaces) monorepo. Each directory is an internal
package; the adapters import `@stenion/core`'s `Adapter` interface as a real typed dependency.

```
/core        — @stenion/core        Adapter interface + RiskFactorType taxonomy + shared types
/adapters    — @stenion/adapters    one file per protocol (blend.ts, kinetic.ts), each an Adapter
/db          — @stenion/db          Postgres layer: pg pool, typed Store, raw-SQL migrations
/indexer     — @stenion/indexer     scheduler that runs adapters on an interval, writes to Postgres
/api         — @stenion/api         standalone REST server (legacy — see "Why @stenion/api exists")
/dashboard   — @stenion/dashboard   Next.js site + the deployed API routes + the cron-trigger route
```

TypeScript is configured in three layers (see [`CLAUDE.md`](CLAUDE.md) for the rationale):

- `tsconfig.base.json` — shared compiler settings only (target, strict, etc.).
- `tsconfig.node.json` — extends base, adds `nodeNext` module/resolution. Backend packages
  (`core`, `db`, `indexer`, `api`, `adapters`) extend this.
- `dashboard` has its own Next.js-generated config (bundler resolution) — it does **not** extend
  the Node config.

### What each package does

**`@stenion/core`** — the contract everything else agrees on. Defines the `Adapter<TRawData>`
interface (`fetchRawData` → `computeRiskFactors` → `score`), the `RiskFactorType` enum (the fixed
five-factor `*Safety` taxonomy), and the shared result types. Adding a factor here is a breaking
change felt by every adapter, so it's deliberately small and stable. Carries
`ADAPTER_INTERFACE_VERSION` as a seam for future breaking changes.

**`@stenion/adapters`** — one file per protocol, each a class implementing `Adapter`. An adapter
reads a protocol's on-chain state (Soroban RPC + Horizon), reduces it into the five `*Safety`
factors using the formulas in `METHODOLOGY.md`, and produces a weighted `safetyScore`. Currently
`BlendAdapter` and `KineticAdapter`. Adapters throw on failure; they never swallow errors.

**`@stenion/db`** — the single, typed storage layer, shared by both the indexer (writes) and the
dashboard/API (reads) so there's no duplicated connection logic. Exposes a lazy singleton `pg`
`Pool` (`getPool`/`closePool`), a `createStore(pool)` factory with all read/write methods, env
loading, and the persisted `RunRecord` type. Two tables:

- `protocols` — one row per protocol (slug PK, name, chain, adapter class name). Upserted at
  indexer startup from adapter metadata.
- `risk_scores` — append-only history. `safety_score` is promoted to its own `numeric` column
  (it's what the registry ranks on); the five factors live in one `jsonb` column (displayed, not
  ranked, and growing the taxonomy then needs no migration). A DB-level CHECK enforces the
  `ok`/`failed` discriminated union.

Migrations are raw `.sql` files plus a ~40-line runner (`db/src/migrate.ts`) — no ORM.

**`@stenion/indexer`** — the scheduler. On an interval it runs every adapter through a small
`toTarget<T>()` wrapper (which hides each adapter's `TRawData` so a heterogeneous adapter list can
share one typed run loop), wraps each run in try/catch, and writes the outcome — score + factors,
or a failed marker — to Postgres. Deliberately dumb: one interval, no retries, no alerting. It
exports `runIndexerCycle()` (one cycle, used by the cron route) and guards its standalone loop
behind `require.main === module` so importing it doesn't start the loop.

**`@stenion/dashboard`** — a Next.js 15 (App Router) site, and the actual deployment target. It's
three things in one Vercel project:
1. The public site (homepage, registry, on-site methodology, about, per-protocol detail pages).
   Data pages are async Server Components that read `@stenion/db`'s `Store` **in-process** — no
   HTTP hop.
2. The public API, as Route Handlers: `GET /api/protocols`, `GET /api/protocol/:id`.
3. A secret-gated cron-trigger route (`POST /api/cron/run-indexer`) that runs one indexer cycle.

**`@stenion/api`** — a standalone `node:http` REST server. **Not deployed** — see below.

## Data flow

```
  Soroban RPC + Horizon              (trustless on-chain sources)
          │
          ▼
   Adapter.fetchRawData()            raw protocol state (per-adapter shape)
          │
          ▼
   Adapter.computeRiskFactors()      → the five *Safety factors (shared taxonomy)
          │
          ▼
   Adapter.score()                   → weighted safetyScore (0–100)
          │
          ▼
   Indexer (runIndexerCycle)         try/catch per adapter, one row per run
          │
          ▼
   Postgres  (@stenion/db)           protocols + risk_scores (append-only history)
          │
          ├──────────────┐
          ▼              ▼
   Dashboard pages   API routes      dashboard reads the Store in-process;
   (Server           (/api/*)        routes read the same Store for external
    Components)                       consumers (wallets, third parties)
```

The key invariant: **the dashboard's own pages and the public API routes both go through the same
`Store` methods** (`listProtocolsWithLatestScore`, `getProtocolDetail`), so the JSON contract and
what the site renders can't drift apart. Nothing is ever recomputed at read time — the indexer owns
scoring; readers only shape stored rows.

**Staleness model:** the displayed `safetyScore` is always the latest *ok* run (null if never
scored); the newest run of *any* status is surfaced separately as `lastRunAt`/`lastRunStatus`. A
registry that's honest about freshness beats one with holes on a failed cycle.

## Deploy architecture

**One Vercel project = the `dashboard`.** The indexer and the standalone API are not deployed as
separate services. Everything runs from the single Next.js app:

- **API** → Next.js Route Handlers inside the dashboard (`app/api/protocols`,
  `app/api/protocol/[id]`). Same `Store` methods, same JSON as the original standalone API — a
  transport change, not a rewrite. CORS (`access-control-allow-origin: *`) is set on these two
  routes only, for future browser/wallet/third-party clients reading public, payment-blind data.
- **Indexer** → triggered by `POST /api/cron/run-indexer`, which calls `runIndexerCycle()` once.
  The route is secret-gated (`Authorization: Bearer <CRON_SECRET>`, compared with
  `crypto.timingSafeEqual`); if `CRON_SECRET` is unset it refuses to run, so it's never open. No
  CORS on this route.
- **Scheduling is external** — a GitHub Actions workflow `curl`s the cron route every ~5 minutes.
  Vercel's Hobby-tier Cron is capped at once per day, too slow for live scoring; GitHub Actions is
  free and flexible.

**Build wiring:** the dashboard's `build` script compiles the workspace deps (`core` → `db` →
`adapters` → `indexer`) before `next build`, because those packages resolve via their `dist/`
output. `next.config.mjs` marks `pg` and `@stellar/stellar-sdk` as `serverExternalPackages` (kept
as runtime requires, not webpack-bundled) and pins `outputFileTracingRoot` to the repo root so
workspace-dep tracing is correct. On Vercel: Root Directory = `dashboard`, Build Command =
`pnpm run build`.

**Environment variables** (all on the one Vercel project, Production + Preview): `DATABASE_URL`
(Neon pooled), `STENION_RPC_URL`, `STENION_HORIZON_URL`, `CRON_SECRET`. Locally, every package
reads these from a single repo-root `.env` via a walk-up loader.

### Why `@stenion/api` exists but isn't deployed

`@stenion/api` was the original public API — a bare `node:http` server built before the deploy
architecture consolidated onto one Vercel project. Bare `node:http` doesn't fit Vercel's serverless
model, and running the API as a separate service from the dashboard is more moving parts for a solo,
pre-funding project to operate. So the two endpoints were re-homed as Next.js Route Handlers in the
dashboard (same `Store` methods, identical JSON contract).

The package is kept in the tree — as the reference for the original bare-Node implementation and in
case a standalone API service is ever wanted again — but it is **legacy and not deployed**. The
live API is the dashboard's routes.
