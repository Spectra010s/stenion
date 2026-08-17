# Stenion Roadmap

Where Stenion is and where it's going. This is a direction-of-travel document, not a dated
commitment — priorities shift as protocols launch and as the project finds funding.

## Live now

- **Continuous risk scoring for Stellar/Soroban lending protocols**, with a public, free, ranked
  registry sorted purely on `safetyScore` — payment-blind, no exceptions.
- **Two protocols scored end-to-end from live mainnet data:**
  - **[Blend](https://blend.capital)** — the flagship Fixed V2 pool. Reference implementation.
  - **[Kinetic / K2](https://k2lend.com)** — an Aave-V3-style single-pool-multi-asset protocol; the
    first adapter to exercise a genuinely different on-chain shape than Blend, validating the shared
    taxonomy against a non-Blend protocol.
- **The five-factor `*Safety` model** — collateral concentration, oracle trustworthiness, admin-key
  control, liquidity depth, utilization headroom — with a fully public, challengeable rulebook in
  [`METHODOLOGY.md`](METHODOLOGY.md).
- **Oracle robustness (methodology v2).** `oracleSafety` scores price freshness _and_ manipulation
  resistance: whether the pool's own price path bounds how far a single update can move, read from
  the protocol's own on-chain config. Freshness is anchored to each oracle's real resolution and
  max-age rather than to Stenion constants. Runs are stamped with the methodology version that
  produced them, so the discontinuity at the change is visible rather than silent.
- **Score history on the protocol page.** The append-only run history rendered as a chart of
  `safetyScore` over time — the visible form of the "continuous, not static" pitch. Plotted on a
  real time axis and a fixed 0–100 axis, and the line **breaks** rather than being drawn through
  anything unknown: a failed run, an indexing gap, or a methodology change. Hand-rolled SVG, no
  charting dependency.
- **Protocol identity — marks and verification links.** Each protocol carries a logo, the contract
  its score is derived from, and its own site/docs, all in adapter metadata rather than a frontend
  lookup table. Marks are self-hosted (never hotlinked), render in a fixed tile that works in both
  themes, and fall back to an initials tile for protocols with no usable mark. The protocol page
  links the scored contract on stellar.expert — the point being that a score should be checkable,
  not merely readable. Marks and links carry an explicit note that neither implies endorsement.
- **The full stack:** on-chain adapters → indexer → Postgres → API → dashboard, deployed as a single
  Vercel project with external (cron-job.org) scheduling. See [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Planned

Roughly in priority order, but not committed to dates:

- **More protocol adapters.** The open contribution path (see [`CONTRIBUTING.md`](CONTRIBUTING.md)).
  The bar: an _independently-scoreable native-Soroban lending protocol_ — not another Blend pool,
  not a deployment whose lending state lives on another chain.
  - **Nectar Network — watching for mainnet.** Flagged as the next protocol to evaluate once it's
    live on Stellar mainnet. Not built yet, and won't be until we can confirm from its own contracts
    that it's an independently-scoreable native-Soroban lending protocol (reserves/utilization/oracle
    readable via Soroban RPC + Horizon) rather than another Blend pool or another-chain deployment.
- **A longer history window (raising the 50-row detail cap).** `GET /api/v1/protocol/:id` returns
  the newest 50 runs, which at the current 5-minute cadence is about four hours. That is enough to
  show _an_ event and not enough to show a _pattern_, and the difference is load-bearing: K2's
  oracle freshness cycle produced two "fresh" episodes in 65 hours of observation, 9.3 hours apart,
  so a four-hour window usually renders a flat line and at best catches one excursion that reads as
  a one-off. Roughly 24 hours (~290 rows) is where a repeating cycle becomes legible as repeating.
  Wanted, but it is a payload-size and query-cost decision on free tiers, not a UI tweak — likely a
  separate downsampled endpoint or a `?window=` parameter rather than simply raising the cap, since
  the detail response is already the largest thing the API serves.
- **The Kinetic / K2 naming mismatch.** The protocol rebranded to **K2** (k2lend.com). Stenion still
  displays `name: 'Kinetic'`, and now shows it beside the K2 mark — the logo work made an existing
  inconsistency visible rather than creating it. Renaming isn't cosmetic: `id: 'kinetic'` is the
  `protocols` primary key, the `risk_scores` foreign key, the public URL `/protocol/kinetic`, and
  the `GET /api/v1/protocol/:id` path any external consumer has hardcoded. Changing the slug is a
  breaking API change (a `v2` under the versioning policy in [`ARCHITECTURE.md`](ARCHITECTURE.md));
  changing only the display `name` is free and additive. Almost certainly the latter, but it should
  be a decision rather than a drift.
- **Per-factor history.** `risk_scores` stores the full factor map on every row, so the data is
  already there, but the API exposes only `safetyScore` per history point. Charting a single
  factor over time — watching `oracleSafety` sawtooth on its own axis — is deliberately deferred
  until the window question above is settled, because it multiplies the same payload by five.
- **Scam / fake-asset warning API.** A real-time, queryable warning layer for wallets, built on top
  of [StellarExpert](https://stellar.expert)'s existing scam directory. A secondary feature, not the
  core pitch — but a natural fit for the "read the chain, warn users" mission.
- **Protocol self-service.** Let protocols claim their entry, read their factor breakdown, and
  challenge a threshold through a defined process — without ever being able to buy a better number.
  - **Which way the logo/links metadata leans, decided in advance.** `logo`, `contract_id`,
    `site_url` and `docs_url` are written from adapter metadata on **every** indexer cycle, so
    anything a protocol edited directly would be reverted within ~5 minutes. That is the correct
    default while these are maintainer-managed and reviewed in a PR. If self-service ships, a
    protocol-supplied mark must go in **separate columns that take precedence at read time** — not
    as an edit to these, and not by softening the upsert to preserve whatever is already there,
    which would quietly remove our ability to correct a protocol's own metadata. Presentation of a
    supplied mark shouldn't change: the same tile, the same attribution note, and no path by which
    a nicer logo touches a number.
- **Premium tiers.** Paid _visibility_ (a clearly-labeled, visually-separate "Spotlight" section),
  _speed_ (faster refresh), and _private tooling_ — never a paid score. The real registry stays free,
  public, and ranked purely on score. This is the intended business model, kept strictly walled off
  from the number.
- **AI explanations.** Plain-language summaries of _why_ a protocol scores the way it does, generated
  from the real underlying factor data. AI **only explains** — it never generates an independent risk
  assessment or sets a score.
- **Methodology v2 candidates** (breaking taxonomy changes, so deliberately not rushed):
  - **Market-depth-aware oracle scoring.** Shipped v2 grades whether a price bound _exists_, not how
    cheap the underlying market is to move — and thin depth is what made the YieldBlox manipulation
    cost ~$5. SDEX depth is readable from Horizon, but order books are trivially spoofed with walls
    that are never hit, it only applies to DEX-priced assets, and it can't be validated
    retroactively because the exploited market has since been rebuilt. Wanted, not yet shippable on
    a defensible anchor. (Several other candidates — TWAP, provider identity, source counting, and a
    Stenion-computed deviation — were investigated and **rejected**; the reasoning is recorded in
    [`METHODOLOGY.md`](METHODOLOGY.md) §2 so they aren't re-proposed.)
  - **Pause / frozen-pool state as a scored signal.** Both adapters already capture pause status in
    raw data (Blend's pool `status`, K2's `is_paused()`), but neither feeds a factor yet. Whether a
    paused pool should take a score hit — and how (new factor? multiplier? display-only flag?) — is a
    taxonomy decision affecting every adapter, so it's not been done ad hoc.
  - **Beyond lending: a taxonomy per protocol category.** The five `*Safety` factors are
    lending-specific by design — utilization against a borrow cap and liquidity headroom for
    withdrawals don't mean anything for an AMM. Scoring other categories means designing a taxonomy
    that fits how each one actually fails, not stretching the lending model over them:
    - **DEXs / AMMs** (Soroswap, Phoenix, Aquarius) — liquidity depth against realistic trade size,
      LP concentration, price divergence from reference markets.
    - **CDP / stablecoins** (FxDAO) — collateralization ratio, liquidation mechanism health, peg
      stability.
    - **Yield vaults** (DeFindex, Wellspring, Hoops Finance) — strategy transparency, underlying
      protocol exposure (a vault routing into Blend inherits Blend's risk), withdrawal liquidity.

    Each is a v2 project in its own right: a new taxonomy, designed and published to the same
    standard as the lending one, before any adapter is written. Lending stays the priority until its
    own methodology is settled — an unvalidated oracle-robustness factor is a bigger problem than an
    unscored category.

## Out of scope (for now)

- **Multi-chain.** Stenion is deliberately Stellar/Soroban-only. The non-negotiable rule that
  adapters read directly from trustless Stellar infra (Soroban RPC + Horizon) is core to the pitch —
  expanding to read another chain's state (e.g. to score a NEAR-based protocol like Templar) would be
  a category change to the whole trustless-Stellar positioning, not an incremental feature.
- **TVL tracking.** [DefiLlama](https://defillama.com) already covers TVL for Stellar. Stenion's
  differentiator is continuous _risk_ scoring, not another TVL dashboard.
- **Any paid mechanism that touches the score.** Not a "not yet" — a permanent no.

## Protocols investigated and skipped

Confirming a protocol is _not_ in scope from its own contracts — before writing scoring logic — is
part of the discipline, not a failure. Two notable cases:

- **YieldBlox.** Not an independent Soroban lending protocol. The YieldBlox DAO adopted Blend as its
  backbone; what exists today is a community-managed pool _on Blend V2_, using the identical Blend
  interface. A "YieldBlox adapter" would just be `BlendAdapter` pointed at a different pool. Could
  later be represented as a second Blend _pool_ via a small multi-pool refactor — tracked, not built.
- **Templar.** A NEAR-based, chain-abstraction ("Cypher Lending") protocol. Its lending market state
  — reserves, supply/borrow, utilization, collateral positions — lives on **NEAR**, read via NEAR
  RPC. Stellar is only a wallet/collateral entry point via NEAR MPC. The only native-Soroban contract
  it ships is a price oracle, so just 1 of 5 factors is natively on Stellar. A faithful adapter would
  need to read NEAR, breaking the trustless-Stellar rule. Could only be represented if Stenion's
  model expands to read NEAR — see "Out of scope."
