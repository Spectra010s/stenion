-- Stamp each scored run with the methodology version that produced it.
--
-- Why: `oracleSafety` changed meaning in methodology v2 (price age only ->
-- age + manipulation resistance; freshness re-anchored to each oracle's own
-- resolution/max-age). Scores either side of that change are not comparable.
--
-- Why not a backfill: risk_scores stores only *outputs* — the score and the
-- factor map — never the raw on-chain inputs a run was computed from. Old rows
-- therefore cannot be recomputed under the new rules, by us or by anyone. The
-- discontinuity is real and permanent; this column exists to make it legible
-- rather than silent, so the dashboard can mark the break in a score chart
-- instead of rendering an unexplained step change.
--
-- Existing rows are stamped 1 (the five-factor model as originally shipped),
-- which is what they were actually scored under. New rows carry
-- METHODOLOGY_VERSION from @stenion/core.
--
-- Nullable on failed runs: a failed run produced no score, so there is no
-- methodology to attribute it to. The CHECK below ties the column to the same
-- ok/failed discriminated union risk_scores_shape already enforces.

ALTER TABLE risk_scores
  ADD COLUMN IF NOT EXISTS methodology_version smallint;

-- Existing ok rows predate v2 by definition.
UPDATE risk_scores
   SET methodology_version = 1
 WHERE status = 'ok' AND methodology_version IS NULL;

ALTER TABLE risk_scores
  DROP CONSTRAINT IF EXISTS risk_scores_methodology_version_shape;

ALTER TABLE risk_scores
  ADD CONSTRAINT risk_scores_methodology_version_shape CHECK (
    (status = 'ok' AND methodology_version IS NOT NULL)
    OR
    (status = 'failed' AND methodology_version IS NULL)
  );
