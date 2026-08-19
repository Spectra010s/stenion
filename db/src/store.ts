// Typed writes into the Stenion schema. The RunRecord shape below is the exact
// discriminated union the indexer already produces (step 4) — copied verbatim,
// not redesigned. This package now owns the persisted contract so both the
// indexer (writing) and the API (reading, step 6) agree on one definition.

import type { ProtocolMetadata, RiskFactorMap } from '@stenion/core';
import type { Pool } from 'pg';

/**
 * One indexer run outcome. Mirrors what the indexer emits per cycle:
 * `ok` carries the score/factors/computedAt; `failed` carries an error. The
 * DB's risk_scores_shape CHECK enforces this same split.
 */
export type RunRecord =
  | {
      protocolId: string;
      status: 'ok';
      safetyScore: number;
      factors: RiskFactorMap;
      /**
       * The METHODOLOGY_VERSION this score was computed under. Stamped by the
       * indexer from @stenion/core, not chosen per adapter — one rulebook
       * applies to every protocol. Scores with different versions are not
       * comparable; see migration 0002.
       */
      methodologyVersion: number;
      computedAt: string;
      runAt: string;
    }
  | {
      protocolId: string;
      status: 'failed';
      error: string;
      runAt: string;
    };

/**
 * One protocol on the leaderboard (GET /api/v1/protocols). `safetyScore`/`computedAt`
 * come from the latest *ok* run (null if the protocol has never scored
 * successfully); `lastRunAt`/`lastRunStatus` describe the most recent run of any
 * status, so a stale score (last run failed) is visible without another call.
 */
export interface LeaderboardEntry {
  id: string;
  name: string;
  chain: string;
  /**
   * Root-relative path to a logo the dashboard hosts, or null when the protocol
   * publishes no usable mark. Null is a supported, rendered state (an initials
   * tile) — never a broken image. See ProtocolMetadata.logo.
   *
   * The board carries `logo` but NOT `contractId`/`site`/`docs`: a logo is what
   * makes a row scannable, and the rest is verification detail nobody acts on
   * from a list. They stay on the detail response rather than being repeated
   * across every row of every leaderboard fetch.
   */
  logo: string | null;
  safetyScore: number | null;
  computedAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: 'ok' | 'failed' | null;
}

/**
 * One row of a protocol's recent score history (GET /api/v1/protocol/:id). A
 * discriminated union on `status` mirroring the persisted RunRecord: `ok` rows
 * carry the score + timestamps, `failed` rows carry the error. Factors are
 * deliberately omitted here (they live on the detail's top-level current score);
 * they remain in the risk_scores jsonb and can be surfaced later if needed.
 */
export type HistoryEntry =
  | {
      status: 'ok';
      safetyScore: number;
      /** methodology version this point was scored under — see migration 0002 */
      methodologyVersion: number;
      computedAt: string;
      runAt: string;
    }
  | { status: 'failed'; error: string; runAt: string };

/**
 * Full detail for one protocol (GET /api/v1/protocol/:id). Top-level
 * `safetyScore`/`computedAt`/`factors` describe the latest *ok* run (all null if
 * never scored); `lastRunAt`/`lastRunStatus` describe the newest run of any
 * status; `history` is the recent run rows, newest first.
 */
export interface ProtocolDetail {
  id: string;
  name: string;
  chain: string;
  adapter: string;
  /** see LeaderboardEntry.logo — same value, same null-is-fine contract */
  logo: string | null;
  /**
   * The Soroban contract the score was derived from, or null if unknown. A raw
   * C-address, deliberately NOT an explorer URL — the consumer picks the
   * explorer. This is the field that lets a reader check a score against the
   * chain instead of trusting it.
   */
  contractId: string | null;
  /**
   * The protocol's own site and documentation, null when it publishes none.
   *
   * Listed as the subject's own properties, not as a recommendation: a link
   * here is not endorsement, partnership, or any relationship with Stenion, and
   * any UI rendering them must say so. The dashboard uses
   * `rel="noopener noreferrer nofollow"` so a link cannot pass ranking signal
   * or hand the destination a window handle back into the page.
   */
  site: string | null;
  docs: string | null;
  safetyScore: number | null;
  computedAt: string | null;
  factors: RiskFactorMap | null;
  /**
   * Methodology version behind the current score (null if never scored). History
   * points carry their own, so a client can see where the rules changed rather
   * than reading a step change as a real move in risk.
   */
  methodologyVersion: number | null;
  lastRunAt: string | null;
  lastRunStatus: 'ok' | 'failed' | null;
  history: HistoryEntry[];
}

/** How many recent history rows GET /api/v1/protocol/:id returns. */
export const DETAIL_HISTORY_LIMIT = 50;

/**
 * One run's status and error, newest-first, for the indexer's consecutive-failure
 * check. Deliberately narrower than `HistoryEntry`: the streak logic needs only
 * whether a run failed, what it said, and when — never a score or a factor map.
 */
export interface RecentRun {
  status: 'ok' | 'failed';
  /** the failure message on a failed run; null on an ok one */
  error: string | null;
  runAt: string;
}

export interface Store {
  /**
   * Insert-or-update the protocol row from adapter metadata. Idempotent.
   *
   * The adapter reference comes from `metadata.adapterRef` rather than a
   * separate argument so there is exactly one source for it — see
   * ProtocolMetadata.adapterRef for why it must be a literal.
   */
  upsertProtocol(metadata: ProtocolMetadata): Promise<void>;
  /** Append one run outcome to risk_scores. */
  insertRunRecord(record: RunRecord): Promise<void>;
  /** Every protocol with its latest-ok score, ranked by score desc (nulls last). */
  listProtocolsWithLatestScore(): Promise<LeaderboardEntry[]>;
  /** One protocol's detail + recent history, or null if the id is unknown. */
  getProtocolDetail(id: string): Promise<ProtocolDetail | null>;
  /**
   * The newest `limit` runs for one protocol, newest first — status/error/runAt
   * only. This is what the indexer derives a consecutive-failure streak from
   * rather than persisting a counter: the history IS the streak, so the two
   * cannot disagree. An unknown protocol, or one with no runs yet, returns `[]`
   * — and an empty array must read as "no failures", never as "never succeeded".
   */
  listRecentRuns(protocolId: string, limit: number): Promise<RecentRun[]>;
}

/** timestamptz comes back from pg as a Date; the API contract is ISO strings. */
function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** numeric comes back from pg as a string; the API contract is a number. */
function toNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

// ---------------------------------------------------------------------------
// Row → response mapping
//
// Split out of the query methods and exported so the *shape* of the public API
// can be tested without a database. The SQL decides which rows come back and in
// what order; these decide what they look like on the wire — the discriminated
// union, the numeric/timestamp coercions, and the staleness fields. That second
// half is the part external consumers actually depend on.
// ---------------------------------------------------------------------------

/** A `risk_scores` row as pg returns it. */
export interface HistoryRow {
  status: 'ok' | 'failed';
  safety_score: string | null;
  error: string | null;
  computed_at: Date | null;
  run_at: Date;
  methodology_version: number | null;
}

/**
 * One history row → one `HistoryEntry`.
 *
 * The `ok` and `failed` arms carry disjoint fields on purpose: a failed run has
 * no score, and must never be representable as one (a zero here would render as
 * a real, very bad score rather than as "unknown"). The non-null assertions on
 * the ok arm are backed by the `risk_scores_shape` CHECK constraint.
 */
export function toHistoryEntry(row: HistoryRow): HistoryEntry {
  return row.status === 'ok'
    ? {
        status: 'ok',
        // non-null on ok rows by the risk_scores_shape CHECK
        safetyScore: toNumber(row.safety_score) as number,
        // non-null on ok rows by risk_scores_methodology_version_shape
        methodologyVersion: row.methodology_version as number,
        computedAt: toIso(row.computed_at) as string,
        runAt: row.run_at.toISOString(),
      }
    : {
        status: 'failed',
        error: row.error as string,
        runAt: row.run_at.toISOString(),
      };
}

/** A `protocols` row joined with its latest-ok score and newest run, as pg returns it. */
export interface ProtocolDetailRow {
  id: string;
  name: string;
  chain: string;
  adapter: string;
  logo: string | null;
  contract_id: string | null;
  site_url: string | null;
  docs_url: string | null;
  safety_score: string | null;
  computed_at: Date | null;
  factors: RiskFactorMap | null;
  methodology_version: number | null;
  last_run_at: Date | null;
  last_run_status: 'ok' | 'failed' | null;
}

/**
 * Detail row + history rows → the `GET /api/v1/protocol/:id` body.
 *
 * The staleness model lives here: `safetyScore`/`computedAt`/`factors` describe
 * the latest **ok** run and are null when a protocol has never scored, while
 * `lastRunAt`/`lastRunStatus` describe the newest run of **any** status. They
 * come from two separate LATERAL joins precisely so a failed cycle leaves the
 * last good score visible and flags it as stale, rather than blanking the entry.
 */
export function toProtocolDetail(
  row: ProtocolDetailRow,
  historyRows: HistoryRow[],
): ProtocolDetail {
  return {
    id: row.id,
    name: row.name,
    chain: row.chain,
    adapter: row.adapter,
    // Identity columns are nullable in the schema and pass straight through:
    // "this protocol has no published mark / no docs site" is a real answer the
    // UI renders deliberately, so there is nothing to coerce or default here.
    logo: row.logo,
    contractId: row.contract_id,
    site: row.site_url,
    docs: row.docs_url,
    safetyScore: toNumber(row.safety_score),
    computedAt: toIso(row.computed_at),
    factors: row.factors,
    methodologyVersion: row.methodology_version,
    lastRunAt: toIso(row.last_run_at),
    lastRunStatus: row.last_run_status,
    history: historyRows.map(toHistoryEntry),
  };
}

/** A `protocols` row joined with its latest-ok score, as pg returns it. */
export interface LeaderboardRow {
  id: string;
  name: string;
  chain: string;
  logo: string | null;
  safety_score: string | null;
  computed_at: Date | null;
  last_run_at: Date | null;
  last_run_status: 'ok' | 'failed' | null;
}

/** One leaderboard row → one `LeaderboardEntry`. Ranking is the SQL's job, not this. */
export function toLeaderboardEntry(row: LeaderboardRow): LeaderboardEntry {
  return {
    id: row.id,
    name: row.name,
    chain: row.chain,
    logo: row.logo,
    safetyScore: toNumber(row.safety_score),
    computedAt: toIso(row.computed_at),
    lastRunAt: toIso(row.last_run_at),
    lastRunStatus: row.last_run_status,
  };
}

export function createStore(pool: Pool): Store {
  return {
    async upsertProtocol(metadata) {
      // The identity columns are OVERWRITTEN on every cycle, like name/chain.
      // The adapter is the single source of truth for them, so a value edited
      // directly in the database is reverted within one indexer cycle (~5 min).
      //
      // That is the intended behaviour today — logos and links are
      // maintainer-managed, reviewed in a PR alongside the adapter — and it is
      // also the thing to know if protocol self-service ever ships: a
      // protocol-supplied mark MUST land in separate columns that take
      // precedence at read time, never as an edit to these. Widening this
      // statement to a COALESCE that preserves an existing value would be the
      // wrong fix: it would silently make the adapter unable to correct its own
      // metadata, which is exactly backwards for the case that matters (a
      // protocol supplying a mark that flatters, next to a score it dislikes).
      // See ProtocolMetadata.logo and CONTRIBUTING.md.
      await pool.query(
        `INSERT INTO protocols (id, name, chain, adapter, logo, contract_id, site_url, docs_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE
           SET name = EXCLUDED.name,
               chain = EXCLUDED.chain,
               adapter = EXCLUDED.adapter,
               logo = EXCLUDED.logo,
               contract_id = EXCLUDED.contract_id,
               site_url = EXCLUDED.site_url,
               docs_url = EXCLUDED.docs_url,
               updated_at = now()`,
        [
          metadata.id,
          metadata.name,
          metadata.chain,
          metadata.adapterRef,
          // `?? null` because these are optional on ProtocolMetadata: pg would
          // send `undefined` as NULL anyway, but being explicit keeps "the
          // adapter didn't set this" and "the column is NULL" the same thing.
          metadata.logo ?? null,
          metadata.contractId ?? null,
          metadata.links?.site ?? null,
          metadata.links?.docs ?? null,
        ],
      );
    },

    async insertRunRecord(record) {
      // Map the discriminated union to the nullable columns the CHECK expects.
      // factors is passed as a JSON string and cast to jsonb ($4::jsonb) so the
      // parameter type is unambiguous regardless of pg's object coercion.
      const values =
        record.status === 'ok'
          ? [
              record.protocolId,
              'ok',
              record.safetyScore,
              JSON.stringify(record.factors),
              null,
              record.computedAt,
              record.runAt,
              record.methodologyVersion,
            ]
          : [record.protocolId, 'failed', null, null, record.error, null, record.runAt, null];

      await pool.query(
        `INSERT INTO risk_scores
           (protocol_id, status, safety_score, factors, error, computed_at, run_at, methodology_version)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
        values,
      );
    },

    async listProtocolsWithLatestScore() {
      // Two LATERAL subqueries per protocol, each an index-only walk of
      // (protocol_id, run_at DESC): `ok` is the latest successful score shown on
      // the board, `latest` is the newest run of any status for the staleness
      // flag. Rank by score desc, never-scored protocols (null score) last.
      const { rows } = await pool.query<LeaderboardRow>(
        `SELECT p.id, p.name, p.chain, p.logo,
                ok.safety_score, ok.computed_at,
                latest.run_at AS last_run_at, latest.status AS last_run_status
           FROM protocols p
           LEFT JOIN LATERAL (
             SELECT safety_score, computed_at
               FROM risk_scores
              WHERE protocol_id = p.id AND status = 'ok'
              ORDER BY run_at DESC
              LIMIT 1
           ) ok ON true
           LEFT JOIN LATERAL (
             SELECT run_at, status
               FROM risk_scores
              WHERE protocol_id = p.id
              ORDER BY run_at DESC
              LIMIT 1
           ) latest ON true
          ORDER BY ok.safety_score DESC NULLS LAST, p.id`,
      );

      return rows.map(toLeaderboardEntry);
    },

    async getProtocolDetail(id) {
      // Protocol row + latest-ok score/factors + newest-run staleness fields, in
      // one query. No row → unknown id → null (the API turns this into a 404).
      const { rows } = await pool.query<ProtocolDetailRow>(
        `SELECT p.id, p.name, p.chain, p.adapter,
                p.logo, p.contract_id, p.site_url, p.docs_url,
                ok.safety_score, ok.computed_at, ok.factors, ok.methodology_version,
                latest.run_at AS last_run_at, latest.status AS last_run_status
           FROM protocols p
           LEFT JOIN LATERAL (
             SELECT safety_score, computed_at, factors, methodology_version
               FROM risk_scores
              WHERE protocol_id = p.id AND status = 'ok'
              ORDER BY run_at DESC
              LIMIT 1
           ) ok ON true
           LEFT JOIN LATERAL (
             SELECT run_at, status
               FROM risk_scores
              WHERE protocol_id = p.id
              ORDER BY run_at DESC
              LIMIT 1
           ) latest ON true
          WHERE p.id = $1`,
        [id],
      );

      const row = rows[0];
      if (!row) return null;

      const { rows: historyRows } = await pool.query<HistoryRow>(
        `SELECT status, safety_score, error, computed_at, run_at, methodology_version
           FROM risk_scores
          WHERE protocol_id = $1
          ORDER BY run_at DESC
          LIMIT $2`,
        [id, DETAIL_HISTORY_LIMIT],
      );

      return toProtocolDetail(row, historyRows);
    },

    async listRecentRuns(protocolId, limit) {
      // Same (protocol_id, run_at DESC) index the LATERAL joins above walk, with
      // a small LIMIT — this runs once per protocol per cycle, so it has to stay
      // an index walk rather than anything that touches the whole partition.
      const { rows } = await pool.query<{
        status: 'ok' | 'failed';
        error: string | null;
        run_at: Date;
      }>(
        `SELECT status, error, run_at
           FROM risk_scores
          WHERE protocol_id = $1
          ORDER BY run_at DESC
          LIMIT $2`,
        [protocolId, limit],
      );

      return rows.map((row) => ({
        status: row.status,
        error: row.error,
        runAt: row.run_at.toISOString(),
      }));
    },
  };
}
