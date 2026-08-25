import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatDuration,
  formatUtcRange,
  freshness,
  freshnessPillClass,
  operationalLabel,
  operationalPillClass,
  type FreshnessTone,
} from './format.ts';
import type { OperationalLevel } from './contract.ts';

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

describe('operationalPillClass', () => {
  const LEVELS: OperationalLevel[] = [
    'active',
    'borrowingDisabled',
    'entryDisabled',
    'exitDisabled',
    'notOperational',
  ];

  it('never dresses an operational state in a score-band colour', () => {
    // The non-negotiable, and sharper here than for freshness. Operational state
    // is the one thing Stenion publishes WITHOUT grading (METHODOLOGY.md,
    // "Operational state is published, never scored"), because no on-chain data
    // separates an admin containing a threat from an admin walking away. A
    // "withdrawals halted" pill in `danger` would make the page reach the
    // verdict the methodology explicitly declines to reach — and it would do it
    // in the most visible place on the registry.
    for (const level of LEVELS) {
      assert.doesNotMatch(operationalPillClass(level), /\b(safe|warn|danger)/, level);
    }
  });

  it('does not borrow the accent either — that vocabulary is freshness', () => {
    // The dashboard already spends accent on "our data is old". Two
    // accent-toned markers on one row would blur a distinction the freshness
    // pill was deliberately built to draw.
    for (const level of LEVELS) {
      assert.doesNotMatch(operationalPillClass(level), /accent/, level);
    }
  });

  it('gives the capital-constraining levels more weight than the others', () => {
    // Prominence has to come from somewhere, and with hue ruled out it comes
    // from weight. If this ever collapses to one class for every level, the
    // "withdrawals halted" row stops being distinguishable at scan distance and
    // the publish-don't-score decision quietly becomes publish-and-bury.
    for (const level of ['entryDisabled', 'exitDisabled'] as OperationalLevel[]) {
      assert.match(operationalPillClass(level), /text-ink/, level);
    }
    for (const level of ['borrowingDisabled', 'notOperational'] as OperationalLevel[]) {
      assert.doesNotMatch(operationalPillClass(level), /text-ink/, level);
    }
  });
});

describe('operationalLabel', () => {
  it('names the restriction, never the protocol’s own term', () => {
    // Blend says "On-Ice" and "Frozen"; K2 says "paused". Those vocabularies do
    // not map onto each other — which is the whole reason a shared level exists
    // — so a label that leaked either would make two rows incomparable.
    const labels = (
      ['borrowingDisabled', 'entryDisabled', 'exitDisabled', 'notOperational'] as const
    ).map(operationalLabel);
    for (const label of labels) {
      assert.doesNotMatch(label, /on-ice|frozen|paused|setup/i, label);
    }
  });

  it('says plainly which state stops withdrawals', () => {
    // The single most consequential distinction the flag carries: Blend's most
    // restricted status still lets a depositor leave, K2's pause does not.
    assert.match(operationalLabel('exitDisabled'), /withdrawal/i);
    assert.doesNotMatch(operationalLabel('entryDisabled'), /withdrawal/i);
  });
});
