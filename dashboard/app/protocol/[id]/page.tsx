import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActivitySquare, ArrowLeft, Boxes, Search } from 'lucide-react';
import { notesFor, type ProtocolNote } from '../../lib/protocol-notes';
import {
  FACTOR_ORDER,
  getProtocolDetail,
  type HistoryEntry,
  type ProtocolDetail,
  type RiskFactorKey,
  type RiskFactorMap,
} from '../../lib/api';
import { formatTimestamp } from '../../lib/format';
import { ScoreRing } from '../../../components/score-ring';
import { StatusPill } from '../../../components/status-pill';
import { FactorCard } from '../../../components/factor-bar';
import { Reveal, RevealGroup, RevealItem } from '../../../components/reveal';
import { ScoreHistoryChart } from '../../../components/score-history-chart';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getProtocolDetail(id).catch(() => null);
  // An unknown id makes the page component below throw notFound(), which renders
  // app/not-found.tsx — and that file supplies its own title. Anything returned
  // here for a missing protocol is discarded, so don't pretend to set one.
  if (!detail) return {};
  const score = detail.safetyScore ?? '—';
  return {
    title: `${detail.name} — safety ${score}`,
    description: `Live Stenion safety score and factor breakdown for ${detail.name} on ${detail.chain}.`,
  };
}

export default async function ProtocolDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getProtocolDetail(id);
  // Real 404 status, not just the 404 UI. This only works because there is NO
  // Suspense boundary above this route — no loading.tsx here, and the homepage's
  // one is scoped to the (home) route group. Any enclosing boundary lets Next
  // flush the 200 shell before this throws, which renders the not-found page
  // under a 200 (a soft-404 that search engines index as a real page).
  // DO NOT add a loading.tsx to this route without re-checking the status code.
  if (!detail) notFound();

  return (
    <div className="mx-auto max-w-4xl px-5 py-12">
      <Reveal>
        <Link
          href="/registry"
          className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" /> Registry
        </Link>
      </Reveal>

      <Hero detail={detail} />

      <section className="mt-14">
        <Reveal>
          <div className="flex items-center gap-2">
            <Boxes className="h-4 w-4 text-accent" />
            <h2 className="font-display text-xl font-semibold text-ink">Factor breakdown</h2>
          </div>
          <p className="mt-1 text-sm text-muted">
            Why the score is what it is — each factor on a 0–100 scale, higher is safer.
          </p>
        </Reveal>

        {detail.factors === null ? (
          <div className="mt-6 rounded-xl border border-line surface-lit p-8 text-center text-sm text-muted">
            No factor breakdown yet — this protocol has no successful score run.
          </div>
        ) : (
          <FactorBreakdown factors={detail.factors} />
        )}
      </section>

      <Findings notes={notesFor(detail.id)} name={detail.name} />

      <ScoreHistory history={detail.history} />

      <History history={detail.history} />
    </div>
  );
}

/**
 * The five factors, laid out by how much each one actually has to say.
 *
 * A factor that publishes a `components` breakdown carries several times the
 * content of one that doesn't — today `oracleSafety` is the only one, with three
 * sub-signals and roughly six times the text of any other factor. In a uniform
 * two-column grid that forced its row partner to stretch to match, leaving a
 * tall empty gap beside it (and, with five cards in two columns, an orphan on
 * the last row). Factors with a breakdown get the full width instead; the rest
 * fill an even grid.
 *
 * This is a presentation choice, not a ranking one — the registry still ranks
 * purely on `safetyScore`, and giving a factor more room says nothing about its
 * value. It's keyed off having a breakdown rather than hardcoding `oracleSafety`
 * so a factor that gains components later is laid out correctly without a change
 * here. Note it does reorder the display: featured factors lead, and the rest
 * follow in FACTOR_ORDER.
 */
function FactorBreakdown({ factors }: { factors: RiskFactorMap }) {
  const hasBreakdown = (key: RiskFactorKey) => (factors[key]?.components?.length ?? 0) > 0;
  const featured = FACTOR_ORDER.filter((f) => hasBreakdown(f.key));
  const compact = FACTOR_ORDER.filter((f) => !hasBreakdown(f.key));

  return (
    <div className="mt-6 space-y-3">
      {featured.length > 0 && (
        <RevealGroup className="space-y-3" stagger={0.06}>
          {featured.map(({ key, label }, i) => (
            <RevealItem key={key}>
              <FactorCard label={label} factor={factors[key]} index={i} featured />
            </RevealItem>
          ))}
        </RevealGroup>
      )}

      {compact.length > 0 && (
        <RevealGroup className="grid gap-3 sm:grid-cols-2" stagger={0.06}>
          {compact.map(({ key, label }, i) => (
            <RevealItem key={key} className="h-full">
              <FactorCard label={label} factor={factors[key]} index={featured.length + i} />
            </RevealItem>
          ))}
        </RevealGroup>
      )}
    </div>
  );
}

/**
 * Verifiable observations about a protocol's setup that are deliberately NOT
 * scored. Rendered after the factor breakdown and labelled unmistakably, so it
 * can never read as part of the number — the registry ranks purely on score.
 */
function Findings({ notes, name }: { notes: ProtocolNote[]; name: string }) {
  if (notes.length === 0) return null;
  return (
    <section className="mt-14">
      <Reveal>
        <div className="flex items-center gap-2">
          <Search className="h-4 w-4 text-accent" />
          <h2 className="font-display text-xl font-semibold text-ink">Findings</h2>
        </div>
        <p className="mt-1 text-sm text-muted">
          What we found reading {name}&rsquo;s contracts that isn&rsquo;t captured by a factor.{' '}
          <span className="text-faint">
            These do not affect the score and cannot change the ranking.
          </span>
        </p>
      </Reveal>

      <RevealGroup className="mt-6 space-y-3" stagger={0.06}>
        {notes.map((note) => (
          <RevealItem key={note.title}>
            <article className="surface-lit rounded-xl border border-line p-5">
              <h3 className="font-medium text-ink">{note.title}</h3>
              {note.body.map((para, i) => (
                <p key={i} className="mt-2.5 text-sm leading-relaxed text-muted">
                  {para}
                </p>
              ))}
              <p className="mt-3.5 border-t border-line-soft pt-3 text-xs leading-relaxed text-faint">
                <span className="font-medium text-muted">Verify it yourself:</span> {note.verify}
              </p>
            </article>
          </RevealItem>
        ))}
      </RevealGroup>
    </section>
  );
}

function Hero({ detail }: { detail: ProtocolDetail }) {
  return (
    <Reveal delay={0.05} className="mt-6">
      <div className="flex flex-col items-start gap-8 rounded-2xl border border-line surface-lit p-8 sm:flex-row sm:items-center">
        <ScoreRing score={detail.safetyScore} size={176} />

        <div className="min-w-0 flex-1">
          <h1 className="font-display text-4xl font-semibold tracking-tight text-ink">
            {detail.name}
          </h1>
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
            <span className="capitalize">{detail.chain}</span>
            <span className="text-faint">·</span>
            <span>
              adapter{' '}
              <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-ink">
                {detail.adapter}
              </code>
            </span>
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <StatusPill
              lastRunStatus={detail.lastRunStatus}
              hasScore={detail.safetyScore !== null}
            />
            <span className="text-sm text-muted">
              {detail.computedAt
                ? `Scored ${formatTimestamp(detail.computedAt)}`
                : 'Not yet scored'}
            </span>
          </div>
          <p className="mt-1.5 text-xs text-faint">
            Last run {formatTimestamp(detail.lastRunAt)} · updated on every indexer cycle
          </p>
        </div>
      </div>
    </Reveal>
  );
}

/**
 * The score over time — the visible form of the "continuous, not static" pitch.
 * The chart is the reading; the run list below it is the receipts.
 */
function ScoreHistory({ history }: { history: HistoryEntry[] }) {
  return (
    <section className="mt-14">
      <Reveal>
        <div className="flex items-center gap-2">
          <ActivitySquare className="h-4 w-4 text-accent" />
          <h2 className="font-display text-xl font-semibold text-ink">Score history</h2>
        </div>
        <p className="mt-1 text-sm text-muted">
          Every indexer run, on a fixed 0–100 axis and a real time axis. The line breaks wherever
          the score is unknown — a failed run, an indexing gap, or a methodology change — rather
          than drawing through it.
        </p>
      </Reveal>

      <Reveal delay={0.05} className="mt-5">
        <ScoreHistoryChart history={history} />
      </Reveal>
    </section>
  );
}

function History({ history }: { history: HistoryEntry[] }) {
  if (history.length === 0) return null;
  return (
    <section className="mt-14">
      <Reveal>
        <h2 className="font-display text-xl font-semibold text-ink">Recent runs</h2>
        <p className="mt-1 text-sm text-muted">
          The last {history.length} scoring {history.length === 1 ? 'run' : 'runs'}, newest first.
        </p>
      </Reveal>

      <Reveal delay={0.05} className="mt-5 overflow-hidden rounded-xl border border-line">
        <ul className="divide-y divide-line-soft">
          {history.map((h, i) => {
            // History is newest-first, so the row *after* this one is older. When
            // its methodology version is lower, the rules changed between them —
            // mark it, so a step in the score doesn't read as a move in risk.
            const older = history[i + 1];
            const breakAfter =
              h.status === 'ok' &&
              older?.status === 'ok' &&
              older.methodologyVersion < h.methodologyVersion;

            return (
              <li key={i}>
                <div className="flex items-center gap-3 bg-surface/40 px-4 py-3 text-sm">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      h.status === 'ok' ? 'bg-safe' : 'bg-danger'
                    }`}
                  />
                  <span className="tnum w-40 shrink-0 text-muted">{formatTimestamp(h.runAt)}</span>
                  {h.status === 'ok' ? (
                    <span className="text-ink">
                      scored <span className="score-num font-semibold">{h.safetyScore}</span>
                    </span>
                  ) : (
                    <span className="truncate text-danger">failed — {h.error}</span>
                  )}
                </div>

                {breakAfter && (
                  <div className="border-t border-dashed border-line bg-surface-2/60 px-4 py-2.5 text-xs leading-relaxed text-faint">
                    <span className="font-medium text-muted">
                      Methodology v{(older as { methodologyVersion: number }).methodologyVersion} →
                      v{(h as { methodologyVersion: number }).methodologyVersion}.
                    </span>{' '}
                    Scoring rules changed here, so scores above and below this line are not
                    comparable. Earlier runs cannot be recomputed — only scores are stored, not the
                    on-chain inputs behind them.{' '}
                    <Link href="/methodology" className="underline hover:text-ink">
                      What changed
                    </Link>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Reveal>
    </section>
  );
}
