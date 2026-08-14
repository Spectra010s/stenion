import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatDuration, formatUtcRange } from './format.ts';

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
