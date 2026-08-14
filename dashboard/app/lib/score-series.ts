// Turns the API's `history` array into something drawable.
//
// This module is deliberately PURE and framework-free: no React, no `pg`, no
// server-only import. Every judgment call the chart makes about *what is a
// discontinuity* lives here rather than in the component, so it can be tested
// against synthetic fixtures — which matters because the two cases that most
// need to be right (a failed run, a methodology bump) are rare-to-absent in
// live data and would otherwise ship unverified.
//
// THE CORE RULE: a break in the line means "we do not know the score here."
// A failed run is not a zero, a methodology change is not a risk movement, and
// an indexer outage is not a flat line. All three break the path instead.

import type { HistoryEntry } from './contract';

/**
 * How much longer than the typical spacing a gap must be before it counts as
 * missing data rather than normal jitter. The indexer's cadence is set by an
 * external scheduler (cron-job.org, every 5 min today) and is NOT declared
 * anywhere in this repo, so the baseline is measured from the data — the median
 * observed interval — never hardcoded to an assumed cadence.
 */
export const GAP_BREAK_FACTOR = 3;

/** Half-width of the synthetic domain used when every run shares one timestamp. */
const SINGLE_POINT_PAD_MS = 30 * 60_000;

export interface SeriesPoint {
  /** epoch ms of `runAt` */
  t: number;
  score: number;
  methodologyVersion: number;
  runAt: string;
}

export interface SeriesFailure {
  t: number;
  runAt: string;
  error: string;
}

export type BreakKind = 'methodology' | 'failure' | 'gap';

/** A discontinuity between two consecutive scored runs. */
export interface SeriesBreak {
  /** where to anchor the marker — the midpoint, since we only know it happened *between* two runs */
  at: number;
  /** the scored runs either side */
  from: number;
  to: number;
  /** a break can be several things at once (a version bump across an outage) */
  kinds: BreakKind[];
  fromVersion: number;
  toVersion: number;
}

export interface ScoreSeries {
  /** scored runs, oldest first */
  points: SeriesPoint[];
  /** failed runs, oldest first — rendered as markers, never as a score */
  failures: SeriesFailure[];
  /** contiguous stretches of `points` safe to join with a line */
  segments: SeriesPoint[][];
  breaks: SeriesBreak[];
  domain: { start: number; end: number };
  /** null when there are fewer than two runs to measure a cadence from */
  medianIntervalMs: number | null;
}

/**
 * Typical gap between consecutive runs. Null if there's nothing to measure.
 *
 * On an even-length sample this takes the LOWER of the two middle values rather
 * than averaging them. Averaging lets an outage inflate the very baseline the
 * outage is measured against: with runs at +0, +5min and +600min the two
 * intervals are 5min and 595min, whose mean is 300min — so a 10-hour hole would
 * sit comfortably under a 3x threshold and be drawn as an unbroken line. The
 * lower middle estimates the *normal* spacing, which is what the gap rule wants.
 */
function medianInterval(times: number[]): number | null {
  if (times.length < 2) return null;
  const diffs: number[] = [];
  for (let i = 1; i < times.length; i++) diffs.push(times[i] - times[i - 1]);
  diffs.sort((a, b) => a - b);
  const m = diffs[Math.floor((diffs.length - 1) / 2)];
  // A run of identical timestamps would yield 0 and make every later gap look
  // infinite; treat an unmeasurable cadence as unknown instead.
  return m > 0 ? m : null;
}

/**
 * Build the drawable series from the API's newest-first history.
 *
 * Failed runs contribute to the time domain and to the measured cadence (they
 * are real runs that happened) but never to the plotted line.
 */
export function buildScoreSeries(history: HistoryEntry[]): ScoreSeries {
  const entries = history
    .map((entry) => ({ entry, t: Date.parse(entry.runAt) }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);

  const points: SeriesPoint[] = [];
  const failures: SeriesFailure[] = [];
  for (const { entry, t } of entries) {
    if (entry.status === 'ok') {
      points.push({
        t,
        score: entry.safetyScore,
        methodologyVersion: entry.methodologyVersion,
        runAt: entry.runAt,
      });
    } else {
      failures.push({ t, runAt: entry.runAt, error: entry.error });
    }
  }

  const medianIntervalMs = medianInterval(entries.map((x) => x.t));
  const gapLimit = medianIntervalMs === null ? Infinity : medianIntervalMs * GAP_BREAK_FACTOR;

  const segments: SeriesPoint[][] = [];
  const breaks: SeriesBreak[] = [];
  let current: SeriesPoint[] = [];

  for (const point of points) {
    const prev = current[current.length - 1];
    if (prev === undefined) {
      current.push(point);
      continue;
    }

    const kinds: BreakKind[] = [];
    if (point.methodologyVersion !== prev.methodologyVersion) kinds.push('methodology');
    // An explicit check, not something the gap rule would catch: a single failed
    // run between two scored ones only widens the spacing to ~2 intervals, well
    // under the gap threshold. Without this the line would be drawn straight
    // through a run we know failed.
    if (failures.some((f) => f.t > prev.t && f.t < point.t)) kinds.push('failure');
    if (point.t - prev.t > gapLimit) kinds.push('gap');

    if (kinds.length > 0) {
      breaks.push({
        at: prev.t + (point.t - prev.t) / 2,
        from: prev.t,
        to: point.t,
        kinds,
        fromVersion: prev.methodologyVersion,
        toVersion: point.methodologyVersion,
      });
      segments.push(current);
      current = [point];
    } else {
      current.push(point);
    }
  }
  if (current.length > 0) segments.push(current);

  const times = entries.map((x) => x.t);
  let start = times.length > 0 ? Math.min(...times) : 0;
  let end = times.length > 0 ? Math.max(...times) : 0;
  if (start === end) {
    // One run (or several sharing a timestamp): a zero-width domain would divide
    // by zero and collapse the axis. Give it a real window and centre the point.
    const pad = medianIntervalMs ?? SINGLE_POINT_PAD_MS;
    start -= pad;
    end += pad;
  }

  return { points, failures, segments, breaks, domain: { start, end }, medianIntervalMs };
}

const TICK_STEPS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  3_600_000,
  2 * 3_600_000,
  3 * 3_600_000,
  6 * 3_600_000,
  12 * 3_600_000,
  86_400_000,
  2 * 86_400_000,
  7 * 86_400_000,
];

/**
 * Round timestamps across the domain, at most `max` of them. Aligned to the
 * step so labels land on readable times (07:15, not 07:23) — every step here
 * divides evenly into a UTC day, and the epoch is UTC midnight, so alignment
 * falls out of plain arithmetic with no timezone handling.
 */
export function timeTicks(start: number, end: number, max = 6): { t: number; step: number }[] {
  const span = end - start;
  if (!(span > 0)) return [];
  const step =
    TICK_STEPS_MS.find((s) => span / s <= max) ?? TICK_STEPS_MS[TICK_STEPS_MS.length - 1];
  const ticks: { t: number; step: number }[] = [];
  for (let t = Math.ceil(start / step) * step; t <= end; t += step) ticks.push({ t, step });
  return ticks;
}
