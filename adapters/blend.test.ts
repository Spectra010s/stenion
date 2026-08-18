// Fixture tests for BlendAdapter.computeRiskFactors.
//
// WHY THESE EXIST: `computeRiskFactors` is a pure function of already-decoded
// on-chain state, so every rule in METHODOLOGY.md can be exercised here without
// touching RPC. That matters most for `oracleSafety` (METHODOLOGY.md §2), whose
// whole point is separating pools that live mainnet data cannot currently
// separate: the Blend Fixed V2 pool prices fresh and bounded on every reserve,
// so a live run proves nothing about the disabled-bound path — the path that
// the February 2026 YieldBlox incident actually ran through.
//
// Everything below is synthetic. The captured-mainnet snapshot fixtures, which
// guard against a refactor moving published numbers, are a separate concern.
//
// Run with: pnpm --filter @stenion/adapters test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BlendAdapter } from './blend.ts';
import type { BlendRawData, BlendReserveRaw } from './blend.ts';
import type { RiskFactor } from '@stenion/core';

// ---------------------------------------------------------------------------
// Synthetic raw-state builders
// ---------------------------------------------------------------------------

const SCALAR_12 = 10n ** 12n;
const SCALAR_7 = 10n ** 7n;

/** Fixed clock, so a reserve's price age is a property of the fixture, not of when the test ran. */
const FETCHED_AT = 1_760_000_000;
const ORACLE_DECIMALS = 14;

interface ReserveOpts {
  asset?: string;
  decimals?: number;
  supplied?: number;
  borrowed?: number;
  /** price in USD, or null for "the oracle returned no price for this asset" */
  price?: number | null;
  /** how far behind `fetchedAt` the price's publish timestamp sits */
  ageSeconds?: number;
  /** the aggregator's per-asset max_dev, or null for "no aggregator entry at all" */
  maxDev?: number | null;
  oracleIndex?: number;
  /** max_util as a fraction, e.g. 0.95 */
  cap?: number;
}

function reserve(o: ReserveOpts = {}): BlendReserveRaw {
  const {
    asset = 'CRESERVEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    decimals = 7,
    supplied = 1_000,
    borrowed = 500,
    price = 1,
    ageSeconds = 0,
    maxDev = 60,
    oracleIndex = 0,
    cap = 0.95,
  } = o;

  // Pick rate = 1.0 (SCALAR_12) so supply shares are the underlying amount and
  // the fixture reads in human units: supplied = bSupply×bRate / (1e12×10^dec).
  const unit = BigInt(10) ** BigInt(decimals);
  return {
    asset,
    config: {
      decimals,
      cFactor: SCALAR_7,
      lFactor: SCALAR_7,
      util: 0n,
      maxUtil: BigInt(Math.round(cap * Number(SCALAR_7))),
      enabled: true,
    },
    data: {
      dRate: SCALAR_12,
      bRate: SCALAR_12,
      bSupply: BigInt(Math.round(supplied)) * unit,
      dSupply: BigInt(Math.round(borrowed)) * unit,
    },
    price:
      price === null
        ? null
        : {
            value: BigInt(Math.round(price * 10 ** ORACLE_DECIMALS)),
            timestamp: FETCHED_AT - ageSeconds,
          },
    priceConfig: maxDev === null ? null : { upstreamAsset: 'Other:TEST', oracleIndex, maxDev },
  };
}

interface RawOpts {
  reserves?: BlendReserveRaw[];
  /** the aggregator's own max_age() */
  maxAge?: number;
  /** the upstream feed's publish interval */
  resolution?: number;
  baseAssets?: string[];
  admin?: BlendRawData['admin'];
  /**
   * The pool's `min_collateral` in USD — leg A of §4/§5's minimum-size filter.
   * Defaults to the live Fixed V2 pool's $5.00 so the synthetic pools here are
   * filtered by the same rule mainnet is. Pass 0 for a pool declaring none.
   */
  minCollateralUsd?: number;
}

function makeRaw(o: RawOpts = {}): BlendRawData {
  const {
    reserves = [reserve()],
    maxAge = 900,
    resolution = 300,
    baseAssets = [],
    // Contract-governed admin by default: a flagged neutral 60 that doesn't
    // depend on Horizon, so adminKeySafety never perturbs an oracle assertion.
    admin = { address: 'CADMIN…', isContract: true, account: null },
    minCollateralUsd = 5,
  } = o;

  return {
    poolId: 'CPOOL…',
    oracleId: 'CORACLE…',
    oracleDecimals: ORACLE_DECIMALS,
    status: 0,
    // Stored in the oracle's base-asset decimals, as on chain — so the test's
    // ORACLE_DECIMALS of 14, not the live pool's 7. Reading it back through
    // oracleDecimals is part of what the adapter is being tested on.
    minCollateral: BigInt(Math.round(minCollateralUsd * 10 ** ORACLE_DECIMALS)),
    admin,
    oracleConfig: {
      maxAge,
      baseAssets,
      oracles: [{ index: 0, address: 'CFEED…', resolution, decimals: ORACLE_DECIMALS }],
    },
    reserves,
    fetchedAt: FETCHED_AT,
  } satisfies BlendRawData;
}

const adapter = new BlendAdapter();

async function factors(raw: BlendRawData) {
  return adapter.computeRiskFactors(raw);
}

const sub = (f: RiskFactor, id: string): number | null | undefined =>
  f.components?.find((c) => c.id === id)?.value;

// ---------------------------------------------------------------------------

describe('oracleSafety — deviation bound (METHODOLOGY.md §2b)', () => {
  // METHODOLOGY.md §2b: bounded iff `0 < max_dev < 100`, mirroring the
  // aggregator's own condition in oracle-aggregator/src/price_data.rs.
  const cases: [number, number, string][] = [
    [0, 0, 'check disabled outright — the YieldBlox configuration'],
    [1, 100, 'the tightest bound that still counts as armed'],
    [60, 100, 'a typical live Blend value'],
    [99, 100, 'the loosest bound still inside the contract condition'],
    [100, 0, 'NOT a very loose bound — at >= 100 the contract skips the check'],
    [101, 0, 'above the range, check skipped'],
  ];

  for (const [maxDev, expected, why] of cases) {
    it(`max_dev ${maxDev} → deviationBound ${expected} (${why})`, async () => {
      const f = await factors(makeRaw({ reserves: [reserve({ maxDev })] }));
      assert.equal(sub(f.oracleSafety!, 'deviationBound'), expected);
    });
  }

  it('treats a reserve with no aggregator entry as unbounded, not as absent', async () => {
    // No entry means the asset cannot be priced at all — scoring it 0 rather
    // than skipping it is the "missing feed is maximally unsafe" rule.
    const f = await factors(makeRaw({ reserves: [reserve({ maxDev: null })] }));
    assert.equal(sub(f.oracleSafety!, 'deviationBound'), 0);
    assert.match(f.oracleSafety!.detail, /cannot be priced/);
  });

  it('takes the worst reserve, so one disabled bound sinks the pool', async () => {
    const f = await factors(
      makeRaw({
        reserves: [
          reserve({ asset: 'CBOUNDED…', maxDev: 60 }),
          reserve({ asset: 'CDISABLED…', maxDev: 0 }),
        ],
      }),
    );
    assert.equal(sub(f.oracleSafety!, 'deviationBound'), 0);
  });
});

describe('oracleSafety — price freshness (METHODOLOGY.md §2a)', () => {
  it('scores a price newer than one publish interval as fully fresh', async () => {
    const f = await factors(makeRaw({ reserves: [reserve({ ageSeconds: 0 })] }));
    assert.equal(sub(f.oracleSafety!, 'priceFreshness'), 100);
  });

  it("grades linearly between the protocol's own resolution and max_age", async () => {
    // fresh = 300 (resolution), dead = 900 (max_age). Half way is 600s.
    for (const [age, expected] of [
      [300, 100],
      [600, 50],
      [900, 0],
      [1200, 0],
    ]) {
      const f = await factors(makeRaw({ reserves: [reserve({ ageSeconds: age })] }));
      assert.equal(
        sub(f.oracleSafety!, 'priceFreshness'),
        expected,
        `age ${age}s should score ${expected}`,
      );
    }
  });

  it('scores a reserve with no oracle price as 0, not as missing', async () => {
    const f = await factors(makeRaw({ reserves: [reserve({ price: null })] }));
    assert.equal(sub(f.oracleSafety!, 'priceFreshness'), 0);
  });

  it('caps the dead anchor at STALE_CEILING_SECONDS rather than trusting max_age', async () => {
    // A protocol declaring a 12h max age must not thereby score better for
    // tolerating staler prices (METHODOLOGY.md §2a). With the cap, dead = 3600
    // and a 1950s-old price is mid-scale; without it, dead would be 43200 and
    // the same price would score ~96.
    const f = await factors(
      makeRaw({ maxAge: 43_200, reserves: [reserve({ ageSeconds: 1_950 })] }),
    );
    assert.equal(sub(f.oracleSafety!, 'priceFreshness'), 50);
  });
});

describe('oracleSafety — the composite takes the binding constraint', () => {
  it('is 100 only when the price is both fresh and bounded', async () => {
    const f = await factors(makeRaw({ reserves: [reserve({ ageSeconds: 0, maxDev: 60 })] }));
    assert.equal(f.oracleSafety!.value, 100);
  });

  it('a fresh but unbounded price scores 0 — the age-only failure mode', async () => {
    // An oracle factor that scored price age alone would give this 100. This
    // single assertion is why §2 takes the binding constraint of two sub-signals
    // instead.
    const f = await factors(makeRaw({ reserves: [reserve({ ageSeconds: 0, maxDev: 0 })] }));
    assert.equal(sub(f.oracleSafety!, 'priceFreshness'), 100);
    assert.equal(sub(f.oracleSafety!, 'deviationBound'), 0);
    assert.equal(f.oracleSafety!.value, 0, 'the bound must bind');
  });

  it('a bounded but dead price also scores 0 — the other direction', async () => {
    const f = await factors(makeRaw({ reserves: [reserve({ ageSeconds: 5_000, maxDev: 60 })] }));
    assert.equal(sub(f.oracleSafety!, 'priceFreshness'), 0);
    assert.equal(sub(f.oracleSafety!, 'deviationBound'), 100);
    assert.equal(f.oracleSafety!.value, 0, 'freshness must bind');
  });

  it('takes the lower of the two when both are partial', async () => {
    const f = await factors(makeRaw({ reserves: [reserve({ ageSeconds: 600, maxDev: 60 })] }));
    assert.equal(f.oracleSafety!.value, 50);
  });
});

describe('oracleSafety — base assets are excluded, not scored 0 (§2b)', () => {
  const BASE = 'CBASEASSET…';

  it('does not let an unbounded base asset drag the factor down', async () => {
    // The aggregator short-circuits its base assets to exactly 1.0 without
    // consulting a feed, so there is no oracle-derived price to grade. Scoring
    // them 0 would be measuring the absence of a mechanism that doesn't apply.
    const f = await factors(
      makeRaw({
        baseAssets: [BASE],
        reserves: [reserve({ asset: BASE, maxDev: 0 }), reserve({ asset: 'CGRADED…', maxDev: 60 })],
      }),
    );
    assert.equal(f.oracleSafety!.value, 100);
  });

  it('discloses how many reserves were excluded', async () => {
    const f = await factors(
      makeRaw({
        baseAssets: [BASE],
        reserves: [reserve({ asset: BASE }), reserve({ asset: 'CGRADED…' })],
      }),
    );
    assert.match(f.oracleSafety!.components![2].detail, /1 base asset\(s\) excluded/);
  });

  it('scores 0 when every reserve is a base asset — nothing left to grade', async () => {
    const f = await factors(makeRaw({ baseAssets: [BASE], reserves: [reserve({ asset: BASE })] }));
    assert.equal(f.oracleSafety!.value, 0);
    assert.match(f.oracleSafety!.detail, /every reserve is an oracle base asset/);
  });
});

describe('oracleSafety — bound tightness is disclosed, never scored (§2c)', () => {
  it('publishes the raw max_dev as a null-valued disclosure component', async () => {
    // A null component value means "measured, shown, deliberately not graded" —
    // never missing data. Grading tightness would invent comparability between
    // Blend's per-publish-interval bound and K2's per-query one.
    const f = await factors(makeRaw({ reserves: [reserve({ maxDev: 60 })] }));
    const tightness = f.oracleSafety!.components!.find((c) => c.id === 'deviationTightness');
    assert.ok(tightness, 'expected a deviationTightness component');
    assert.equal(tightness.value, null);
    assert.match(tightness.detail, /60%/);
    assert.match(tightness.detail, /not graded/);
  });

  it('keeps the disclosure unscored even when the bound is disabled', async () => {
    const f = await factors(makeRaw({ reserves: [reserve({ maxDev: 0 })] }));
    assert.equal(
      f.oracleSafety!.components!.find((c) => c.id === 'deviationTightness')!.value,
      null,
    );
  });
});

describe('collateralSafety — normalized HHI (§1)', () => {
  it('scores an even two-reserve split as fully diversified', async () => {
    const f = await factors(
      makeRaw({
        reserves: [
          reserve({ asset: 'CA…', supplied: 500 }),
          reserve({ asset: 'CB…', supplied: 500 }),
        ],
      }),
    );
    assert.equal(f.collateralSafety!.value, 100);
  });

  it('grades a skewed split against the best that many reserves could do', async () => {
    // 75/25 → HHI 0.625, min 0.5 → (1−0.625)/(1−0.5) = 75.
    const f = await factors(
      makeRaw({
        reserves: [
          reserve({ asset: 'CA…', supplied: 750 }),
          reserve({ asset: 'CB…', supplied: 250 }),
        ],
      }),
    );
    assert.equal(f.collateralSafety!.value, 75);
  });

  it('scores a single priced reserve 0 — concentrated by definition', async () => {
    const f = await factors(makeRaw({ reserves: [reserve()] }));
    assert.equal(f.collateralSafety!.value, 0);
    assert.match(f.collateralSafety!.detail, /single priced reserve/);
  });

  it('scores 0 when nothing can be priced, rather than guessing', async () => {
    const f = await factors(
      makeRaw({ reserves: [reserve({ price: null }), reserve({ asset: 'CB…', price: null })] }),
    );
    assert.equal(f.collateralSafety!.value, 0);
    assert.match(f.collateralSafety!.detail, /no priced supplied value/);
  });

  it('ignores unpriced reserves rather than counting them as zero-value', async () => {
    // An unpriced reserve is excluded from the concentration calculation
    // entirely; it must not silently look like a third, empty holding.
    const f = await factors(
      makeRaw({
        reserves: [
          reserve({ asset: 'CA…', supplied: 500 }),
          reserve({ asset: 'CB…', supplied: 500 }),
          reserve({ asset: 'CC…', supplied: 999, price: null }),
        ],
      }),
    );
    assert.equal(f.collateralSafety!.value, 100);
  });
});

describe('adminKeySafety — tiered base minus activity penalty (§3)', () => {
  const withAdmin = (
    account: NonNullable<BlendRawData['admin']['account']> | null,
    isContract = false,
  ) => makeRaw({ admin: { address: isContract ? 'CADMIN…' : 'GADMIN…', isContract, account } });

  const acct = (signerCount: number, highThreshold: number, recentOps = 0) => ({
    signerCount,
    highThreshold,
    recentOps,
    activityWindowDays: 30,
  });

  it('gives a contract-governed admin the flagged neutral baseline', async () => {
    const f = await factors(withAdmin(null, true));
    assert.equal(f.adminKeySafety!.value, 60);
    assert.match(f.adminKeySafety!.detail, /neutral baseline/);
  });

  it('scores a lone master key 40 and a real multisig 90', async () => {
    assert.equal((await factors(withAdmin(acct(1, 1)))).adminKeySafety!.value, 40);
    assert.equal((await factors(withAdmin(acct(3, 2)))).adminKeySafety!.value, 90);
  });

  it('requires BOTH multiple signers and a high threshold above 1', async () => {
    // Extra signers with a threshold of 1 still permit unilateral action, so
    // this must not read as multisig. Reading Stellar's actual threshold model
    // rather than the signer count alone is the point.
    const f = await factors(withAdmin(acct(4, 1)));
    assert.equal(f.adminKeySafety!.value, 40);
    assert.match(f.adminKeySafety!.detail, /single-key/);
  });

  it('subtracts 3 per recent op, capped at 30 so structure still dominates', async () => {
    assert.equal((await factors(withAdmin(acct(1, 1, 5)))).adminKeySafety!.value, 25);
    assert.equal((await factors(withAdmin(acct(3, 2, 3)))).adminKeySafety!.value, 81);
    // Cap: 100 ops would be −300 uncapped, which would put a busy multisig
    // below an idle single key.
    assert.equal((await factors(withAdmin(acct(3, 2, 100)))).adminKeySafety!.value, 60);
    assert.equal((await factors(withAdmin(acct(1, 1, 100)))).adminKeySafety!.value, 10);
  });
});

describe('the factor map itself', () => {
  it('populates all five factors, each with a real detail string', async () => {
    const f = await factors(makeRaw());
    for (const [key, value] of Object.entries(f)) {
      assert.ok(value !== undefined, `${key} must be present`);
      assert.ok(value !== null, `${key} should be populated for a normal Blend pool`);
      assert.ok(value.detail.length > 0, `${key} needs a human-readable detail`);
      assert.ok(value.value >= 0 && value.value <= 100, `${key} out of the 0-100 range`);
    }
  });

  it('carries the weights METHODOLOGY.md documents', async () => {
    const f = await factors(makeRaw());
    assert.equal(f.collateralSafety!.weight, 0.2);
    assert.equal(f.oracleSafety!.weight, 0.25);
    assert.equal(f.adminKeySafety!.weight, 0.2);
    assert.equal(f.liquiditySafety!.weight, 0.15);
    assert.equal(f.utilizationSafety!.weight, 0.2);
  });
});

// ---------------------------------------------------------------------------
// "Nothing to measure" scores 0, never 100.
//
// §4 defines liquiditySafety as `min(free)` over reserves with supplied > 0, and
// §5 defines utilizationSafety as `min(headroom)` over reserves with supplied > 0
// AND cap > 0. Over an empty set that minimum is undefined — it is emphatically
// not the maximum. Both factors previously seeded their accumulators at the top
// of the scale and `continue`d past every reserve, so a pool with nothing
// measurable published 100: maximally safe, derived from no data, which ground
// rule 4 forbids. 0 is both the honest answer and the direction it is safe to be
// wrong in, and it matches what collateralSafety already did for the same case.
//
// No stored score was ever affected — the whole published history was scanned
// for the signature the defect leaves behind (a `worst reserve (…)` naming no
// asset) and matched zero rows — so this was a correction under the existing
// rulebook, not a methodology change. See METHODOLOGY.md's "Corrections that did
// not bump the version" table for the check and its date.
// ---------------------------------------------------------------------------

describe('no measurable reserves — cannot assess, so 0 not 100', () => {
  it('liquiditySafety: a pool with no reserves cannot be assessed', async () => {
    const f = await factors(makeRaw({ reserves: [] }));
    assert.equal(f.liquiditySafety!.value, 0, 'min over an empty set is not 100');
  });

  it('liquiditySafety: every reserve empty is equally unassessable', async () => {
    const f = await factors(
      makeRaw({
        reserves: [
          reserve({ asset: 'CA…', supplied: 0, borrowed: 0 }),
          reserve({ asset: 'CB…', supplied: 0, borrowed: 0 }),
        ],
      }),
    );
    assert.equal(f.liquiditySafety!.value, 0);
  });

  it('liquiditySafety: does not describe a reserve that does not exist', async () => {
    const f = await factors(makeRaw({ reserves: [] }));
    assert.doesNotMatch(
      f.liquiditySafety!.detail,
      /worst reserve/,
      'the detail names a nonexistent worst reserve',
    );
  });

  it('utilizationSafety: a pool with no reserves cannot be assessed', async () => {
    const f = await factors(makeRaw({ reserves: [] }));
    assert.equal(f.utilizationSafety!.value, 0);
  });

  it('utilizationSafety: every reserve empty is equally unassessable', async () => {
    const f = await factors(makeRaw({ reserves: [reserve({ supplied: 0, borrowed: 0 })] }));
    assert.equal(f.utilizationSafety!.value, 0);
  });

  it('utilizationSafety: no reserve carries a configured cap', async () => {
    // Sharper than the empty case: these reserves have real balances, but
    // max_util = 0 means §5's `cap > 0` filter skips every one of them. The pool
    // must not be scored as having perfect headroom below a line nobody set.
    const f = await factors(
      makeRaw({
        reserves: [
          reserve({ asset: 'CA…', supplied: 1_000, borrowed: 900, cap: 0 }),
          reserve({ asset: 'CB…', supplied: 1_000, borrowed: 950, cap: 0 }),
        ],
      }),
    );
    assert.equal(f.utilizationSafety!.value, 0, 'no configured cap means no headroom to report');
  });

  it('utilizationSafety: the two "cannot assess" reasons are distinguishable', async () => {
    // These are different findings and must not share one generic message: an
    // empty pool is not the same problem as a pool holding real debt against no
    // declared ceiling. Someone debugging cap configuration has to be able to
    // grep for the cap case specifically and not match the empty case.
    const noSupply = await factors(
      makeRaw({ reserves: [reserve({ supplied: 0, borrowed: 0, cap: 0.9 })] }),
    );
    const noCap = await factors(
      makeRaw({ reserves: [reserve({ supplied: 1_000, borrowed: 900, cap: 0 })] }),
    );

    assert.equal(noSupply.utilizationSafety!.value, 0);
    assert.equal(noCap.utilizationSafety!.value, 0);
    assert.notEqual(
      noSupply.utilizationSafety!.detail,
      noCap.utilizationSafety!.detail,
      'the two cases must not produce the same detail string',
    );

    assert.match(noSupply.utilizationSafety!.detail, /no reserve has any supplied value/);
    assert.doesNotMatch(noSupply.utilizationSafety!.detail, /max_util/);

    assert.match(noCap.utilizationSafety!.detail, /configured utilization cap \(max_util\)/);
    assert.doesNotMatch(noCap.utilizationSafety!.detail, /no reserve has any supplied value/);
    // The cap case still knows how many reserves it looked at — the distinction
    // is real branching on real state, not two spellings of one dead end.
    assert.match(noCap.utilizationSafety!.detail, /1 supplied reserve/);
  });

  it('utilizationSafety: does not describe a reserve that does not exist', async () => {
    const f = await factors(makeRaw({ reserves: [] }));
    assert.doesNotMatch(f.utilizationSafety!.detail, /worst reserve/);
  });
});

// ---------------------------------------------------------------------------
// The minimum-size filter (METHODOLOGY.md §4/§5).
//
// §4 and §5 both select the WORST reserve, which means a reserve holding
// effectively nothing can set a protocol's published number. The filter excludes
// a reserve only when it fails BOTH legs: the pool's own declared min_collateral
// and 0.5% of the pool's total supplied USD. The OR is the part worth testing —
// each leg exists to cover a failure the other has.
// ---------------------------------------------------------------------------

describe('minimum-size filter — leg A, the pool’s own min_collateral (§4/§5)', () => {
  /** A dominant reserve plus a tiny one that is the worst on both factors. */
  const lopsided = (minCollateralUsd: number) =>
    makeRaw({
      minCollateralUsd,
      reserves: [
        reserve({ asset: 'CBIG…', supplied: 1_000_000, borrowed: 0, cap: 0.8 }),
        reserve({ asset: 'CSMALL…', supplied: 10, borrowed: 9, cap: 0.8 }),
      ],
    });

  it('keeps a small reserve that still clears the protocol’s own floor', async () => {
    // $10 against a $1,000,010 pool is 0.001% — leg B fails outright. Leg A
    // carries it, because Blend itself says a $5 exposure is worth having. This
    // is the case relative-only would get wrong, and it is the worse error:
    // 90% utilization on real capital would have been hidden.
    const f = await factors(lopsided(5));
    assert.equal(f.liquiditySafety!.value, 10, 'the small reserve must still bind');
    assert.equal(sub(f.liquiditySafety!, 'excludedReserves'), undefined, 'nothing was excluded');
  });

  it('drops the same reserve when the pool declares no floor at all', async () => {
    // Identical pool, min_collateral = 0. Leg A is unavailable, leg B fails, so
    // the reserve goes — and the factor jumps to the untroubled reserve. Held
    // side by side with the test above, this is exactly what leg A buys.
    const f = await factors(lopsided(0));
    assert.equal(f.liquiditySafety!.value, 100);
    assert.match(f.liquiditySafety!.components![0].detail, /CSMALL/);
  });
});

describe('minimum-size filter — leg B, share of the pool (§4/§5)', () => {
  it('keeps a reserve sitting exactly on the 0.5% line', async () => {
    // The comparison is >=, so the boundary reserve is IN. Erring toward
    // inclusion is the documented direction: excluding a real reserve hides
    // risk, keeping a dust one only reports a misleading number.
    const f = await factors(
      makeRaw({
        minCollateralUsd: 0,
        reserves: [
          reserve({ asset: 'CBIG…', supplied: 199, borrowed: 0 }),
          reserve({ asset: 'CEDGE…', supplied: 1, borrowed: 1 }),
        ],
      }),
    );
    assert.equal(f.liquiditySafety!.value, 0, '1/200 = 0.5% exactly — kept, and it is fully drawn');
  });

  it('does not filter at all when no reserve can be priced', async () => {
    // §4/§5 are otherwise pure balance ratios that work with the oracle down.
    // With no prices there is no denominator, so the filter stands aside and the
    // factors behave exactly as they did before it existed, rather than
    // refusing to score. Flagged in METHODOLOGY.md §4 because it means these two
    // numbers mean something slightly different during an oracle outage.
    const f = await factors(
      makeRaw({
        reserves: [
          reserve({ asset: 'CBIG…', supplied: 1_000_000, borrowed: 0, price: null }),
          reserve({ asset: 'CDUST…', supplied: 1, borrowed: 1, price: null }),
        ],
      }),
    );
    assert.equal(
      f.liquiditySafety!.value,
      0,
      'the dust reserve still binds — nothing was filtered',
    );
    assert.equal(sub(f.liquiditySafety!, 'excludedReserves'), undefined);
  });

  it('keeps an individual unpriced reserve rather than reading it as worthless', async () => {
    // Could-not-measure is not the same as empty, so an unpriced reserve is
    // never excluded by size — it has no measurable size to judge.
    const f = await factors(
      makeRaw({
        reserves: [
          reserve({ asset: 'CBIG…', supplied: 1_000_000, borrowed: 0 }),
          reserve({ asset: 'CUNPRICED…', supplied: 1, borrowed: 1, price: null }),
        ],
      }),
    );
    assert.equal(f.liquiditySafety!.value, 0);
  });
});

describe('minimum-size filter — excluding everything still cannot publish 100', () => {
  // This is the state the filter could reintroduce the "0 not 100" bug through,
  // so it is pinned even though it is unreachable on a real pool: shares sum to
  // 1, so the largest reserve is always >= 1/n, which clears 0.5% for any
  // n <= 200. It takes 201 equal reserves to starve leg B everywhere, which is
  // why live data can never exercise this path.
  const starved = (minCollateralUsd: number) =>
    makeRaw({
      minCollateralUsd,
      // 201 × $0.01: each share is 1/201 = 0.4975% (leg B fails) and each is
      // below the $5 floor (leg A fails). borrowed = 0 means every one of them
      // would have scored 100 — so if either the accumulator seed leaked or the
      // filter were skipped, this test reads 100 instead of 0.
      reserves: Array.from({ length: 201 }, (_, i) =>
        reserve({ asset: `C${i}`.padEnd(56, 'X'), supplied: 1, borrowed: 0, price: 0.01 }),
      ),
    });

  it('liquiditySafety reports cannot-assess, not maximally safe', async () => {
    const f = await factors(starved(5));
    assert.equal(f.liquiditySafety!.value, 0, 'a filtered-empty set is undefined, not 100');
    assert.match(f.liquiditySafety!.detail, /below the minimum scorable size/);
  });

  it('utilizationSafety reports cannot-assess, not maximally safe', async () => {
    const f = await factors(starved(5));
    assert.equal(f.utilizationSafety!.value, 0);
    assert.match(f.utilizationSafety!.detail, /below the minimum scorable size/);
  });

  it('says it filtered them out, not that the pool is empty', async () => {
    // The three cannot-assess reasons stay distinguishable. "Every reserve is
    // too small" and "the pool has no supplied value" are different findings
    // about different pools and must not share one message.
    const filtered = await factors(starved(5));
    const empty = await factors(makeRaw({ reserves: [] }));
    assert.notEqual(filtered.liquiditySafety!.detail, empty.liquiditySafety!.detail);
    assert.doesNotMatch(filtered.liquiditySafety!.detail, /no reserve has any supplied value/);
    assert.doesNotMatch(empty.liquiditySafety!.detail, /minimum scorable size/);
    assert.doesNotMatch(filtered.liquiditySafety!.detail, /worst reserve/);
  });

  it('is genuinely the filter doing it — the same pool scores with leg A available', async () => {
    // Same 201 reserves, but a pool declaring a $0.001 floor keeps every one of
    // them. Proves the 0 above comes from the size filter and not from some
    // other property of a 201-reserve fixture.
    const f = await factors(starved(0.001));
    assert.equal(f.liquiditySafety!.value, 100);
  });
});
