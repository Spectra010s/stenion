// A distributed token-bucket rate limiter backed by the one thing every
// serverless instance shares: Postgres.
//
// WHAT THIS GUARANTEES, AND WHAT IT DOESN'T.
//
//  - It IS shared. Every instance decrements the same row under a row lock, so
//    the limit is the limit no matter how many functions Vercel has warm. This
//    is the whole reason it isn't an in-memory Map: that would allow N x the
//    documented rate while claiming to enforce it.
//  - It is NOT a defence against a volumetric or distributed attack. It is
//    per-client-key, so a thousand hosts each staying under the limit are a
//    thousand clients as far as this is concerned. Stopping that is a network
//    -edge job (Vercel's firewall), not an application one.
//  - It costs ONE round trip per checked request. That is deliberate and it is
//    the price of the guarantee above. The caller's job is to make sure most
//    requests never get here: the CDN cache in front of the API means only
//    cache MISSES reach the function at all, and callers should short-circuit
//    an already-refused client in memory (memory may only ever REFUSE faster,
//    never allow, so a per-instance cache is sound for that direction).
//
// This module owns no policy. The numbers — burst, sustained rate — arrive as
// arguments from the caller, which is what keeps the pure half testable without
// a database and the tuning in one documented place.

import type { Pool } from 'pg';

/** How fast a bucket refills and how much it can hold. */
export interface RateLimitPolicy {
  /** Bucket capacity: the largest burst a client can spend in one go. */
  burst: number;
  /** Tokens added per second — the sustained rate once the burst is gone. */
  refillPerSecond: number;
}

/** The answer for one request. */
export interface RateLimitDecision {
  allowed: boolean;
  /**
   * Whole seconds until this client can expect to be served again. Always 0
   * when allowed, and always at least 1 when refused — a `Retry-After: 0` reads
   * as an invitation to retry immediately, which is the opposite of the point.
   */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  /** Spend one token from `bucketKey`'s bucket, creating it if it's new. */
  take(bucketKey: string, policy: RateLimitPolicy): Promise<RateLimitDecision>;
}

/**
 * Refill-and-spend, as one statement so it is atomic without an explicit
 * transaction. `ON CONFLICT DO UPDATE` takes a row lock, so two concurrent
 * requests for the same bucket serialise and cannot both read the same balance.
 *
 * The refill is computed from the row's own `updated_at` rather than from a
 * schedule, so an untouched bucket costs nothing and is still correct the
 * instant it is read again.
 *
 * `GREATEST(..., -1)` floors the debt at one token. A refused request still
 * spends, which is what stops a client that ignores 429s from hammering its own
 * bucket back to zero — but the floor bounds the penalty, so backing off for the
 * advertised Retry-After always clears it. See the migration for the long form.
 */
const TAKE_SQL = `
  INSERT INTO api_rate_limits AS rl (bucket_key, tokens, updated_at)
  VALUES ($1, $2::float8 - 1, now())
  ON CONFLICT (bucket_key) DO UPDATE
     SET tokens = GREATEST(
                    LEAST(
                      $2::float8,
                      rl.tokens + EXTRACT(EPOCH FROM (now() - rl.updated_at)) * $3::float8
                    ) - 1,
                    -1
                  ),
         updated_at = now()
  RETURNING tokens
`;

/**
 * Drop buckets nobody has touched in an hour. A bucket that idle is full by
 * definition, so deleting it is indistinguishable from keeping it — the next
 * request just inserts a fresh full one.
 *
 * This is why there is no cron job and no TTL machinery: the table stays
 * proportional to *active* clients rather than to every client ever seen, and
 * the sweep is an index range scan the caller runs on a small fraction of
 * requests.
 */
const PRUNE_SQL = `DELETE FROM api_rate_limits WHERE updated_at < now() - interval '1 hour'`;

/**
 * Post-update balance -> decision. Pure, and exported so the arithmetic that
 * decides both "refused" and the number we hand an integrator to back off by can
 * be tested without a database.
 *
 * `tokens` is what the row holds AFTER this request spent one. Non-negative
 * means the spend was covered; negative means it wasn't, and the shortfall is
 * how long until it would be: the bucket needs to climb from `tokens` back to 1
 * before another whole token can be spent.
 */
export function decisionFromTokens(tokens: number, policy: RateLimitPolicy): RateLimitDecision {
  if (tokens >= 0) return { allowed: true, retryAfterSeconds: 0 };
  // A non-positive refill rate would mean "never" — clamp to a minute rather
  // than emitting Infinity into a header. Config validation should stop this
  // reaching here; this is the belt to that braces.
  if (!(policy.refillPerSecond > 0)) return { allowed: false, retryAfterSeconds: 60 };
  const seconds = (1 - tokens) / policy.refillPerSecond;
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(seconds)) };
}

export interface RateLimiterOptions {
  /**
   * Probability that a served request also runs the prune sweep. Default 1/256:
   * frequent enough that the table can't grow unbounded, rare enough that the
   * sweep is invisible in latency. Random rather than a counter because a
   * counter is per-instance and resets on every cold start, which would make
   * fresh instances sweep on their first request.
   */
  pruneChance?: number;
  /** Injectable for tests. */
  random?: () => number;
}

export function createRateLimiter(pool: Pool, options: RateLimiterOptions = {}): RateLimiter {
  const pruneChance = options.pruneChance ?? 1 / 256;
  const random = options.random ?? Math.random;

  return {
    async take(bucketKey, policy) {
      const { rows } = await pool.query<{ tokens: number | string }>(TAKE_SQL, [
        bucketKey,
        policy.burst,
        policy.refillPerSecond,
      ]);

      const row = rows[0];
      // RETURNING on an upsert always produces exactly one row. If it somehow
      // didn't, throwing is right: the caller fails open, and an API that keeps
      // serving beats an API that 429s everyone because a limiter broke.
      if (!row) throw new Error('rate limiter: upsert returned no row');

      const decision = decisionFromTokens(Number(row.tokens), policy);

      // Only sweep on the served path. Under abuse almost everything is refused,
      // and that is precisely when the database should be doing less, not more.
      if (decision.allowed && random() < pruneChance) {
        try {
          await pool.query(PRUNE_SQL);
        } catch (err) {
          // Housekeeping. A failed sweep is a growing table, not a broken
          // request — never let it turn a 200 into a 500.
          console.error('rate limiter: prune failed:', err);
        }
      }

      return decision;
    },
  };
}
