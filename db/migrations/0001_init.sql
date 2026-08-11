-- Stenion storage schema — build-order step 5.
--
-- Two tables, built around the exact RunRecord shape step 4's indexer already
-- produces (see indexer/src/index.ts): `protocols` is one row per protocol
-- (adapter); `risk_scores` is the append-only history of indexer run outcomes.
--
-- factors is stored as a single jsonb column because it is a lossless 1:1
-- mirror of the RiskFactorMap the adapter emits ({value,weight,detail} per
-- factor, members may be null) and the factor taxonomy is a breaking change
-- felt by every adapter when it grows — jsonb absorbs that without a schema
-- change. safety_score is promoted to its own column because the leaderboard
-- ranks on it.

CREATE TABLE IF NOT EXISTS protocols (
  id          text PRIMARY KEY,        -- slug, = ProtocolMetadata.id / RunRecord.protocolId
  name        text        NOT NULL,
  chain       text        NOT NULL,    -- ProtocolMetadata.chain ('stellar')
  adapter     text        NOT NULL,    -- adapter reference (class name, e.g. 'BlendAdapter')
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS risk_scores (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  protocol_id   text        NOT NULL REFERENCES protocols (id),
  status        text        NOT NULL CHECK (status IN ('ok', 'failed')),
  safety_score  numeric,                    -- 0-100, higher = safer; NULL on failed runs
  factors       jsonb,                      -- RiskFactorMap; NULL on failed runs
  error         text,                       -- failure message; NULL on ok runs
  computed_at   timestamptz,                -- adapter compute time; NULL on failed runs
  run_at        timestamptz NOT NULL,       -- indexer cycle time; present in both cases
  inserted_at   timestamptz NOT NULL DEFAULT now(),

  -- Enforce the discriminated union at the DB level so a malformed write can't
  -- land: an ok row carries score/factors/computed_at and no error; a failed
  -- row carries an error and none of the score fields.
  CONSTRAINT risk_scores_shape CHECK (
    (status = 'ok'
       AND safety_score IS NOT NULL AND factors IS NOT NULL
       AND computed_at IS NOT NULL AND error IS NULL)
    OR
    (status = 'failed'
       AND error IS NOT NULL AND safety_score IS NULL
       AND factors IS NULL AND computed_at IS NULL)
  )
);

-- Latest-score-per-protocol lookups drive both the leaderboard and
-- GET /protocol/:id (step 6), so index (protocol_id, run_at DESC).
CREATE INDEX IF NOT EXISTS risk_scores_protocol_run_at_idx
  ON risk_scores (protocol_id, run_at DESC);
