import type { RunStatus } from './api';

/** Compact ISO-ish timestamp → readable UTC, e.g. "2026-08-11 13:24 UTC". */
export function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())} UTC`;
}

/**
 * A staleness label for the last run. The displayed score is always the latest
 * *ok* run, but if the newest run of any status failed, that's worth flagging —
 * the number on screen may be older than the last attempt.
 */
export function stalenessLabel(
  lastRunStatus: RunStatus | null,
  hasScore: boolean,
): { text: string; tone: 'ok' | 'warn' | 'none' } {
  if (lastRunStatus === null) return { text: 'never run', tone: 'none' };
  if (lastRunStatus === 'failed') {
    return {
      text: hasScore ? 'last run failed (score is stale)' : 'last run failed',
      tone: 'warn',
    };
  }
  return { text: 'live', tone: 'ok' };
}

export type ScoreBand = 'high' | 'mid' | 'low' | 'none';

/** Coarse safety band for score coloring — purely visual, not part of scoring. */
export function scoreBand(score: number | null): ScoreBand {
  if (score === null) return 'none';
  if (score >= 67) return 'high';
  if (score >= 34) return 'mid';
  return 'low';
}

/** The CSS color value (theme token) for a band — used by SVG strokes/inline fills. */
export function bandColor(band: ScoreBand): string {
  switch (band) {
    case 'high':
      return 'var(--color-safe)';
    case 'mid':
      return 'var(--color-warn)';
    case 'low':
      return 'var(--color-danger)';
    default:
      return 'var(--color-faint)';
  }
}

/** Tailwind text-color class for a band. */
export function bandTextClass(band: ScoreBand): string {
  switch (band) {
    case 'high':
      return 'text-safe';
    case 'mid':
      return 'text-warn';
    case 'low':
      return 'text-danger';
    default:
      return 'text-faint';
  }
}

/** Short human label for a band, e.g. for a legend. */
export function bandLabel(band: ScoreBand): string {
  switch (band) {
    case 'high':
      return 'Lower risk';
    case 'mid':
      return 'Elevated risk';
    case 'low':
      return 'High risk';
    default:
      return 'Unscored';
  }
}
