// Types come from ./contract, not ./api: this module is imported by client
// components, and ./api is server-only. A type-only import would be erased
// either way, but importing from the contract keeps that from being a footgun
// the day someone needs a value from here.
import type { RunStatus } from './contract';

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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad2 = (n: number) => String(n).padStart(2, '0');

/** "07:20" (UTC). */
export function formatUtcTime(t: number | Date): string {
  const d = t instanceof Date ? t : new Date(t);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** "14 Aug" (UTC). */
export function formatUtcDay(t: number | Date): string {
  const d = t instanceof Date ? t : new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/**
 * Compact elapsed span: "45m", "4h 5m", "3d 2h". Used for spans measured from
 * real data — never to assert a window we assume but haven't checked.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return 'under a minute';
  // Rounds rather than floors: the indexer's real 4m59s median spacing floors
  // to "every 4m", which understates a cadence the product markets as 5-minute.
  const total = Math.round(ms / 60_000);
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

/**
 * A UTC range label, collapsing the end to a bare time when both ends fall on
 * the same UTC day: "14 Aug 07:20 → 11:25 UTC", else "11 Aug 11:23 → 14 Aug 11:25 UTC".
 */
export function formatUtcRange(startIso: string, endIso: string): string {
  const a = new Date(startIso);
  const b = new Date(endIso);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return '—';
  const sameDay =
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate();
  const left = `${formatUtcDay(a)} ${formatUtcTime(a)}`;
  const right = sameDay ? formatUtcTime(b) : `${formatUtcDay(b)} ${formatUtcTime(b)}`;
  return `${left} → ${right} UTC`;
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
