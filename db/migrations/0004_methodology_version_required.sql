-- Close the follow-up 0002 left open: drop `methodology_version`'s DEFAULT and
-- tighten its CHECK to the full ok/failed union.
--
-- Why this is a correctness guard, not schema tidiness. 0002's DEFAULT 1 was
-- correct as well as convenient: a writer that didn't know about the column was
-- *by definition* scoring under v1, so the silent stamp and the right answer
-- coincided. Flattening the methodology to v1 (the only version that exists —
-- see METHODOLOGY.md "Current version") made that coincidence permanent and
-- inverted it. A future writer that bumps METHODOLOGY_VERSION to 2 and forgets
-- this column on some new insert path would now be silently stamped 1,
-- indistinguishable from a correctly-stamped v1 row.
--
-- That is exactly the failure this column exists to prevent, and it is
-- unrepairable: risk_scores stores only outputs — the score and the factor map —
-- never the raw on-chain inputs, so a mis-stamped row cannot be recomputed to
-- find out which rulebook produced it. Failing loudly costs one indexer cycle.
-- Getting it wrong costs the integrity of the history.
--
-- SAFE TO APPLY WHILE `main` IS SERVING — the same live-writer hazard 0002 and
-- 0003 document. The deployed indexer names this column explicitly on both arms
-- of the union (indexer/src/cycle.ts stamps METHODOLOGY_VERSION on the ok
-- record; db/src/store.ts's insertRunRecord passes an explicit NULL on the
-- failed one), so nothing in production relies on the default any more. That is
-- the precondition 0002 named, and it is met.
ALTER TABLE risk_scores
  ALTER COLUMN methodology_version DROP DEFAULT;

-- The failed half was deliberately omitted from 0002: the then-deployed indexer
-- inserted failed rows without naming the column, so they would have picked up
-- the default and violated the constraint. With the default gone and the store
-- writing an explicit NULL, the mirror clause is now true in practice, and
-- risk_scores_methodology_version_shape becomes the same discriminated union
-- risk_scores_shape already enforces.
--
-- If this ADD CONSTRAINT fails, it is telling the truth: some existing failed
-- row carries a version stamp. Do NOT paper over it with an UPDATE ... SET NULL
-- in this file — that would silently rewrite stored history, which is the thing
-- the version column exists to prevent. Go look at the rows first.
ALTER TABLE risk_scores
  DROP CONSTRAINT IF EXISTS risk_scores_methodology_version_shape;

ALTER TABLE risk_scores
  ADD CONSTRAINT risk_scores_methodology_version_shape CHECK (
    (status =  'ok' AND methodology_version IS NOT NULL) OR
    (status <> 'ok' AND methodology_version IS NULL)
  );
