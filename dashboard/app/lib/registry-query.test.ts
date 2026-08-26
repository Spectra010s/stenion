import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_SORT,
  buildRegistryView,
  matchesQuery,
  parseRegistryParams,
  partitionScored,
  registryHref,
  sortRanked,
  type RegistryParams,
} from './registry-query.ts';
import type { LeaderboardEntry } from './contract.ts';
import type { CoverageEntry } from './coverage.ts';

// The rule under test, stated once: an entry we do not score must never occupy
// a position in a ranked list. A reader scanning quickly reads POSITION, not
// the score column, so "unscored, sorted last" and "ranked last" are the same
// thing to them. Everything below exists to make that structural rather than a
// thing review has to keep noticing.

const scored = (id: string, name: string, safetyScore: number | null): LeaderboardEntry => ({
  id,
  name,
  chain: 'stellar',
  // Every entry here is lending, which is the whole point of the assertions in
  // this file today: with one category the ranked list is exactly what it was
  // before categories existed. Scoping the ranking per category is #78.
  category: 'lending',
  logo: null,
  deployedOn: null,
  safetyScore,
  computedAt: safetyScore === null ? null : '2026-08-21T00:00:00Z',
  // Ordering must not depend on it: operational state is published beside a
  // score, never folded into one, so it takes no part in sorting or ranking.
  operationalState: null,
  lastRunAt: '2026-08-21T00:00:00Z',
  lastRunStatus: 'ok',
});

const uncovered = (
  id: string,
  name: string,
  status: CoverageEntry['status'] = 'off-chain-state',
): CoverageEntry => ({
  id,
  name,
  status,
  logo: null,
  links: { site: null, docs: null },
  contractId: null,
  summary: `Why ${name} is not scored.`,
  reason: [`The long form for ${name}.`],
  verify: `How to check ${name}.`,
  asOf: null,
});

const params = (over: Partial<RegistryParams> = {}): RegistryParams => ({
  q: '',
  status: 'all',
  sort: DEFAULT_SORT,
  ...over,
});

const BOARD = [
  scored('blend', 'Blend', 54),
  scored('kinetic', 'Kinetic', 31),
  scored('yieldblox', 'YieldBlox', 24),
  scored('aurora', 'Aurora', null),
];

const COVER = [
  uncovered('templar', 'Templar', 'off-chain-state'),
  uncovered('k2-earn', 'K2 Earn (earnUSDC)', 'below-size-floor'),
  uncovered('nectar-network', 'Nectar Network', 'awaiting-mainnet'),
];

describe('parseRegistryParams', () => {
  const statuses = ['off-chain-state', 'below-size-floor', 'awaiting-mainnet'];

  it('defaults to the ranked, unfiltered view', () => {
    assert.deepEqual(parseRegistryParams({}, statuses), {
      q: '',
      status: 'all',
      sort: 'score-desc',
    });
  });

  it('falls back silently on a value it does not recognise', () => {
    // These params get typed by hand and pasted between people. A stale
    // `?sort=score` from an older link should show the registry, not an error.
    const parsed = parseRegistryParams({ sort: 'score', status: 'lolwut' }, statuses);
    assert.equal(parsed.sort, 'score-desc');
    assert.equal(parsed.status, 'all');
  });

  it('accepts a coverage status only when that status has members', () => {
    // Same rule as groupCoverage dropping empty groups: a filter that selects a
    // heading with nothing under it describes members that aren't there.
    assert.equal(
      parseRegistryParams({ status: 'awaiting-mainnet' }, statuses).status,
      'awaiting-mainnet',
    );
    assert.equal(parseRegistryParams({ status: 'out-of-category' }, statuses).status, 'all');
  });

  it('takes the first value of a repeated param and trims the query', () => {
    assert.equal(parseRegistryParams({ q: ['  blend  ', 'kinetic'] }, statuses).q, 'blend');
  });

  it('caps an absurd query rather than carrying it into the page', () => {
    const parsed = parseRegistryParams({ q: 'x'.repeat(500) }, statuses);
    assert.equal(parsed.q.length, 64);
  });
});

describe('registryHref', () => {
  it('gives the unfiltered ranked view exactly one URL', () => {
    // Defaults are omitted so /registry is the canonical address of the
    // registry, rather than one of three spellings of itself.
    assert.equal(registryHref({ q: '', status: 'all', sort: 'score-desc' }), '/registry');
  });

  it('round-trips a filtered view through parse', () => {
    const href = registryHref({ q: 'k2', status: 'below-size-floor', sort: 'name' });
    const parsed = parseRegistryParams(
      Object.fromEntries(new URL(href, 'https://stenion.io').searchParams),
      ['below-size-floor'],
    );
    assert.deepEqual(parsed, { q: 'k2', status: 'below-size-floor', sort: 'name' });
  });
});

describe('matchesQuery', () => {
  it('finds an entry by what a reader sees, not by its slug spelling', () => {
    // The punctuation fold: someone typing the display name finds the entry
    // whose id is hyphenated.
    assert.ok(matchesQuery({ id: 'k2-earn', name: 'K2 Earn (earnUSDC)' }, 'k2 earn'));
    assert.ok(matchesQuery({ id: 'k2-earn', name: 'K2 Earn (earnUSDC)' }, 'K2-EARN'));
  });

  it('matches a substring anywhere in the name', () => {
    assert.ok(matchesQuery({ id: 'yieldblox', name: 'YieldBlox' }, 'blox'));
  });

  it('does not match a host protocol an entry merely runs on', () => {
    // Searching "blend" and being handed YieldBlox with no visible reason
    // implies YieldBlox IS Blend — the thing the deployment label denies.
    assert.equal(matchesQuery({ id: 'yieldblox', name: 'YieldBlox' }, 'blend'), false);
  });

  it('treats an empty query as no filter at all', () => {
    assert.ok(matchesQuery({ id: 'blend', name: 'Blend' }, '   '));
  });
});

describe('partitionScored — the third state', () => {
  it('keeps a never-scored protocol out of the ranked set', () => {
    // safetyScore: null is our pipeline not having got there. It is neither a
    // rankable number nor a coverage decision.
    const { ranked, pending } = partitionScored(BOARD);
    assert.deepEqual(
      ranked.map((r) => r.id),
      ['blend', 'kinetic', 'yieldblox'],
    );
    assert.deepEqual(
      pending.map((r) => r.id),
      ['aurora'],
    );
  });
});

describe('sortRanked', () => {
  it('ranks by score descending by default', () => {
    assert.deepEqual(
      sortRanked(partitionScored(BOARD).ranked, 'score-desc').map((r) => r.safetyScore),
      [54, 31, 24],
    );
  });

  it('reverses cleanly for score-asc', () => {
    assert.deepEqual(
      sortRanked(partitionScored(BOARD).ranked, 'score-asc').map((r) => r.safetyScore),
      [24, 31, 54],
    );
  });

  it('breaks ties by name so the order is stable between runs', () => {
    // Two protocols on the same number must not swap places because the
    // database returned them in a different order.
    const tied = [scored('zeta', 'Zeta', 40), scored('alpha', 'Alpha', 40)];
    assert.deepEqual(
      sortRanked(tied, 'score-desc').map((r) => r.id),
      ['alpha', 'zeta'],
    );
    assert.deepEqual(
      sortRanked(tied, 'score-asc').map((r) => r.id),
      ['alpha', 'zeta'],
    );
  });
});

describe('buildRegistryView — unscored entries never enter the ranking', () => {
  it('keeps coverage entries out of the ranked list under score-desc', () => {
    const view = buildRegistryView(BOARD, COVER, params());
    assert.equal(view.mode, 'ranked');
    assert.equal(view.merged.length, 0, 'ranked mode must not produce a merged list');
    for (const id of view.ranked.map((r) => r.id)) {
      assert.ok(!COVER.some((c) => c.id === id), `${id} is a coverage entry inside the ranking`);
    }
    assert.deepEqual(view.coverage.map((c) => c.id).sort(), [
      'k2-earn',
      'nectar-network',
      'templar',
    ]);
  });

  it('keeps them out under score-asc too, where "last" becomes "first"', () => {
    // The direction flip is the case worth pinning: sorting unscored entries
    // onto the scale at all would put them at the TOP here.
    const view = buildRegistryView(BOARD, COVER, params({ sort: 'score-asc' }));
    assert.equal(view.ranked[0]?.id, 'yieldblox', 'lowest real score leads');
    assert.equal(view.merged.length, 0);
  });

  it('never prints a position numeral except under score-desc', () => {
    // Under score-asc row one is the lowest score; under name it is
    // alphabetical. In both, "01" would assert a rank that isn't there.
    assert.equal(buildRegistryView(BOARD, COVER, params()).showRank, true);
    assert.equal(buildRegistryView(BOARD, COVER, params({ sort: 'score-asc' })).showRank, false);
    assert.equal(buildRegistryView(BOARD, COVER, params({ sort: 'name' })).showRank, false);
  });

  it('puts a never-scored protocol after every ranked one, in both directions', () => {
    for (const sort of ['score-desc', 'score-asc'] as const) {
      const view = buildRegistryView(BOARD, COVER, params({ sort }));
      assert.deepEqual(
        view.pending.map((p) => p.id),
        ['aurora'],
      );
      assert.ok(!view.ranked.some((r) => r.id === 'aurora'));
      assert.ok(
        !view.coverage.some((c) => c.id === 'aurora'),
        'a pipeline gap is not a coverage decision',
      );
    }
  });
});

describe('buildRegistryView — the alphabetical exception', () => {
  it('merges both kinds into one list, since A–Z asserts no ranking', () => {
    const view = buildRegistryView(BOARD, COVER, params({ sort: 'name' }));
    assert.equal(view.mode, 'alphabetical');
    assert.deepEqual(
      view.merged.map((r) => r.entry.name),
      [
        'Aurora',
        'Blend',
        'K2 Earn (earnUSDC)',
        'Kinetic',
        'Nectar Network',
        'Templar',
        'YieldBlox',
      ],
    );
  });

  it('tags every merged row with which kind it is', () => {
    // The tag is what lets the row render a chip instead of a number. A merged
    // list where the two look alike is the confusion the separate section was
    // preventing.
    const view = buildRegistryView(BOARD, COVER, params({ sort: 'name' }));
    const kinds = Object.fromEntries(view.merged.map((r) => [r.entry.id, r.kind]));
    assert.equal(kinds['blend'], 'scored');
    assert.equal(kinds['templar'], 'coverage');
    assert.equal(kinds['aurora'], 'scored', 'a pipeline gap is still a tracked protocol');
  });
});

describe('buildRegistryView — search and filter', () => {
  it('searches across both kinds at once', () => {
    const view = buildRegistryView(BOARD, COVER, params({ q: 'k2' }));
    assert.deepEqual(
      view.ranked.map((r) => r.id),
      [],
    );
    assert.deepEqual(
      view.coverage.map((c) => c.id),
      ['k2-earn'],
    );
    assert.equal(view.counts.total, 1);
  });

  it('finds a scored protocol and an unscored one under the same query', () => {
    const board = [...BOARD, scored('nectar-lend', 'Nectar Lend', 70)];
    const view = buildRegistryView(board, COVER, params({ q: 'nectar' }));
    assert.deepEqual(
      view.ranked.map((r) => r.id),
      ['nectar-lend'],
    );
    assert.deepEqual(
      view.coverage.map((c) => c.id),
      ['nectar-network'],
    );
  });

  it('narrows to one kind on the status filter', () => {
    const onlyScored = buildRegistryView(BOARD, COVER, params({ status: 'scored' }));
    assert.equal(onlyScored.coverage.length, 0);
    assert.equal(onlyScored.counts.ranked, 3);
    assert.equal(
      onlyScored.counts.pending,
      1,
      'a tracked protocol with no score is still scored-side',
    );

    const onlyCoverage = buildRegistryView(BOARD, COVER, params({ status: 'not-scored' }));
    assert.equal(onlyCoverage.ranked.length, 0);
    assert.equal(onlyCoverage.pending.length, 0);
    assert.equal(onlyCoverage.coverage.length, 3);
  });

  it('narrows to a single coverage status', () => {
    const view = buildRegistryView(BOARD, COVER, params({ status: 'below-size-floor' }));
    assert.deepEqual(
      view.coverage.map((c) => c.id),
      ['k2-earn'],
    );
    assert.equal(view.ranked.length, 0, 'a coverage status implies not-scored');
  });

  it('reports an empty result honestly rather than falling back to everything', () => {
    const view = buildRegistryView(BOARD, COVER, params({ q: 'nothing-matches-this' }));
    assert.equal(view.counts.total, 0);
    assert.equal(view.merged.length, 0);
  });
});
