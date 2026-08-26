import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COVERAGE,
  COVERAGE_STATUS_META,
  COVERAGE_STATUS_ORDER,
  coverageById,
  coverageForApi,
  coverageToPublish,
  groupCoverage,
  type CoverageEntry,
} from './coverage.ts';

// These are content rules, not code rules, and that is the point: the bar for
// adding a coverage entry (see the header of coverage.ts) is the whole reason
// publishing this is defensible rather than a list of opinions. A bar enforced
// only by review erodes; these assertions make it structural.

describe('the coverage entries meet their own bar', () => {
  it('gives every entry a verify sentence', () => {
    // If we cannot say how a reader checks a claim themselves, the claim does
    // not go on the site. This is the mechanism behind the sourcing rule.
    for (const entry of COVERAGE) {
      assert.ok(
        entry.verify.trim().length > 0,
        `${entry.id} has no verify text — it cannot be published`,
      );
    }
  });

  it('gives every entry protocol-specific reasoning, not a bare label', () => {
    // The status alone ("below-size-floor") is a category. What makes the
    // listing worth reading is why THIS market is in it.
    for (const entry of COVERAGE) {
      assert.ok(entry.reason.length > 0, `${entry.id} has no reason paragraphs`);
      for (const para of entry.reason) {
        assert.ok(para.trim().length > 0, `${entry.id} has an empty reason paragraph`);
      }
    }
  });

  it('dates every claim that rests on a measurement', () => {
    // "$3.62" is a reading, not a property of the market. Undated, and indexed
    // by a search engine, it becomes a factual assertion we would be making
    // indefinitely. Structural reasons (Templar's architecture) need no date.
    //
    // `oracle-not-gradable` is held to the same rule even though its CORE claim
    // is structural — a deployed contract's exported interface, which no balance
    // affects. Two things pull it back in. Those entries quote readings anyway
    // (Orbit's 99.5% concentration, Solv's feed ages), and more importantly the
    // interface itself is not permanent: an oracle can be upgraded, and one of
    // these can start publishing the two parameters. The date says which
    // deployment was read, which is exactly what a reader needs to re-check it.
    const DATED: CoverageEntry['status'][] = ['below-size-floor', 'oracle-not-gradable'];
    for (const entry of COVERAGE) {
      if (!DATED.includes(entry.status)) continue;
      assert.match(
        entry.asOf ?? '',
        /^\d{4}-\d{2}-\d{2}$/,
        `${entry.id} rests on a balance and must carry an ISO asOf date`,
      );
    }
  });

  it('offers an explorer link only where a full contract address was recorded', () => {
    // A truncated address (`CCGXGXIL…`) cannot build an explorer URL, and a
    // half-built one is worse than none. Both K2 markets are recorded truncated
    // in this repo, so they carry null and lean on `verify` for the derivation.
    for (const entry of COVERAGE) {
      if (entry.contractId === null) continue;
      assert.match(
        entry.contractId,
        /^C[A-Z2-7]{55}$/,
        `${entry.id} has a contractId that is not a full Soroban address`,
      );
    }
  });

  it('uses ids that are unique and URL-safe, since each one is an anchor', () => {
    const seen = new Set<string>();
    for (const entry of COVERAGE) {
      assert.match(entry.id, /^[a-z0-9-]+$/, `${entry.id} is not a usable anchor fragment`);
      assert.ok(!seen.has(entry.id), `duplicate coverage id: ${entry.id}`);
      seen.add(entry.id);
    }
  });

  it('gives every entry a one-sentence summary the registry row can carry', () => {
    // The row is compact and links through; this sentence is the whole of what
    // a scanner gets, and it has to be in the server-rendered HTML for
    // find-in-page. Bounded in length because a summary that wraps to four
    // lines has stopped being a summary and the row has stopped being compact.
    for (const entry of COVERAGE) {
      assert.ok(entry.summary.trim().length > 0, `${entry.id} has no summary`);
      assert.ok(
        entry.summary.length <= 200,
        `${entry.id}'s summary is ${entry.summary.length} chars — too long for a row`,
      );
      assert.doesNotMatch(entry.summary, /\n/, `${entry.id}'s summary is not a single line`);
      assert.match(entry.summary, /[.!?]$/, `${entry.id}'s summary is not a complete sentence`);
    }
  });

  it('never lets a summary carry a figure it cannot date', () => {
    // The date rule, applied where it is easiest to break. `asOf` sits beside
    // `reason` on the detail page; the row has no room to date a reading
    // properly, so a balance quoted in a summary would become exactly the
    // standing undated claim the rule exists to stop. Currency figures are the
    // shape that matters — an ordinal like "third router" is a property, not a
    // measurement.
    for (const entry of COVERAGE) {
      assert.doesNotMatch(
        entry.summary,
        /[$€£]\s?\d|\d+(\.\d+)?\s?(USD|USDC|XLM|BTC)/i,
        `${entry.id}'s summary quotes a balance, which belongs in reason[] beside its asOf date`,
      );
    }
  });

  it('keeps every entry free of a numeral that could read as a score', () => {
    // The requirement this feature exists for: "not scored" must never be
    // mistakable for "scored badly". The chip standing where a scored row has
    // its number must not contain a digit.
    for (const status of COVERAGE_STATUS_ORDER) {
      assert.doesNotMatch(
        COVERAGE_STATUS_META[status].chip,
        /\d/,
        `the ${status} chip contains a numeral, which can be misread as a score`,
      );
    }
  });
});

describe('coverageToPublish', () => {
  const ids = (entries: CoverageEntry[]) => entries.map((e) => e.id);

  it('drops an entry that the live board has since scored', () => {
    // The self-healing property. A market that gets registered must not appear
    // in both places, and the guard reads the real board rather than trusting
    // this file to have been cleaned up.
    const published = coverageToPublish(['blend', 'kinetic', 'k2-earn']);
    assert.ok(!ids(published).includes('k2-earn'));
    assert.ok(ids(published).includes('templar'));
  });

  it('publishes everything when the leaderboard could not be read', () => {
    // A database outage must not blank this section: it is static, it is still
    // true, and the registry's error state already covers the live data.
    assert.deepEqual(ids(coverageToPublish([])), ids([...COVERAGE]));
  });

  it('leaves the source list untouched', () => {
    const before = COVERAGE.length;
    coverageToPublish(['templar']);
    assert.equal(COVERAGE.length, before);
  });
});

describe('coverageForApi', () => {
  it('reuses the live-board dedupe rule', () => {
    const published = coverageForApi(['blend', 'kinetic', 'k2-earn']);
    assert.ok(!published.some((entry) => entry.id === 'k2-earn'));
    assert.ok(published.some((entry) => entry.id === 'templar'));
  });

  it('publishes evidence without exposing a score-shaped value', () => {
    const body: unknown = { coverage: coverageForApi([]) };

    function assertScoreless(value: unknown, path = 'response'): void {
      assert.notEqual(typeof value, 'number', `${path} contains a JSON number`);
      if (Array.isArray(value)) {
        value.forEach((item, index) => assertScoreless(item, `${path}[${index}]`));
        return;
      }
      if (value === null || typeof value !== 'object') return;

      for (const [key, child] of Object.entries(value)) {
        assert.notEqual(key, 'safetyScore', `${path} exposes a safetyScore key`);
        assertScoreless(child, `${path}.${key}`);
      }
    }

    assertScoreless(body);
    for (const entry of coverageForApi([])) {
      assert.ok(entry.reason.length > 0, `${entry.id} lost its published reasoning`);
      assert.ok(entry.verify.length > 0, `${entry.id} lost its verification path`);
      assert.ok('asOf' in entry, `${entry.id} lost its measurement date field`);
    }
  });

  it('returns detached arrays and link objects for the public contract', () => {
    const [published] = coverageForApi([]);
    const source = COVERAGE.find((entry) => entry.id === published.id);
    assert.ok(source);
    assert.notEqual(published.reason, source.reason);
    assert.notEqual(published.links, source.links);
  });
});

describe('coverageById', () => {
  it('resolves an id we hold a decision for', () => {
    assert.equal(coverageById('templar')?.name, 'Templar');
  });

  it('returns null for an id we have nothing to say about', () => {
    // /coverage/[id] turns this into a real 404. A page that rendered "not
    // scored" for an arbitrary slug would manufacture a coverage claim out of
    // a typo — and unlike a missing protocol, there is no data behind it at all.
    assert.equal(coverageById('blend'), null, 'a scored protocol is not a coverage entry');
    assert.equal(coverageById('does-not-exist'), null);
  });

  it('matches on the exact id, since the id is the URL', () => {
    assert.equal(coverageById('Templar'), null);
    assert.equal(coverageById('k2-earn')?.id, 'k2-earn');
  });
});

describe('groupCoverage', () => {
  it('never returns a heading with no members under it', () => {
    // `out-of-category` ships with zero entries on purpose. Rendering its
    // heading anyway would describe members that aren't there — the same
    // failure the registry's deployedOn note already guards against.
    const groups = groupCoverage([...COVERAGE]);
    for (const group of groups) {
      assert.ok(group.entries.length > 0, `${group.status} rendered as an empty group`);
    }
    assert.ok(!groups.some((g) => g.status === 'out-of-category'));
  });

  it('orders groups by COVERAGE_STATUS_ORDER, not by entry order', () => {
    const groups = groupCoverage([...COVERAGE]);
    const positions = groups.map((g) => COVERAGE_STATUS_ORDER.indexOf(g.status));
    assert.deepEqual(
      positions,
      [...positions].sort((a, b) => a - b),
    );
  });

  it('keeps every published entry in exactly one group', () => {
    const entries = coverageToPublish([]);
    const grouped = groupCoverage(entries).flatMap((g) => g.entries);
    assert.equal(grouped.length, entries.length);
    assert.deepEqual(new Set(grouped.map((e) => e.id)), new Set(entries.map((e) => e.id)));
  });

  it('returns nothing at all when there is nothing to publish', () => {
    assert.deepEqual(groupCoverage([]), []);
  });
});
