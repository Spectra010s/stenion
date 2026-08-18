// Regression tests against frozen mainnet snapshots.
//
// WHY THESE EXIST, given the synthetic suites already cover the rules: the
// synthetic fixtures are hand-built, and every one of them picks convenient
// numbers — rate = 1.0, decimals = 7, round balances. Real pools do not. The
// captured Blend reserves carry b_rate/d_rate of 1.0015, 1.1392 and 1.2214, so
// the fixed-point scaling in `reserveTotals` is only genuinely exercised here;
// with a unit rate, a bug in the SCALAR_12 divisor cancels out and every
// synthetic assertion still passes. Kinetic contributes 8-decimal balances down
// to dust (0.0005668) alongside 7-decimal ones.
//
// So this file answers a different question from the others. They ask "does the
// rulebook say what METHODOLOGY.md says". This one asks "did a refactor move a
// published number on real data" — and it is the only thing that would notice a
// decode or scaling regression.
//
// The expected values below are what the adapters produced at capture time.
// They are not aspirational: if one changes, either the fixture was regenerated
// (re-derive them deliberately) or something regressed. Do not update a number
// here without knowing which.
//
// Run with: pnpm --filter @stenion/adapters test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BlendAdapter } from './blend.ts';
import { KineticAdapter } from './kinetic.ts';
import { blendMainnet } from './fixtures/blend-mainnet.ts';
import { kineticMainnet } from './fixtures/kinetic-mainnet.ts';
import type { RiskFactor, RiskFactorMap } from '@stenion/core';

const values = (f: RiskFactorMap) =>
  Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v === null ? null : v.value]));

const sub = (f: RiskFactor, id: string) => f.components?.find((c) => c.id === id)?.value;

describe('Blend — frozen mainnet snapshot', () => {
  it('produces exactly the factor map captured with it', async () => {
    const factors = await new BlendAdapter().computeRiskFactors(blendMainnet);
    assert.deepEqual(values(factors), {
      collateralSafety: 71,
      oracleSafety: 100,
      adminKeySafety: 40,
      liquiditySafety: 23,
      utilizationSafety: 15,
    });
  });

  it('scores 54 — and that is the weighted mean of those five', async () => {
    // Cross-checked by hand so a failure separates "a factor moved" from "the
    // weighting moved": 71×0.20 + 100×0.25 + 40×0.20 + 23×0.15 + 15×0.20 = 53.65.
    const adapter = new BlendAdapter();
    const factors = await adapter.computeRiskFactors(blendMainnet);
    assert.equal(adapter.score(factors).score, 54);
  });

  it('excludes no reserve as too small — every one clears the $5 min_collateral', async () => {
    // The minimum-size filter (§4/§5) is a genuine no-op on Blend, and this
    // pins that rather than leaving it to be assumed. The pool declares
    // min_collateral = 50000000 at 7 oracle decimals = $5.00, and its smallest
    // reserve holds ~$3.4M, so leg A clears by six orders of magnitude. If a
    // regenerated fixture ever DOES exclude a Blend reserve, that is a real
    // finding about the pool and this test should fail loudly first.
    const factors = await new BlendAdapter().computeRiskFactors(blendMainnet);
    assert.equal(blendMainnet.minCollateral, 50_000_000n);
    assert.equal(sub(factors.liquiditySafety!, 'excludedReserves'), undefined);
    assert.equal(sub(factors.utilizationSafety!, 'excludedReserves'), undefined);
  });

  it('reports both oracle sub-signals on real aggregator config', async () => {
    const factors = await new BlendAdapter().computeRiskFactors(blendMainnet);
    assert.equal(sub(factors.oracleSafety!, 'priceFreshness'), 100);
    assert.equal(sub(factors.oracleSafety!, 'deviationBound'), 100);
    // Tightness stays a disclosure on real data too, not just in synthetic cases.
    assert.equal(sub(factors.oracleSafety!, 'deviationTightness'), null);
  });

  it('still exercises non-unit interest rates — the reason this fixture exists', async () => {
    // A guard on the fixture rather than on the adapter. If a regenerated
    // snapshot ever landed with every rate at exactly SCALAR_12, this file would
    // silently stop covering the scaling it was added for, and nothing else
    // would notice.
    const SCALAR_12 = 10n ** 12n;
    const nonUnit = blendMainnet.reserves.filter(
      (r) => r.data.bRate !== SCALAR_12 || r.data.dRate !== SCALAR_12,
    );
    assert.ok(
      nonUnit.length > 0,
      'every captured rate is 1.0 — recapture, or this fixture adds nothing over the synthetic ones',
    );
  });
});

describe('Kinetic — frozen mainnet snapshot', () => {
  it('produces exactly the factor map captured with it', async () => {
    const factors = await new KineticAdapter().computeRiskFactors(kineticMainnet);
    assert.deepEqual(values(factors), {
      collateralSafety: 15,
      oracleSafety: 0,
      adminKeySafety: 60,
      liquiditySafety: 44,
      utilizationSafety: 30,
    });
  });

  it('scores 28', async () => {
    // 15×0.20 + 0×0.25 + 60×0.20 + 44×0.15 + 30×0.20 = 27.6.
    const adapter = new KineticAdapter();
    const factors = await adapter.computeRiskFactors(kineticMainnet);
    assert.equal(adapter.score(factors).score, 28);
  });

  it('is the case the minimum-size filter was added for', async () => {
    // THIS FIXTURE IS DELIBERATELY NOT REGENERATED. It is the only captured
    // state where the defect is visible: at capture the PYUSD reserve held
    // $3.00 of a $1,571 pool (0.19%) at 66% utilization, and being the worst
    // reserve it set BOTH factors — liquiditySafety 34 and utilizationSafety 18
    // — off a reserve nobody's capital was meaningfully exposed to. Filtered,
    // the binding reserve becomes SolvBTC at $35.79 (2.28%), which is real:
    // 44 and 30 above.
    //
    // Live K2 has since moved on (PYUSD grew to $4.00 and its utilization fell,
    // so it stopped binding on its own). Recapturing would lose the only
    // regression evidence this change has. Leave it frozen.
    const factors = await new KineticAdapter().computeRiskFactors(kineticMainnet);
    for (const factor of [factors.liquiditySafety!, factors.utilizationSafety!]) {
      const excluded = factor.components?.find((c) => c.id === 'excludedReserves');
      assert.ok(excluded, 'the excluded reserve must be disclosed, not silently dropped');
      assert.equal(excluded.value, null, 'a disclosure is never graded');
      assert.match(excluded.detail, /CCCRWH…/, 'names the excluded reserve');
      assert.match(excluded.detail, /\$3\.00/, 'publishes what it held');
      assert.match(excluded.detail, /0\.19% of pool/, 'publishes its share');
      assert.match(excluded.detail, /would have scored/, 'publishes the suppressed number');
    }
    // The suppressed numbers are exactly the ones this fixture used to publish.
    assert.match(
      factors.liquiditySafety!.components![0].detail,
      /would have scored 34/,
      'the old liquiditySafety value must still be readable',
    );
    assert.match(
      factors.utilizationSafety!.components![0].detail,
      /would have scored 18/,
      'the old utilizationSafety value must still be readable',
    );
  });

  it('scores oracleSafety 0 on a genuinely stale price, with the breaker armed', async () => {
    // This is K2's ordinary state, not an unlucky capture: across the
    // development-era history (since discarded — see METHODOLOGY.md, "Current
    // version") 533 of 588 scored runs carried oracleSafety 0, and the protocol
    // page's Findings section records the same pattern with its own verification
    // steps. The two sub-signals disagreeing is the whole point of the §2
    // composite — the circuit breaker IS armed, and the factor is still 0,
    // because a bounded stale price is untrustworthy.
    const factors = await new KineticAdapter().computeRiskFactors(kineticMainnet);
    assert.equal(sub(factors.oracleSafety!, 'priceFreshness'), 0);
    assert.equal(sub(factors.oracleSafety!, 'deviationBound'), 100);
    assert.equal(factors.oracleSafety!.value, 0, 'the binding constraint is freshness');
  });

  it('handles reserves whose balances differ by orders of magnitude', async () => {
    // The captured set spans a 9,418-unit reserve and a 0.0005668 one, across 7-
    // and 8-decimal assets. Dust must stay dust through the decimals decode —
    // an off-by-one there would turn it into a pool-dominating balance.
    const decimals = new Set(kineticMainnet.reserves.map((r) => r.decimals));
    assert.ok(decimals.size > 1, 'fixture should span more than one decimals value');
    const supplied = kineticMainnet.reserves.map((r) => Number(r.suppliedRaw) / 10 ** r.decimals);
    assert.ok(
      Math.max(...supplied) / Math.min(...supplied) > 1e6,
      'expected a wide balance spread',
    );
  });
});

describe('both snapshots', () => {
  it('populate all five factors with real detail strings', async () => {
    for (const [factors] of [
      [await new BlendAdapter().computeRiskFactors(blendMainnet)],
      [await new KineticAdapter().computeRiskFactors(kineticMainnet)],
    ]) {
      for (const [key, factor] of Object.entries(factors)) {
        assert.ok(factor, `${key} should be populated on live data`);
        assert.ok(factor.detail.length > 10, `${key} needs a real detail string`);
        assert.ok(Number.isInteger(factor.value), `${key} should be a whole number`);
        assert.ok(factor.value >= 0 && factor.value <= 100, `${key} out of range`);
      }
    }
  });
});
