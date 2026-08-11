import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  FACTOR_ORDER,
  getProtocolDetail,
  type HistoryEntry,
  type RiskFactor,
} from '../../lib/api';
import { formatTimestamp, scoreBand, stalenessLabel } from '../../lib/format';

export const dynamic = 'force-dynamic';

// Next 15: dynamic route params are async.
export default async function ProtocolDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const detail = await getProtocolDetail(id);
  if (!detail) notFound();

  const staleness = stalenessLabel(detail.lastRunStatus, detail.safetyScore !== null);

  return (
    <>
      <p className="back">
        <Link href="/">← Leaderboard</Link>
      </p>

      <h1>{detail.name}</h1>
      <p className="subtle">
        {detail.chain} · adapter <code>{detail.adapter}</code>
      </p>

      <div className="score-hero">
        <span className={`big score-${scoreBand(detail.safetyScore)}`}>
          {detail.safetyScore ?? '—'}
        </span>
        <span className="outof">/ 100 safety</span>
        <span
          className={`pill ${
            staleness.tone === 'ok' ? 'ok' : staleness.tone === 'warn' ? 'warn' : ''
          }`}
        >
          {staleness.text}
        </span>
      </div>
      <p className="subtle">
        {detail.computedAt
          ? `Scored ${formatTimestamp(detail.computedAt)}`
          : 'Not yet scored'}
        {' · '}last run {formatTimestamp(detail.lastRunAt)}
      </p>

      <section className="factors">
        {detail.factors === null ? (
          <div className="notice">
            No factor breakdown yet — this protocol has no successful score run.
          </div>
        ) : (
          FACTOR_ORDER.map(({ key, label }) => (
            <FactorRow key={key} label={label} factor={detail.factors![key]} />
          ))
        )}
      </section>

      <History history={detail.history} />
    </>
  );
}

function FactorRow({ label, factor }: { label: string; factor: RiskFactor | null }) {
  if (factor === null) {
    return (
      <div className="factor na">
        <div className="factor-head">
          <span className="factor-name">{label}</span>
          <span className="factor-value">N/A</span>
        </div>
        <p className="factor-detail">Not applicable to this protocol.</p>
      </div>
    );
  }
  const band = scoreBand(factor.value);
  return (
    <div className="factor">
      <div className="factor-head">
        <span className="factor-name">
          {label}{' '}
          <span className="factor-weight">
            (weight {Math.round(factor.weight * 100)}%)
          </span>
        </span>
        <span className={`factor-value score-${band}`}>{factor.value}</span>
      </div>
      <div className="bar">
        <span
          className={`bar-${band === 'none' ? 'low' : band}`}
          style={{ width: `${Math.max(0, Math.min(100, factor.value))}%` }}
        />
      </div>
      <p className="factor-detail">{factor.detail}</p>
    </div>
  );
}

function History({ history }: { history: HistoryEntry[] }) {
  if (history.length === 0) return null;
  return (
    <section className="history">
      <h2 style={{ fontSize: '1.1rem' }}>Recent runs</h2>
      <ul>
        {history.map((h, i) => (
          <li key={i}>
            <span className={`dot ${h.status}`} />
            <span className="when">{formatTimestamp(h.runAt)}</span>
            {h.status === 'ok' ? (
              <span>
                scored <strong>{h.safetyScore}</strong>
              </span>
            ) : (
              <span className="err">failed — {h.error}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
