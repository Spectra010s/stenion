// Protocols and markets Stenion has assessed and does NOT score.
//
// WHAT THIS IS: the published form of a coverage decision. The registry shows
// what we score; without this, everything we investigated and declined is just
// absence — and absence tells a reader nothing. A stated reason tells them
// something true: that we looked, what we found, and how they can check it.
//
// WHAT THIS IS NOT: a score, a ranking, or a criticism. Nothing here is read by
// any scoring path, nothing here has a number, and an entry appearing here says
// something about Stenion's coverage rather than about the protocol. Same wall
// as PROTOCOL_NOTES and the payment rule — see CLAUDE.md.
//
// WHY A STATIC MODULE AND NOT THE `protocols` TABLE. Three reasons, the first
// decisive:
//
//  1. A `protocols` row with no `risk_scores` history ALREADY renders as
//     "never run — Stenion has not completed a scoring run for this protocol
//     yet" (see freshness() in ./format.ts). That is the our-pipeline-has-a-gap
//     state. Putting a deliberate decision in the same place collides it with
//     the very state this feature exists to separate.
//  2. Every row in `protocols` is written by upsertProtocol from adapter
//     metadata on every indexer cycle. These entries have no adapter, so
//     nothing would write them and nothing would keep them in step.
//  3. It would put unscored ids into GET /api/v1/protocols, which consumers
//     parse as the ranked leaderboard. A wallet rendering `safetyScore: null`
//     for Templar is worse than Templar's absence. Publishing this is a
//     separate additive endpoint (/api/v1/coverage), filed rather than
//     half-shipped.
//
// It is deliberately unrelated to the not-scorable RUN OUTCOME filed in
// ROADMAP.md. That is a different problem — a REGISTERED market that drains
// below the floor — and it needs a third RunRecord status, which is a breaking
// v2 change. These entries were never registered at all.
//
// THIS MODULE IS A LEAF: no imports, by design, so it stays trivially testable
// under Node's type-stripping loader (CLAUDE.md, "A tested module should be a
// leaf").
//
// BAR FOR ADDING ONE — the same bar as PROTOCOL_NOTES, plus a date rule:
//   - independently verifiable, and `verify` says exactly how. If you cannot
//     write that sentence, the entry does not go in.
//   - stated neutrally, explicit about what is verified versus inferred.
//   - `asOf` on any reason resting on a MEASUREMENT. "$3.62" is a reading, not
//     a property; an undated balance indexed by a search engine is a factual
//     assertion we would be making indefinitely.
//   - sourced from an investigation actually recorded in this repo. Figures
//     from a third-party aggregator that were never checked against contracts
//     are not a source — that rule is why Peridot and Slender are absent rather
//     than listed as dust.
//
// RECIPROCAL RULE: a protocol that becomes scorable loses its entry here in the
// SAME PR that registers it. The registry also filters live against the fetched
// leaderboard (see registry/page.tsx), so a forgotten entry self-heals rather
// than double-listing — but the cleanup is still part of that PR.

/**
 * Why an entry is not scored. Each member must correspond to a genuinely
 * different reason, because collapsing them into one "not scored" state loses
 * the information that makes publishing this worthwhile.
 *
 * Members are added when a real case appears, not in advance. `not-independent`
 * is deliberately absent: since multi-pool Blend targeting landed, a market
 * running another protocol's contracts is REGISTERED and SCORED carrying a
 * `deployedOn` label (the YieldBlox pool), so it is no longer a reason to be
 * unscored. A `deprecated` member is absent for the same reason — no evidenced
 * case exists today.
 */
export type CoverageStatus =
  /** Lending state lives on another chain; reading it would break the trustless-Stellar rule. */
  | 'off-chain-state'
  /** Scorable in principle, but holds too little for a number to carry information. */
  | 'below-size-floor'
  /** Not live on Stellar mainnet yet, so there is nothing to read. */
  | 'awaiting-mainnet'
  /**
   * Not a lending protocol. The five *Safety factors are lending-specific by
   * design, and no taxonomy exists for other categories yet.
   *
   * DELIBERATELY EMPTY AT LAUNCH. The ecosystem protocols this would cover
   * (Soroswap, Aquarius, FxDAO, DeFindex and the rest) carry a weaker claim
   * than the entries below: we categorised them from their own public
   * descriptions and never read their contracts. Seven such entries beside four
   * real investigations would let the weaker claim free-ride on the stronger
   * one. They arrive when the category expansion in ROADMAP.md is genuinely
   * underway, at which point "not in scope yet" comes with taxonomy work to
   * point at. Kept in the union so that is a data change, not a refactor.
   */
  | 'out-of-category';

export interface CoverageEntry {
  /** slug — the anchor id on /registry, and the key deduped against the live leaderboard */
  id: string;
  /** display name, as the protocol writes it */
  name: string;
  status: CoverageStatus;
  /**
   * Root-relative path to a mark this app hosts under `public/`, or null.
   *
   * Same rules as a scored entry (ProtocolMetadata.logo): self-hosted only,
   * never a hotlink, and null is a designed state — <ProtocolLogo> draws an
   * initials tile. An unscored entry carries a mark for the same reason a
   * scored one does: it is a real protocol we assessed, and the point of
   * listing it is that a reader recognises it.
   */
  logo: string | null;
  /**
   * The protocol's own site/docs. Null where this repo records no verified URL
   * — a guessed domain beside a protocol's name is worse than no link, because
   * it could point at a squatter.
   */
  links: { site: string | null; docs: string | null };
  /**
   * The contract we read, when we read one and recorded it in full.
   *
   * Null does real work here: it means we have no full address to link, so no
   * explorer link is offered and none is implied. Both K2 markets below are
   * recorded in this repo only in truncated form (`CCGXGXIL…`), so they carry
   * null and their `verify` gives the derivation path instead — which is how
   * the address was obtained in the first place.
   */
  contractId: string | null;
  /**
   * One sentence, for the registry row — the whole of what a scanner gets.
   *
   * Separate from `reason[0]` rather than derived from it, because deriving it
   * means truncating, and a coverage reason cut mid-sentence is worse than no
   * sentence at all. This is also the text that has to survive find-in-page on
   * /registry, so it is server-rendered on the row and never deferred to the
   * detail page.
   *
   * WRITTEN WITHOUT A FIGURE, deliberately. `asOf` dates a measurement, and the
   * row has no room to date one properly; a balance quoted in a summary would
   * be exactly the standing undated claim the date rule exists to stop. The
   * numbers live in `reason`, on the detail page, beside their date.
   */
  summary: string;
  /** Protocol-specific prose, one paragraph per element. Never a generic label. */
  reason: string[];
  /** How a reader checks this themselves. Required — see the bar above. */
  verify: string;
  /**
   * ISO date (YYYY-MM-DD) the measurement behind `reason` was taken. Required
   * for `below-size-floor`; null when the reason rests on structure rather than
   * on a reading, or when no dated check is on record.
   */
  asOf: string | null;
}

/**
 * Heading and framing per status. `chip` is what stands where a scored row has
 * its number, so it must read as a coverage statement in isolation — never as a
 * grade, and never with a numeral in it.
 */
export const COVERAGE_STATUS_META: Record<
  CoverageStatus,
  { heading: string; chip: string; blurb: string }
> = {
  'off-chain-state': {
    heading: 'Lending state is not on Stellar',
    chip: 'not natively Soroban',
    blurb:
      'Stenion’s adapters read trustless Stellar infrastructure — Soroban RPC and Horizon — and nothing else. A protocol whose reserves and positions live on another chain cannot be scored without reading that chain, which would change what the score means for every protocol.',
  },
  'below-size-floor': {
    heading: 'Below the market-size floor',
    chip: 'too small to score',
    blurb:
      'These markets can be read; there is just almost nothing in them. Scored anyway, every factor would fall to its can’t-assess branch and publish 0 — a number in the danger band, meaning the opposite of what is true. The floor is a precondition on scoring, not a quality bar: it says only that a number was computed from something rather than from nothing.',
  },
  'awaiting-mainnet': {
    heading: 'Not live on Stellar mainnet yet',
    chip: 'nothing to read yet',
    blurb:
      'Known, and on the list to evaluate. There is no mainnet deployment to read, so there is nothing to score — and nothing yet confirmed about whether it would be scorable when there is.',
  },
  'out-of-category': {
    heading: 'Outside the current scoring category',
    chip: 'lending only, for now',
    blurb:
      'Stenion scores lending protocols. The five factors are lending-specific by design — utilization against a borrow cap means nothing for an AMM — so other categories need their own taxonomy rather than the lending model stretched over them.',
  },
};

/**
 * The order statuses render in: investigated-and-decided first, because those
 * entries carry a real contract read behind them; watching-and-waiting after;
 * category scope last. A status with no members renders nothing at all — a
 * heading over an empty group describes members that aren't there.
 */
export const COVERAGE_STATUS_ORDER: readonly CoverageStatus[] = [
  'off-chain-state',
  'below-size-floor',
  'awaiting-mainnet',
  'out-of-category',
];

export const COVERAGE: readonly CoverageEntry[] = [
  {
    id: 'templar',
    name: 'Templar',
    status: 'off-chain-state',
    // No mark self-hosted, and none borrowed: the initials tile is the designed
    // fallback (see ProtocolLogo).
    logo: null,
    // This repo records no verified URL for Templar. Rather than guess a domain
    // beside their name, both stay null.
    links: { site: null, docs: null },
    contractId: null,
    summary:
      'A NEAR-based protocol whose reserves, balances and positions live on NEAR — the only contract it runs on Soroban is a price oracle.',
    reason: [
      'Templar is a NEAR-based chain-abstraction protocol — it calls its product “Cypher Lending” — and its lending market state lives on NEAR, not on Stellar. Reserves, supply and borrow balances, utilization and collateral positions are all read through NEAR RPC. Stellar’s role is as a wallet and collateral entry point via NEAR’s MPC signing, not as the ledger the lending market runs on.',
      'The only native-Soroban contract Templar ships is a price oracle. That is one of the five factors Stenion scores; the other four are on another chain. An adapter faithful to what Templar actually is would have to read NEAR, and Stenion’s adapters read trustless Stellar infrastructure and nothing else — that rule is the pitch rather than an implementation detail, so bending it for one protocol would quietly change what every other score means.',
      'This is a decision about where the data lives, not a judgment about Templar. It could be represented only if Stenion’s model expanded to read another chain, which ROADMAP.md keeps explicitly out of scope.',
    ],
    verify:
      'Follow Templar’s own documentation for where lending state is held, then confirm it against the chain: the Soroban contract it publishes on Stellar exposes an oracle interface (price reads), with no reserve, supply/borrow or position storage. There is no Soroban contract to call get_reserves_list, or any equivalent, against.',
    // Structural rather than a measurement — and this repo records no date for
    // the investigation, so none is claimed.
    asOf: null,
  },
  {
    id: 'k2-solvbtc-iso',
    name: 'K2 SolvBTC / xSolvBTC market',
    status: 'below-size-floor',
    // K2's own mark. Correct identity rather than borrowed identity: this is a
    // K2-listed market on a K2 router, running K2's code under K2's admin and
    // oracle — unlike the YieldBlox case, where the host protocol's mark would
    // have asserted exactly what the entry denies.
    logo: '/assets/protocols/kinetic.png',
    links: { site: 'https://k2lend.com', docs: 'https://docs.k2lend.com' },
    contractId: null,
    summary:
      'One of K2’s three live market routers, holding too little for a score to measure anything — and not named on K2’s own published contracts page.',
    reason: [
      'K2 runs its markets as separate router contracts rather than as configurations inside one pool, the same way Blend’s factory deploys pools. Three are live on mainnet, all deployed from byte-identical code (wasm df2831cf…), sharing one price oracle, one pool admin and one treasury. Stenion scores the primary market; this is one of the two it does not.',
      'It held $3.62 in total priced supplied value when read. Stenion’s market-size floor asks whether a market can hold at least one position the protocol itself considers viable, anchored to the protocol’s own on-chain minimum — Blend’s min_collateral of $5.00, borrowed here as an analogue because K2 declares none on chain, and flagged in METHODOLOGY.md as a judgment call for K2 rather than an anchor. At $3.62 this market cannot host even one such position.',
      'Worth stating separately, because it is the part that took work: this market is not on K2’s published contracts page. That page lists the xSolvBTC market as a set of reserve token addresses with no router among them, and repeats the primary market’s SolvBTC aToken and debt ledger beside them — which reads as though the market sits inside the primary pool. It does not. The router address was not read from any documentation; it came from the pool_address field in the xSolvBTC aToken’s own instance storage, whose State also names it “K2 Iso Interest Bearing SolvBTC” (kiSolvBTC). Calling get_reserve_data for xSolvBTC on the primary router returns Error(Contract, #24) — it is not a reserve there.',
      'Nothing here says the market is unsafe or that anything is hidden. An empty market is an empty market rather than a defective one, and documentation lagging deployment is ordinary. What is reported is that the market exists, that we found it, and that a number computed from $3.62 would be a measurement of absence rather than of risk.',
    ],
    verify:
      'Read the instance storage of the xSolvBTC aToken (CBMGL7ZL…HGYJ6JALVY) via Soroban RPC getLedgerEntries and take pool_address from its State — that resolves the router (CCGXGXIL…) in full. Call get_reserves_list on it, then total_supply on each aToken and debt ledger for the balances. Compare against the tables at docs.k2lend.com/contracts.',
    asOf: '2026-08-20',
  },
  {
    id: 'k2-earn',
    name: 'K2 Earn (earnUSDC)',
    status: 'below-size-floor',
    logo: '/assets/protocols/kinetic.png',
    links: { site: 'https://k2lend.com', docs: 'https://docs.k2lend.com' },
    contractId: null,
    summary:
      'K2’s third router, operated by Gami/Upshift rather than by K2, and holding nothing at all when we read it.',
    reason: [
      'The third of K2’s three live routers, operated by a third party — Gami/Upshift — rather than by K2 itself. K2 is explicit that the separation is real: “Isolation is enforced at the contract level: collateral and debt in a third-party market cannot be combined with positions in K2’s primary market.”',
      'It held $0.00 in total priced supplied value when read — not a small amount, but nothing at all. It fails the market-size floor outright. Pointing the rulebook at it would not fail: every factor would fall to its can’t-assess branch and the market would publish a score of 0, which renders in the danger band and tells a reader the opposite of what is true.',
      'K2’s own contract table is out of date in the other direction here. It gives the earnUSDC aToken and debt ledger as “TBA” and says they “will be added once deployed.” Both are deployed and wired — the router’s get_reserves_list returns earnUSDC alongside USDC, and get_current_reserve_data resolves an aToken at CCOPG2ZQ… and a debt ledger at CBO4TOFT…. Reported because a reader taking the published list as complete gets a different picture than the chain gives, not as a criticism of the operator.',
      'If it fills, it becomes scorable, and registering it is a config entry rather than an adapter: KineticAdapter already takes a routerId, exactly as BlendAdapter took a poolId before multi-pool targeting landed. That generalisation is deliberately not built, because building it now would be dead code guarding an empty list.',
    ],
    verify:
      'Call get_reserves_list on the Earn router (CDWPVHKB…KTPF6TZE) and get_current_reserve_data for each asset, which resolves the aToken and debt ledger addresses; read total_supply on each for the balances, and compare the resolved aToken against the “TBA” row at docs.k2lend.com/third-party-markets/contract-addresses.',
    asOf: '2026-08-20',
  },
  {
    id: 'nectar-network',
    name: 'Nectar Network',
    status: 'awaiting-mainnet',
    logo: null,
    // No verified URL recorded in this repo; same reasoning as Templar's links.
    links: { site: null, docs: null },
    contractId: null,
    summary:
      'Known and next on the list to evaluate, with no Stellar mainnet deployment to read yet — and nothing yet confirmed about whether it would be scorable when there is.',
    reason: [
      'Flagged as the next protocol to evaluate once it is live on Stellar mainnet. There is no deployment to read, so there is nothing to score.',
      'Listed to be clear about what is and is not known: nothing has been confirmed about whether Nectar would be scorable. That question gets settled from its own contracts when they exist — whether reserves, utilization, liquidity, admin and oracle are all readable via Soroban RPC and Horizon from contracts it controls, rather than the market turning out to be another Blend pool or a deployment whose state lives on another chain. Both of those have happened with other candidates.',
      'This entry rests on no dated check of our own. Unlike the K2 markets above, there is no reading behind it — it records that Nectar is known and being watched, not that its absence from mainnet was verified on some particular day.',
    ],
    verify:
      'Look for a Nectar deployment on Stellar mainnet. If one exists, the cheap first test is the one in CONTRIBUTING.md: read the contract’s instance storage, check whether Blend’s V2 pool factory (CDSYOAVX…) answers is_pool(address) with true, and compare its wasm hash against a known Blend pool. A byte-for-byte match means it is a Blend market, not an independent protocol.',
    asOf: null,
  },
];

/**
 * The entries to publish, given what the live leaderboard actually contains.
 *
 * Derived from what was fetched, never assumed — the same discipline as the
 * `deployedOn` note at the top of the registry. If a market listed here has
 * since been registered and scored, it must not also appear as unscored, and
 * the guard that prevents that has to read the real board rather than trust
 * this file to have been cleaned up. The cleanup is still the registering PR's
 * job; this only stops a forgotten entry from contradicting the board.
 *
 * An empty `scoredIds` (the leaderboard failed to load) yields the full list on
 * purpose: this section is static and stays true during a database outage, and
 * the registry's own error state already tells the reader the live data is
 * unavailable.
 */
export function coverageToPublish(scoredIds: Iterable<string>): CoverageEntry[] {
  const scored = new Set(scoredIds);
  return COVERAGE.filter((entry) => !scored.has(entry.id));
}

/**
 * One entry by id, or null — the lookup behind /coverage/[id].
 *
 * Null is a real 404 at that route, NOT a fallback to some generic page: an id
 * we hold no coverage decision for is an id we have nothing true to say about,
 * and a page that says "not scored" for an arbitrary slug would manufacture a
 * coverage claim out of a typo.
 *
 * Note what this deliberately does not do: it never consults the live
 * leaderboard. The dedupe against scored ids belongs to the route (which
 * redirects to /protocol/[id]), because it needs data this leaf module has no
 * business fetching — see coverageToPublish for the same split.
 */
export function coverageById(id: string): CoverageEntry | null {
  return COVERAGE.find((entry) => entry.id === id) ?? null;
}

/**
 * Entries grouped by status, in COVERAGE_STATUS_ORDER, omitting any status with
 * no members. Empty groups are dropped here rather than in the view, so the
 * "never render a heading over nothing" rule holds wherever this is consumed.
 */
export function groupCoverage(
  entries: readonly CoverageEntry[],
): { status: CoverageStatus; entries: CoverageEntry[] }[] {
  return COVERAGE_STATUS_ORDER.map((status) => ({
    status,
    entries: entries.filter((e) => e.status === status),
  })).filter((group) => group.entries.length > 0);
}
