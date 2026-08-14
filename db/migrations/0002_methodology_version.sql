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

-- DEFAULT 1 is deliberate, and it is what makes this migration safe to apply
-- before the new indexer is live. Migrations run against the one shared Neon
-- database, but `main` (what Vercel deploys, and what the cron job drives) may
-- still be running the v1 indexer, which inserts without this column. Without a
-- default those writes would produce NULL on an `ok` row, violate the CHECK
-- below, and every production indexer cycle would fail until main was promoted.
--
-- A default of 1 is also correct rather than merely convenient: a writer that
-- doesn't know about this column is by definition scoring under v1.
--
-- FOLLOW-UP: once main carries an indexer that passes methodology_version
-- explicitly, drop the default in a later migration. Leaving it forever is a
-- footgun — a future v3 writer that forgot the column would be silently stamped
-- 1 instead of failing loudly.
ALTER TABLE risk_scores
  ADD COLUMN IF NOT EXISTS methodology_version smallint DEFAULT 1;

-- Existing ok rows predate v2 by definition.
UPDATE risk_scores
   SET methodology_version = 1
 WHERE status = 'ok' AND methodology_version IS NULL;

-- Only the `ok` side is enforced for now, on purpose. The mirror clause
-- (`status = 'failed' AND methodology_version IS NULL`) cannot be added while
-- the DEFAULT above exists: the still-deployed v1 indexer inserts failed rows
-- without naming this column, so they would pick up the default of 1 and fail
-- the constraint — the exact production breakage the default is there to avoid.
--
-- The new store writes an explicit NULL on failed rows, so once main carries it
-- the failed side becomes true in practice, and the same follow-up migration
-- that drops the default can tighten this constraint to the full union.
ALTER TABLE risk_scores
  DROP CONSTRAINT IF EXISTS risk_scores_methodology_version_shape;

ALTER TABLE risk_scores
  ADD CONSTRAINT risk_scores_methodology_version_shape CHECK (
    status <> 'ok' OR methodology_version IS NOT NULL
  );
