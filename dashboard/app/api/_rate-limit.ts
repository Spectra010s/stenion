// Rate-limit POLICY for the public API: who a client is, what they're allowed,
// and what a refusal looks like on the wire.
//
// Like ./_http and ./_cache this is a leaf — it imports only `node:crypto` — so
// it is testable from a plain Node test. The half that touches Postgres lives in
// @stenion/db (`createRateLimiter`) and is wired up in ./_shared.
//
// ---------------------------------------------------------------------------
// WHERE THE LIMIT IS ENFORCED, AND WHAT THAT MEANS
//
// Inside the serverless function — which the CDN only invokes on a cache MISS.
// So the limiter counts requests that actually cost a database query, not
// requests in general. That is the right unit: the thing being protected is
// Neon's free tier, and a cache hit costs it nothing. It also means the
// documented limit is not a cap on how many requests a client may make; a client
// polling a cached endpoint can exceed it all day and never be refused, because
// the function never sees them.
//
// The counter itself is a row in Postgres, not memory, because there is no
// shared memory here: each invocation is its own process and Vercel runs as many
// as traffic demands. See db/src/rate-limit.ts for the full honesty pass on what
// that does and doesn't guarantee.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

/**
 * Requests per minute per client, sustained.
 *
 * 60/min = 1/second. Sized against what it is counting: cache MISSES. A wallet
 * polling every 5 seconds generates roughly one miss per TTL (~1–6 per minute)
 * because everything in between is served by the CDN, so 60 is an order of
 * magnitude above any legitimate integrator — including one refreshing several
 * protocol pages at once. What it does bite is the case it is for: a client
 * defeating the cache with a varying query string, where every request is a miss
 * and a database query. That client is capped at ~1 query/second instead of
 * unbounded.
 */
export const DEFAULT_PER_MINUTE = 60;

/**
 * Burst allowance: how many requests a client may make back-to-back before the
 * sustained rate starts to bind.
 *
 * Equal to the per-minute rate, i.e. a full minute's worth up front. Bursty is
 * what honest clients look like — an integrator opening several protocol pages,
 * a backfill on first deploy, a developer poking the API by hand — and refusing
 * that while allowing the same volume spread evenly would block real work to no
 * benefit. The bucket empties in one burst either way.
 */
export const DEFAULT_BURST = 60;

export interface RateLimitSettings {
  enabled: boolean;
  /** Sustained requests per minute per client. */
  perMinute: number;
  /** Bucket capacity. */
  burst: number;
  /** Salt for the client-key hash; may be empty (see `bucketKey`). */
  salt: string;
}

export const DEFAULT_RATE_LIMIT_SETTINGS: RateLimitSettings = {
  enabled: true,
  perMinute: DEFAULT_PER_MINUTE,
  burst: DEFAULT_BURST,
  salt: '',
};

/** A finite positive number from an env string, or undefined if it isn't one. */
function positiveNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Read the limiter's configuration from the environment.
 *
 * Every knob has a default and a malformed value falls back to it rather than
 * throwing. A typo in `STENION_RATE_LIMIT_PER_MIN` must not take the public API
 * down — the limiter is a guard rail, and a guard rail that can crash the thing
 * it guards is a liability. `STENION_RATE_LIMIT_DISABLED` is the deliberate off
 * switch, and only the exact string `true` flips it, so a stray value can't
 * silently disable protection either.
 */
export function readRateLimitSettings(
  env: Record<string, string | undefined> = process.env,
): RateLimitSettings {
  return {
    enabled: env.STENION_RATE_LIMIT_DISABLED?.trim().toLowerCase() !== 'true',
    perMinute: positiveNumber(env.STENION_RATE_LIMIT_PER_MIN) ?? DEFAULT_PER_MINUTE,
    burst: positiveNumber(env.STENION_RATE_LIMIT_BURST) ?? DEFAULT_BURST,
    salt: env.STENION_RATE_LIMIT_SALT?.trim() ?? '',
  };
}

/**
 * The client's IP, as reported by the platform proxy, or null if we can't tell.
 *
 * `x-real-ip` first: on Vercel it is set by the platform and is single-valued,
 * so it has no "which hop do I trust" problem. `x-forwarded-for`'s first entry is
 * the fallback.
 *
 * THE TRUST ASSUMPTION, stated plainly: this believes the proxy in front of the
 * app. That holds on Vercel, which overwrites both headers with the connecting
 * IP. It would NOT hold behind a proxy that passes a client-supplied
 * `x-forwarded-for` through, where a client could split itself across unlimited
 * buckets and evade the limiter entirely. Nothing here can detect that — it is a
 * property of the deployment, not of this function.
 */
export function clientIp(headers: Headers): string | null {
  const real = headers.get('x-real-ip')?.trim();
  if (real) return real;
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return null;
}

/**
 * The bucket identity we store, derived from the client IP.
 *
 * HASHED, NOT STORED RAW. The limiter only ever needs to know that two requests
 * came from the same place; it never needs to know where that is. Hashing means
 * the rate-limit table is not a log of who read the public API, so it cannot
 * become one by accident later. `STENION_RATE_LIMIT_SALT` is what stops the hash
 * being reversible by enumerating the IPv4 space — set it in production; unset,
 * the pseudonymity is nominal rather than real.
 *
 * Truncated to 32 hex characters: still 128 bits, far past any collision concern
 * at this scale, and it keeps the primary key small.
 *
 * A null IP means the platform told us nothing, and every such request shares one
 * bucket. That is the safe direction (unidentifiable traffic is limited
 * collectively, not exempted) and it is mostly a local-development state — behind
 * `next dev` there are no proxy headers at all.
 */
export function bucketKey(ip: string | null, salt: string): string {
  const identity = ip ?? 'unknown';
  const digest = createHash('sha256').update(`${salt}:${identity}`).digest('hex').slice(0, 32);
  return `ip:${digest}`;
}

/** The 429 body. Shares the `{ error }` shape the 404 and 500 responses use. */
export function rateLimitedBody(retryAfterSeconds: number): { error: string; retryAfter: number } {
  return {
    error:
      'Too many requests. This endpoint is rate limited per client; retry after the wait in the Retry-After header.',
    retryAfter: retryAfterSeconds,
  };
}

/**
 * Headers for a 429, so an integrator can back off deliberately rather than
 * guess.
 *
 * - `retry-after` — seconds, the one every HTTP client already understands.
 * - `x-ratelimit-limit` — the sustained per-minute allowance.
 * - `x-ratelimit-remaining` — always 0 here; this header only ships on refusals.
 * - `x-ratelimit-reset` — UNIX EPOCH SECONDS, the GitHub convention. Stated
 *   because the header is not standardised and the other common reading is a
 *   delta; `retry-after` carries the delta unambiguously, so the two together
 *   are readable under either assumption.
 * - `cache-control: no-store` — load-bearing. The CDN keys on URL, not client,
 *   so a cacheable 429 would be handed to every client that asked next.
 *
 * WHY THESE ARE NOT ON SUCCESSFUL RESPONSES. A 200 from these routes is cached
 * in a shared CDN and served to many clients. An `x-ratelimit-remaining` baked
 * into it would be one client's balance, frozen, replayed to everybody else — a
 * number that is wrong for every reader including the one it came from. A header
 * that is confidently wrong is worse than an absent one, so a client learns its
 * standing the one time it matters: when it is refused.
 */
export function rateLimitHeaders(
  settings: RateLimitSettings,
  retryAfterSeconds: number,
  nowMs: number = Date.now(),
): Record<string, string> {
  return {
    'retry-after': String(retryAfterSeconds),
    'x-ratelimit-limit': String(settings.perMinute),
    'x-ratelimit-remaining': '0',
    'x-ratelimit-reset': String(Math.ceil(nowMs / 1000) + retryAfterSeconds),
    'cache-control': 'no-store',
  };
}

/**
 * A per-instance memo of clients we have already refused.
 *
 * The point is NOT to enforce the limit — it cannot, it is per-instance, which is
 * the whole reason the real counter lives in Postgres. The point is that a client
 * flooding one instance should not cost one database write per request while
 * being told no. This cache may only ever REFUSE FASTER, never allow: an entry
 * that is missing, expired, or lost to a cold start just means the request goes
 * to Postgres and gets the authoritative answer. Skewing strictly toward the safe
 * direction is what makes a per-instance structure sound here when it would not
 * be for the counter itself.
 */
export interface DenyCache {
  /** Seconds still to wait, or null if this client is not known to be refused. */
  blockedFor(key: string, nowMs: number): number | null;
  block(key: string, retryAfterSeconds: number, nowMs: number): void;
  readonly size: number;
}

/**
 * @param maxEntries hard cap, so a flood from many distinct clients cannot turn
 * the memo into a memory leak. On overflow the whole map is dropped rather than
 * evicted one by one: forgetting costs an extra database round trip, and an LRU
 * is machinery to save something we can afford to lose.
 */
export function createDenyCache(maxEntries = 5_000): DenyCache {
  const blockedUntil = new Map<string, number>();

  return {
    blockedFor(key, nowMs) {
      const until = blockedUntil.get(key);
      if (until === undefined) return null;
      if (until <= nowMs) {
        blockedUntil.delete(key);
        return null;
      }
      // Round up so we never advertise a wait shorter than the real one.
      return Math.max(1, Math.ceil((until - nowMs) / 1000));
    },

    block(key, retryAfterSeconds, nowMs) {
      if (blockedUntil.size >= maxEntries && !blockedUntil.has(key)) blockedUntil.clear();
      blockedUntil.set(key, nowMs + retryAfterSeconds * 1000);
    },

    get size() {
      return blockedUntil.size;
    },
  };
}
