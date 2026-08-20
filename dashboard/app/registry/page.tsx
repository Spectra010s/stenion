import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowUpRight, ServerCrash, ShieldCheck } from 'lucide-react';
import { getProtocols, type LeaderboardEntry } from '../lib/api';
import { bandColor, bandTextClass, formatTimestamp, freshness, scoreBand } from '../lib/format';
import { cn } from '../lib/cn';
import { FreshnessTooltip, StatusPill } from '../../components/status-pill';
import { MarkAttribution, ProtocolLogo } from '../../components/protocol-logo';
import { DeploymentBadge } from '../../components/deployment-badge';
import { Reveal, RevealGroup, RevealItem } from '../../components/reveal';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Protocol registry',
  description:
    'Every protocol Stenion tracks, ranked purely by on-chain safety score. Free, public, payment-blind.',
};

export default async function RegistryPage() {
  let protocols: LeaderboardEntry[] | null = null;
  let errored = false;
  try {
    protocols = await getProtocols();
  } catch {
    errored = true;
  }

  // Derived from what was actually fetched, never assumed. The note below
  // explains a category of row, so it may only appear when the board really
  // contains one — otherwise it describes members that aren't there, which is a
  // worse failure than saying nothing: a reader looks for the labelled row,
  // doesn't find it, and learns the copy can't be trusted.
  //
  // It matters because the two can genuinely come apart. The registry renders
  // from the database, and a `deployedOn` entry only lands there once an indexer
  // cycle has upserted it — so between deploying a new pool config and the first
  // cycle that runs it, the code knows about a market the board does not. Same
  // for a pool later removed from BLEND_POOLS, or one whose row is present but
  // never scored.
  const hasDeployedEntries = (protocols ?? []).some((p) => p.deployedOn !== null);

  return (
    <div className="mx-auto max-w-6xl px-5 py-14">
      <Reveal>
        <span className="text-xs font-medium uppercase tracking-[0.18em] text-muted">
          Ranked by safety score · payment-blind
        </span>
        <h1 className="mt-5 font-display text-4xl font-semibold tracking-tight text-ink">
          Protocol registry
        </h1>
        <p className="mt-3 max-w-2xl text-muted">
          Every protocol Stenion tracks, ordered by its live safety score — higher is safer. Ranking
          is derived purely from on-chain data; no protocol can pay to move up. Open a protocol to
          see the full factor breakdown behind its number.
        </p>
        {/* Said once at the top rather than only per-row: a reader who scans the
            list and leaves should know that a row is not necessarily a distinct
            protocol, even if they never hover the badge that says which.
            Conditional, because a standing claim about "some entries" with no
            such entry on the board is a promise the page doesn't keep. */}
        {hasDeployedEntries && (
          <p className="mt-2 max-w-2xl text-sm text-faint">
            Some entries are individual markets running another protocol&rsquo;s contracts rather
            than protocols in their own right. Those are labelled on the row, and scored on their
            own reserves, oracle and admin like any other entry.
          </p>
        )}
      </Reveal>

      {errored ? (
        <ErrorState />
      ) : !protocols || protocols.length === 0 ? (
        <EmptyState />
      ) : (
        <Reveal delay={0.05} className="mt-10">
          {/* header row (desktop) */}
          <div className="hidden grid-cols-[3rem_1fr_8rem_10rem_11rem] gap-4 border-b border-line px-4 pb-3 text-xs uppercase tracking-wider text-faint md:grid">
            <span>#</span>
            <span>Protocol</span>
            <span>Chain</span>
            <span>Safety score</span>
            <span>Freshness</span>
          </div>

          <RevealGroup className="divide-y divide-line-soft" stagger={0.05}>
            {protocols.map((p, i) => (
              <RevealItem key={p.id}>
                <ProtocolRow entry={p} rank={i + 1} />
              </RevealItem>
            ))}
          </RevealGroup>

          <MarkAttribution className="mt-8  border-t border-line-soft pt-6 max-w-7xl" />
        </Reveal>
      )}
    </div>
  );
}

function ProtocolRow({ entry, rank }: { entry: LeaderboardEntry; rank: number }) {
  const band = scoreBand(entry.safetyScore);
  const pct = entry.safetyScore ?? 0;
  const fresh = freshness(entry.lastRunStatus, entry.safetyScore !== null);
  // A failed last run has to be visible while SCANNING, not only on the row you
  // happen to read: the row itself carries an accent rule and a faint accent
  // wash, so the exception is findable without comparing timestamps. Accent,
  // never a band colour — see freshnessPillClass.
  const stale = fresh.tone === 'stale';

  return (
    <Link
      href={`/protocol/${entry.id}`}
      className={cn(
        'group grid grid-cols-1 gap-3 px-4 py-5 transition-colors hover:bg-surface/50 md:grid-cols-[3rem_1fr_8rem_10rem_11rem] md:items-center md:gap-4',
        stale && 'bg-accent/5 shadow-[inset_3px_0_0_0_var(--color-accent)] hover:bg-accent/9',
      )}
    >
      <div className="tnum hidden text-sm text-faint md:block">{String(rank).padStart(2, '0')}</div>

      <div className="flex items-center gap-2">
        <span className="tnum mr-1 text-sm text-faint md:hidden">
          {String(rank).padStart(2, '0')}
        </span>
        {/* Mark first, then the name as text — the logo is an aid to scanning,
            never the identifier. A row stays fully readable with images off.

            The tilt and the arrow's nudge are `motion-safe:` rather than plain
            hover states: they're decoration, so under prefers-reduced-motion the
            row still highlights and the arrow still recolours, with nothing
            moving. */}
        <ProtocolLogo
          name={entry.name}
          logo={entry.logo}
          size={36}
          className="mr-1 transition-transform duration-200 ease-out motion-safe:group-hover:-rotate-6"
        />
        {/* Name and deployment label stack, so the label sits with the name it
            qualifies rather than trailing off to the right where a narrow
            viewport would wrap it away from its subject. */}
        <span className="flex min-w-0 flex-col items-start">
          <span className="flex items-center gap-2">
            <span className="font-display text-lg font-semibold text-ink">{entry.name}</span>
            <ArrowUpRight className="h-4 w-4 text-faint transition duration-200 ease-out group-hover:text-accent-ink motion-safe:group-hover:translate-x-0.5 motion-safe:group-hover:-translate-y-0.5" />
          </span>
          <DeploymentBadge deployedOn={entry.deployedOn} className="mt-1" />
        </span>
      </div>

      <div className="text-sm text-muted">
        <span className="text-xs uppercase tracking-wider text-faint md:hidden">Chain: </span>
        {entry.chain}
      </div>

      <div>
        <div className="flex items-baseline gap-2">
          <span className={`score-num text-2xl font-semibold ${bandTextClass(band)}`}>
            {entry.safetyScore ?? '—'}
          </span>
          <span className="text-xs text-faint">/ 100</span>
        </div>
        <div className="mt-1.5 h-1 w-full max-w-[9rem] overflow-hidden rounded-full bg-line-soft">
          <div
            className="h-full rounded-full"
            style={{ width: `${pct}%`, background: bandColor(band) }}
          />
        </div>
      </div>

      {/* `relative` anchors the tooltip; the tooltip itself reveals on hover or
          keyboard focus of the row (this whole cell's `group` is the <Link>). */}
      <div className="relative flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusPill lastRunStatus={entry.lastRunStatus} hasScore={entry.safetyScore !== null} />
        {/* The always-visible half of the explanation. A tooltip alone would
            leave a touch user with nothing but the word "failed". */}
        {stale && (
          <span className="w-full text-xs leading-snug text-muted">
            {entry.safetyScore !== null ? 'showing last good score' : 'no score to show'}
          </span>
        )}
        <span className="text-xs text-faint md:hidden">{formatTimestamp(entry.lastRunAt)}</span>
        {stale && <FreshnessTooltip text={fresh.explanation} />}
      </div>
    </Link>
  );
}

function EmptyState() {
  return (
    <div className="mt-10 rounded-xl border border-line surface-lit p-10 text-center">
      <ShieldCheck className="mx-auto h-8 w-8 text-accent" />
      <h2 className="mt-4 font-display text-lg font-semibold text-ink">No protocols scored yet</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted">
        The indexer hasn&apos;t published a run yet. Once it does, protocols will appear here ranked
        by safety score.
      </p>
    </div>
  );
}

function ErrorState() {
  return (
    <div className="mt-10 rounded-xl border border-danger/25 bg-danger/5 p-10 text-center">
      <ServerCrash className="mx-auto h-8 w-8 text-danger" />
      <h2 className="mt-4 font-display text-lg font-semibold text-ink">
        Couldn&apos;t reach the Stenion API
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted">
        The registry is served from the Stenion API, which appears to be unavailable right now. This
        is a data-availability issue, not a scoring change — try again shortly.
      </p>
    </div>
  );
}
