-- Token buckets for the public API's rate limiter.
--
-- WHY A TABLE AND NOT MEMORY. The API runs as Vercel serverless functions. Each
-- invocation is its own process, and Vercel runs as many concurrent instances as
-- traffic demands, so a module-level counter is per-instance: N warm instances
-- would allow N x the intended rate while reporting that the limit is enforced.
-- False confidence is worse than no limiter, so the counter has to live somewhere
-- every instance can see. The only such place this project already pays for is
-- Neon, and `pg` is already a dependency — hence a table.
--
-- WHY A TOKEN BUCKET AND NOT A FIXED WINDOW. A fixed window lets a client spend
-- its whole allowance at the end of one window and again at the start of the
-- next, i.e. 2x the documented rate across a boundary, and it needs a row per
-- (client, window) so the table grows with time as well as with clients. A token
-- bucket is one row per client forever, refilled lazily from `updated_at`, and it
-- expresses the thing we actually want to say to an integrator: a sustained rate,
-- plus a burst they can spend up front.
--
-- One row is one client bucket. `bucket_key` is a SALTED SHA-256 PREFIX OF THE
-- CLIENT IP, never the IP itself: the limiter only ever needs to know that two
-- requests came from the same place, and it never needs to know where that is.
-- Rows for clients that have gone quiet are pruned opportunistically by the
-- limiter (see db/src/rate-limit.ts), so the table stays proportional to *active*
-- clients rather than to every client ever seen.
--
-- SAFE TO APPLY WHILE `main` IS SERVING. Nothing existing reads or writes this
-- table, and the code that will is written to fail OPEN if the table is missing
-- (a limiter outage must not become an API outage), so the migration and the
-- deploy can land in either order.
CREATE TABLE IF NOT EXISTS api_rate_limits (
  -- Salted SHA-256 prefix of the client identifier. Not reversible to an IP by
  -- us or by anyone who gets the table without also getting the salt.
  bucket_key text PRIMARY KEY,

  -- Tokens remaining after the request that last touched this row. Fractional,
  -- because refill is continuous. May go as low as -1: a request that is refused
  -- still spends the token it asked for, bounded at one token of debt, so a
  -- client that ignores 429s and keeps hammering does not walk its own bucket
  -- back up. Backing off for the advertised `Retry-After` clears it.
  tokens double precision NOT NULL,

  -- When `tokens` was last computed. Refill is derived from the gap between this
  -- and now(), which is why there is no background job: an idle bucket costs
  -- nothing and is correct the moment it is next read.
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Supports only the prune sweep (DELETE ... WHERE updated_at < ...). The hot path
-- is a primary-key upsert and needs no help.
CREATE INDEX IF NOT EXISTS api_rate_limits_updated_at_idx
  ON api_rate_limits (updated_at);
