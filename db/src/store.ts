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
      computedAt: string;
      runAt: string;
    }
  | {
      protocolId: string;
      status: 'failed';
      error: string;
      runAt: string;
    };

export interface Store {
  /** Insert-or-update the protocol row from adapter metadata. Idempotent. */
  upsertProtocol(metadata: ProtocolMetadata, adapterRef: string): Promise<void>;
  /** Append one run outcome to risk_scores. */
  insertRunRecord(record: RunRecord): Promise<void>;
}

export function createStore(pool: Pool): Store {
  return {
    async upsertProtocol(metadata, adapterRef) {
      await pool.query(
        `INSERT INTO protocols (id, name, chain, adapter)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE
           SET name = EXCLUDED.name,
               chain = EXCLUDED.chain,
               adapter = EXCLUDED.adapter,
               updated_at = now()`,
        [metadata.id, metadata.name, metadata.chain, adapterRef],
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
            ]
          : [record.protocolId, 'failed', null, null, record.error, null, record.runAt];

      await pool.query(
        `INSERT INTO risk_scores
           (protocol_id, status, safety_score, factors, error, computed_at, run_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
        values,
      );
    },
  };
}
