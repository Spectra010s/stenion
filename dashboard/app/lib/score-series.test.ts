// Fixture tests for the score-history series builder.
//
// WHY THESE EXIST: the two behaviours that matter most here — a failed run
// leaving a gap rather than a zero, and a methodology bump breaking the line —
// are exactly the two that live data cannot exercise. As of 2026-08-14 the
// production `risk_scores` table holds 527 rows and not one of them is a failed
// run, so "the page rendered fine" proves nothing about either path. Everything
// below is synthetic on purpose.
//
// Run with: pnpm --filter @stenion/dashboard test
// (Node's built-in runner + native type stripping — no test-framework dependency.)

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { HistoryEntry } from './contract.ts';
import { buildScoreSeries, GAP_BREAK_FACTOR, timeTicks } from './score-series.ts';

const T0 = Date.parse('2026-08-14T08:00:00.000Z');
const FIVE_MIN = 5 * 60_000;

const ok = (minute: number, score: number, version = 2): HistoryEntry => ({
  status: 'ok',
  safetyScore: score,
  methodologyVersion: version,
  computedAt: new Date(T0 + minute * 60_000).toISOString(),
  runAt: new Date(T0 + minute * 60_000).toISOString(),
});

const failed = (minute: number, error = 'RPC timeout'): HistoryEntry => ({
  status: 'failed',
  error,
  runAt: new Date(T0 + minute * 60_000).toISOString(),
});

/** The API returns newest-first; every fixture is built that way deliberately. */
const newestFirst = (entries: HistoryEntry[]): HistoryEntry[] => [...entries].reverse();

describe('buildScoreSeries', () => {
  it('handles empty history without producing a degenerate domain', () => {
    const s = buildScoreSeries([]);
    assert.deepEqual(s.points, []);
    assert.deepEqual(s.segments, []);
    assert.deepEqual(s.breaks, []);
    assert.equal(s.medianIntervalMs, null);
  });

  it('orders oldest-first regardless of the API newest-first order', () => {
    const s = buildScoreSeries(newestFirst([ok(0, 10), ok(5, 20), ok(10, 30)]));
    assert.deepEqual(
      s.points.map((p) => p.score),
      [10, 20, 30],
    );
  });

  it('gives a single point a real, centred domain instead of a zero-width axis', () => {
    const s = buildScoreSeries([ok(0, 53)]);
    assert.equal(s.points.length, 1);
    assert.equal(s.segments.length, 1);
    assert.equal(s.segments[0].length, 1);
    assert.ok(s.domain.end > s.domain.start, 'domain must have width');
    const mid = (s.domain.start + s.domain.end) / 2;
    assert.equal(mid, s.points[0].t, 'the lone point should sit centred');
  });

  it('keeps an unbroken cadence as one segment', () => {
    const s = buildScoreSeries(newestFirst([ok(0, 53), ok(5, 53), ok(10, 53), ok(15, 53)]));
    assert.equal(s.segments.length, 1);
    assert.equal(s.breaks.length, 0);
    assert.equal(s.medianIntervalMs, FIVE_MIN);
  });

  it('measures cadence from the data rather than assuming five minutes', () => {
    const hourly = [0, 60, 120, 180].map((m) => ok(m, 40));
    const s = buildScoreSeries(newestFirst(hourly));
    assert.equal(s.medianIntervalMs, 3_600_000);
    assert.equal(s.breaks.length, 0, 'a steady hourly cadence is not a gap');
  });

  describe('failed runs', () => {
    it('breaks the line and never contributes a score', () => {
      const s = buildScoreSeries(newestFirst([ok(0, 53), ok(5, 53), failed(10), ok(15, 51)]));

      assert.equal(s.points.length, 3, 'a failed run is not a point');
      assert.ok(
        !s.points.some((p) => p.score === 0),
        'a failed run must never appear as a zero score',
      );
      assert.equal(s.failures.length, 1);
      assert.equal(s.failures[0].error, 'RPC timeout');

      assert.equal(s.segments.length, 2, 'the line must break across the failure');
      assert.deepEqual(
        s.segments.map((seg) => seg.map((p) => p.score)),
        [[53, 53], [51]],
      );

      assert.equal(s.breaks.length, 1);
      assert.ok(s.breaks[0].kinds.includes('failure'));
      assert.ok(
        !s.breaks[0].kinds.includes('methodology'),
        'a failure is not a methodology change',
      );
    });

    it('breaks on a failure even though the time gap alone is under the threshold', () => {
      // The whole point of checking failures explicitly: one failed run widens
      // the spacing to only 2x the median, well below the 3x gap rule.
      const s = buildScoreSeries(newestFirst([ok(0, 53), ok(5, 53), failed(10), ok(15, 53)]));
      const gapRatio = (15 - 5) / 5;
      assert.ok(gapRatio < GAP_BREAK_FACTOR, 'fixture must sit under the gap threshold');
      assert.equal(s.segments.length, 2);
    });

    it('plots nothing but still reports failures when every run failed', () => {
      const s = buildScoreSeries(newestFirst([failed(0), failed(5), failed(10)]));
      assert.equal(s.points.length, 0);
      assert.equal(s.segments.length, 0);
      assert.equal(s.failures.length, 3);
      assert.ok(s.domain.end > s.domain.start, 'failed runs still define a time domain');
    });
  });

  describe('methodology breaks', () => {
    it('splits the line at a version bump and records both versions', () => {
      const s = buildScoreSeries(
        newestFirst([ok(0, 21, 1), ok(5, 21, 1), ok(10, 46, 2), ok(15, 46, 2)]),
      );

      assert.equal(s.segments.length, 2);
      assert.deepEqual(
        s.segments.map((seg) => seg.map((p) => p.score)),
        [
          [21, 21],
          [46, 46],
        ],
      );

      assert.equal(s.breaks.length, 1);
      const [b] = s.breaks;
      assert.ok(b.kinds.includes('methodology'));
      assert.equal(b.fromVersion, 1);
      assert.equal(b.toVersion, 2);
      // Anchored between the two runs — we only know it happened somewhere in there.
      assert.ok(b.at > b.from && b.at < b.to);
    });

    it('marks a break even when the score is identical either side', () => {
      // The step-change case is the obvious one; the silent case matters more.
      // Identical numbers under different rulebooks still are not comparable.
      const s = buildScoreSeries(newestFirst([ok(0, 53, 1), ok(5, 53, 2)]));
      assert.equal(s.breaks.length, 1);
      assert.ok(s.breaks[0].kinds.includes('methodology'));
    });
  });

  describe('indexing gaps', () => {
    it('breaks the line across an outage longer than 3x the median interval', () => {
      // Mirrors the real 20h outage between 2026-08-12 and 2026-08-13.
      const s = buildScoreSeries(
        newestFirst([ok(0, 54), ok(5, 54), ok(1220, 53), ok(1225, 53), ok(1230, 53)]),
      );
      assert.equal(s.segments.length, 2);
      const gapBreaks = s.breaks.filter((b) => b.kinds.includes('gap'));
      assert.equal(gapBreaks.length, 1);
      assert.equal(gapBreaks[0].from, T0 + 5 * 60_000);
      assert.equal(gapBreaks[0].to, T0 + 1220 * 60_000);
    });

    it('tolerates ordinary jitter without breaking', () => {
      // 5, 5, 6, 5 minute spacing — a late cron tick is not an outage.
      const s = buildScoreSeries(
        newestFirst([ok(0, 53), ok(5, 53), ok(10, 53), ok(16, 53), ok(21, 53)]),
      );
      assert.equal(s.segments.length, 1);
      assert.equal(s.breaks.length, 0);
    });

    it('records both kinds when a version bump happens across an outage', () => {
      const s = buildScoreSeries(newestFirst([ok(0, 21, 1), ok(5, 21, 1), ok(600, 46, 2)]));
      assert.equal(s.breaks.length, 1);
      assert.deepEqual([...s.breaks[0].kinds].sort(), ['gap', 'methodology']);
    });
  });
});

describe('timeTicks', () => {
  it('returns nothing for a zero-width domain', () => {
    assert.deepEqual(timeTicks(T0, T0), []);
  });

  it('produces at most `max` round, step-aligned ticks', () => {
    const ticks = timeTicks(T0, T0 + 4 * 3_600_000 + 5 * 60_000, 6);
    assert.ok(ticks.length > 1 && ticks.length <= 6, `got ${ticks.length} ticks`);
    for (const { t, step } of ticks) {
      assert.equal(t % step, 0, 'ticks must land on round times');
    }
  });

  it('scales up to day steps over a multi-day domain', () => {
    const ticks = timeTicks(T0, T0 + 30 * 86_400_000, 6);
    assert.ok(ticks.length <= 6);
    assert.ok(ticks[0].step >= 86_400_000, 'a month-wide axis should not tick hourly');
  });
});
