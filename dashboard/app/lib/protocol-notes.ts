// Per-protocol findings surfaced on a protocol's detail page.
//
// WHAT THIS IS: verifiable observations about a protocol's on-chain setup that
// a reader of its entry should see, but that are NOT scored — either because
// they aren't a risk measurement, or because scoring them would require
// inventing a threshold we can't anchor. Surfacing what we found but didn't
// score is part of the job; burying it in a methodology footnote isn't.
//
// WHAT THIS IS NOT: an input to any number. Nothing here touches `safetyScore`
// or any factor. The registry ranks purely on score, and a note — favourable or
// not — can never move it. Same wall as the payment rule.
//
// BAR FOR ADDING ONE: independently verifiable from chain or from public
// source, stated neutrally, and explicit about what is verified versus what is
// inferred. No speculation about intent, no accusation. If we can't say exactly
// how a reader could check it themselves, it doesn't go here.

export interface ProtocolNote {
  title: string;
  /** Each paragraph rendered separately. Plain text — no markup. */
  body: string[];
  /** How a reader can verify this themselves. */
  verify: string;
}

export const PROTOCOL_NOTES: Record<string, ProtocolNote[]> = {
  kinetic: [
    {
      title: "The price feed is older than K2's own staleness threshold in most observed runs",
      body: [
        'Between 2026-08-11 18:16 and 2026-08-14 11:45 UTC, Stenion recorded 267 scored ' +
          "runs against K2. In 243 of them — 91% — the worst-priced reserve's price was " +
          'older than 3600 seconds, which is price_staleness_threshold: K2’s own ' +
          'on-chain limit, not a Stenion constant. The oldest price observed in that ' +
          'window was 43,147 seconds (11h 59m), within a minute of the per-asset max_age ' +
          'of 43,200 seconds.',
        'It is not a continuous outage. The feed refreshes to an age of a few hundred ' +
          'seconds, climbs back past the threshold over roughly an hour, and then sits ' +
          'there for hours before refreshing again. That cycle is what makes the overall ' +
          'score oscillate, and it is visible as a repeating sawtooth in the score ' +
          'history above — the oscillation is the price ageing out and being renewed, ' +
          'not the pool’s risk genuinely changing every few minutes.',
        'The runs behind this were recorded during development, and that stored history ' +
          'has since been discarded — Stenion’s score history now starts fresh under the ' +
          'published methodology, so these counts cannot be re-derived from the API. What ' +
          'is stated here is an observation that was made, not a claim about rows you can ' +
          'still fetch. The condition itself is checkable on-chain today by anyone, by the ' +
          'steps below.',
        'What is not being claimed: the circuit breaker was scored 100 throughout, so ' +
          'the bound on a single-step price move is armed — this is purely about ' +
          'freshness. And a price past a staleness threshold does not by itself mean the ' +
          'protocol acts on it. K2’s own code may reject the stale price and revert ' +
          'whatever operation depended on it. What is observable from outside is the age ' +
          'of the price the oracle serves, not which of those two follows. Both matter ' +
          'to a depositor — one means positions can be valued on an hours-old price, the ' +
          'other means borrowing or liquidation may be unavailable for long stretches — ' +
          'but separating them needs a call path we cannot observe.',
        'Recorded here as well as scored because a factor value shows the state right ' +
          'now. An oracleSafety of 0 in this instant and an oracleSafety that has been 0 ' +
          'for most of three days are different facts, and only the second one is a ' +
          'pattern.',
      ],
      verify:
        'Read ORACLE from the kinetic_router instance storage ' +
        '(CCTUJZLY…AWNXOJIV6J7) via Soroban RPC, then call get_asset_prices_vec_fresh on ' +
        'that oracle and compare each PriceData.timestamp against the current ledger ' +
        'close time. Read the thresholds from the same contract: get_oracle_config for ' +
        'price_staleness_threshold, and get_asset_config per asset for max_age.',
    },
    {
      title: 'The deployed price oracle is a superset of its audited version',
      body: [
        "K2's price oracle contract (CCHRZE2K…) exports 44 functions. Thirty-five of " +
          'them match the audited source published for the Code4rena review ' +
          '(code-423n4/2026-04-k2), and the deployed contract reports the same ' +
          'version() == 2 that source declares. Nine do not appear in the audited ' +
          'code at all: four *_as_admin variants, get_asset_prices_vec_fresh, and a ' +
          'four-function secondary-feed subsystem.',
        'The live kinetic_router prices its reserves through one of those additions. ' +
          'Scanning the deployed router for the oracle method symbols it references ' +
          'shows get_asset_prices_vec_fresh present and get_asset_price_data — the ' +
          'method whose circuit-breaker enforcement is verifiable in the audited ' +
          'source — absent.',
        "This matters to K2's oracleSafety score. The 20% circuit breaker " +
          '(max_price_change_bps) is enforced on every return path of ' +
          'get_asset_price_data in the audited source, and its audited sibling ' +
          'get_asset_prices_vec enforces it too. All three methods return identical ' +
          'price data today. On that basis Stenion scores the breaker as enforced — ' +
          'but the path the pool actually uses has no public source, so that is an ' +
          'inference, not a verification, and it is recorded as one.',
        'Stated neutrally: a deployed contract diverging from its audited snapshot is ' +
          'common and the additions may be entirely sound. What is being reported is ' +
          'the divergence and its consequence for what we can and cannot verify — not ' +
          'a claim that anything is wrong.',
      ],
      verify:
        'Fetch the contract code for CCHRZE2K…5BNOMQRMU and CCTUJZLY…AWNXOJIV6J7 via ' +
        'Soroban RPC getLedgerEntries and read the wasm export section; compare against ' +
        'contracts/price-oracle/src/contract.rs in code-423n4/2026-04-k2.',
    },
    {
      title: 'get_price_with_protection provides no protection',
      body: [
        "In K2's audited oracle source, oracle.rs defines get_price_with_protection " +
          'and get_price_with_protection_fallback. Both ignore their _config ' +
          'parameter and call the underlying query function directly — neither ' +
          'applies a circuit breaker or any other check.',
        'This is not a hole: the real validation runs one level up, in ' +
          'validate_price_change inside get_asset_price_data, so prices are still ' +
          'checked. It is recorded because the name asserts a guarantee the function ' +
          'does not provide, which is the kind of thing that misleads anyone reading ' +
          'the source to understand how the oracle is defended.',
      ],
      verify:
        'Read contracts/price-oracle/src/oracle.rs in code-423n4/2026-04-k2 and follow ' +
        'the call sites of validate_price_change in contract.rs.',
    },
  ],
};

export function notesFor(protocolId: string): ProtocolNote[] {
  return PROTOCOL_NOTES[protocolId] ?? [];
}
