import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatDuration,
  formatUtcRange,
  freshness,
  freshnessPillClass,
  type FreshnessTone,
} from './format.ts';

describe('formatDuration', () => {
  it('rounds to the nearest minute rather than flooring', () => {
    // The live median run spacing is ~4m59s. Flooring reported "every 4m" for a
    // cadence the product markets as five-minute.
    assert.equal(formatDuration(299_000), '5m');
    assert.equal(formatDuration(301_000), '5m');
  });

  it('describes sub-minute spans without claiming zero', () => {
    assert.equal(formatDuration(0), 'under a minute');
    assert.equal(formatDuration(59_000), 'under a minute');
  });

  it('formats hours and days compactly', () => {
    assert.equal(formatDuration(45 * 60_000), '45m');
    assert.equal(formatDuration(4 * 3_600_000 + 5 * 60_000), '4h 5m');
    assert.equal(formatDuration(2 * 3_600_000), '2h');
    assert.equal(formatDuration(3 * 86_400_000 + 2 * 3_600_000), '3d 2h');
    assert.equal(formatDuration(2 * 86_400_000), '2d');
  });

  it('refuses to invent a value for nonsense input', () => {
    assert.equal(formatDuration(NaN), '—');
    assert.equal(formatDuration(-1), '—');
  });
});

// No run has ever failed in production (0 of 1,683 rows as of 2026-08-16), so
// the failed branch below has never rendered against real data. These are the
// only thing standing behind it.
describe('freshness', () => {
  it('flags a failed newest run as stale while keeping the last good score', () => {
    const f = freshness('failed', true);
    assert.equal(f.tone, 'stale');
    // The distinction the whole indicator exists to make: our data is old, the
    // protocol has not been re-judged.
    assert.match(f.explanation, /last one Stenion computed successfully/);
    assert.match(f.explanation, /not a change in the protocol/);
  });

  it('does not claim a shown score when a failed run has none to fall back on', () => {
    const f = freshness('failed', false);
    assert.equal(f.tone, 'stale');
    assert.match(f.explanation, /no score to show/);
    assert.doesNotMatch(f.explanation, /score shown/);
  });

  it('separates never-run from failed', () => {
    assert.equal(freshness(null, false).tone, 'unscored');
    assert.equal(freshness('ok', true).tone, 'live');
  });

  it('keeps labels short enough for the registry column', () => {
    for (const [status, hasScore] of [
      ['ok', true],
      ['failed', true],
      ['failed', false],
      [null, false],
    ] as const) {
      assert.ok(freshness(status, hasScore).label.length <= 16);
    }
  });
});

describe('freshnessPillClass', () => {
  // The non-negotiable one: freshness and risk are two vocabularies. A stale
  // marker in `warn` or `danger` would tell a reader the protocol is dangerous
  // when it means our data is old.
  it('never dresses a fault state in a score-band colour', () => {
    for (const tone of ['stale', 'unscored'] as FreshnessTone[]) {
      assert.doesNotMatch(freshnessPillClass(tone), /\b(safe|warn|danger)/);
    }
  });

  it('puts the stale state on the accent', () => {
    assert.match(freshnessPillClass('stale'), /accent/);
  });
});

describe('formatUtcRange', () => {
  it('collapses the end to a bare time within one UTC day', () => {
    assert.equal(
      formatUtcRange('2026-08-14T07:20:00Z', '2026-08-14T11:25:00Z'),
      '14 Aug 07:20 → 11:25 UTC',
    );
  });

  it('keeps both dates across a day boundary', () => {
    assert.equal(
      formatUtcRange('2026-08-11T11:23:00Z', '2026-08-14T11:25:00Z'),
      '11 Aug 11:23 → 14 Aug 11:25 UTC',
    );
  });
});
