import Link from 'next/link';
import { getProtocols, type LeaderboardEntry } from './lib/api';
import { formatTimestamp, scoreBand, stalenessLabel } from './lib/format';

// Always render fresh — scores change on the indexer's interval.
export const dynamic = 'force-dynamic';

export default async function LeaderboardPage() {
  let protocols: LeaderboardEntry[];
  try {
    protocols = await getProtocols();
  } catch (err) {
    return (
      <>
        <h1>Leaderboard</h1>
        <p className="subtle">Ranked by safety score — higher is safer.</p>
        <div className="notice">
          Couldn&apos;t reach the Stenion API, is it running ({String(err instanceof Error ? err.message : err)})
        </div>
      </>
    );
  }

  return (
    <>
      <h1>Leaderboard</h1>
      <p className="subtle">
        Ranked by safety score — higher is safer. The ranking is purely on-chain
        derived and payment-blind.
      </p>

      {protocols.length === 0 ? (
        <div className="notice">
          No protocols scored yet. Run the indexer at least once to populate the
          leaderboard.
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="rank">#</th>
              <th>Protocol</th>
              <th>Chain</th>
              <th>Safety</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {protocols.map((p, i) => {
              const staleness = stalenessLabel(p.lastRunStatus, p.safetyScore !== null);
              return (
                <tr key={p.id}>
                  <td className="rank">{i + 1}</td>
                  <td>
                    <Link href={`/protocol/${p.id}`}>{p.name}</Link>
                  </td>
                  <td className="subtle">{p.chain}</td>
                  <td className={`score score-${scoreBand(p.safetyScore)}`}>
                    {p.safetyScore ?? '—'}
                  </td>
                  <td>
                    <span
                      className={`pill ${
                        staleness.tone === 'ok'
                          ? 'ok'
                          : staleness.tone === 'warn'
                            ? 'warn'
                            : ''
                      }`}
                      title={`Last run: ${formatTimestamp(p.lastRunAt)}`}
                    >
                      {staleness.text}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
