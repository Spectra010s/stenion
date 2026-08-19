// Tests for the public API's cache TTL policy.
//
// WHY THESE EXIST: the promise this code makes is that caching cannot mask
// `lastRunAt` / `lastRunStatus` — the two fields a consumer uses to decide
// whether to trust our numbers. That promise is a piece of arithmetic over a
// clock, and it is unobservable in every environment we can look at: locally the
// cache does not exist, and on Vercel a failure looks like a correct-shaped JSON
// body that is quietly a few minutes old. Nothing goes red. So the bound gets
// asserted here or it gets asserted nowhere.
//
// The central assertion is `never outlives the earliest plausible next run`
// below. The rest pin the edges it depends on.
//
// Run with: pnpm --filter @stenion/dashboard test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CYCLE_JITTER_SECONDS,
  INDEXER_INTERVAL_SECONDS,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
  NO_STORE,
  cacheTtlSeconds,
  publicCacheControl,
} from './_cache.ts';

const NOW = Date.parse('2026-08-19T12:00:00.000Z');
/** An ISO `lastRunAt` that is `seconds` old relative to NOW. */
const agedBy = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

describe('cacheTtlSeconds', () => {
  it('caches for the ceiling right after a run', () => {
    assert.equal(cacheTtlSeconds([agedBy(2)], NOW), MAX_TTL_SECONDS);
  });

  it('shrinks to the floor as the next run approaches', () => {
    // Deadline is INTERVAL - JITTER after the run; five seconds short of it,
    // there is only the floor left to give.
    const deadline = INDEXER_INTERVAL_SECONDS - CYCLE_JITTER_SECONDS;
    assert.equal(cacheTtlSeconds([agedBy(deadline - 5)], NOW), MIN_TTL_SECONDS);
  });

  it('can never hide a newer run for longer than the floor', () => {
    // THE INVARIANT, and the reason this file exists.
    //
    // A cached body reports `lastRunAt`/`lastRunStatus` for the run it was built
    // from. If a LATER run lands while that body is still being served, the cache
    // is answering a freshness question with an answer that has been overtaken —
    // lying in the one place we promise not to. This bounds how long that can
    // last, for a run of ANY age.
    //
    // Earliest the next run can land: the deadline after the last one, or right
    // now if the indexer is already overdue. Whichever is later.
    const deadlineOffset = INDEXER_INTERVAL_SECONDS - CYCLE_JITTER_SECONDS;
    for (let age = 0; age <= 900; age += 1) {
      const ttl = cacheTtlSeconds([agedBy(age)], NOW);
      const expiresInSeconds = ttl;
      const earliestNextRunInSeconds = Math.max(deadlineOffset - age, 0);
      const maskedFor = expiresInSeconds - earliestNextRunInSeconds;
      assert.ok(
        maskedFor <= MIN_TTL_SECONDS,
        `age=${age}s: a newer run could be masked for ${maskedFor}s, ` +
          `beyond the ${MIN_TTL_SECONDS}s floor`,
      );
    }
  });

  it('stays within the floor and ceiling for any age, including the absurd', () => {
    for (const age of [0, 1, 60, 254, 255, 256, 300, 3600, 86_400 * 30]) {
      const ttl = cacheTtlSeconds([agedBy(age)], NOW);
      assert.ok(ttl >= MIN_TTL_SECONDS && ttl <= MAX_TTL_SECONDS, `age=${age}s gave ttl=${ttl}`);
    }
  });

  it('takes the tightest deadline across a leaderboard', () => {
    // Any protocol's run landing changes the body, so the whole response has to
    // expire on whichever one is due first. Taking the newest instead would
    // cache a stale row for a protocol that has already been re-scored.
    const fresh = agedBy(5);
    const nearlyDue = agedBy(INDEXER_INTERVAL_SECONDS - CYCLE_JITTER_SECONDS - 5);
    assert.equal(cacheTtlSeconds([fresh, nearlyDue], NOW), MIN_TTL_SECONDS);
    assert.equal(cacheTtlSeconds([nearlyDue, fresh], NOW), MIN_TTL_SECONDS);
  });

  it('drops to the floor when a protocol has never run', () => {
    // A never-run protocol has no deadline to compute from, and it is the entry
    // most likely to change next — the first successful run is the thing a
    // watching consumer is waiting for.
    assert.equal(cacheTtlSeconds([null], NOW), MIN_TTL_SECONDS);
    assert.equal(cacheTtlSeconds([agedBy(1), null], NOW), MIN_TTL_SECONDS);
  });

  it('drops to the floor rather than throwing on an unparseable timestamp', () => {
    // Defensive: a bad value must degrade to "cache barely at all", never to a
    // NaN TTL that would land in a header as `s-maxage=NaN`.
    assert.equal(cacheTtlSeconds(['not-a-date'], NOW), MIN_TTL_SECONDS);
  });

  it('treats an empty registry as the floor case', () => {
    assert.equal(cacheTtlSeconds([], NOW), MIN_TTL_SECONDS);
  });

  it('is an overdue indexer that shortens the TTL, not lengthens it', () => {
    // If the last run is older than a whole interval the indexer is late, and the
    // next run could land at any moment — so this is the case that most needs a
    // short TTL, even though it is also the case where the data is least likely
    // to be changing.
    assert.equal(cacheTtlSeconds([agedBy(INDEXER_INTERVAL_SECONDS * 4)], NOW), MIN_TTL_SECONDS);
  });
});

describe('publicCacheControl', () => {
  it('caches in the shared tier only, never in a browser', () => {
    // `max-age=0` is the load-bearing half: a copy in someone's browser is one we
    // cannot expire and cannot see, and it would put a response's real age beyond
    // what the `Age` header reports.
    const header = publicCacheControl(45);
    assert.match(header, /(^|,\s*)max-age=0(,|$)/);
    assert.match(header, /s-maxage=45/);
    assert.match(header, /^public,/);
  });

  it('never offers stale-while-revalidate', () => {
    // SWR serves a body past its deadline. That is the exact behaviour the TTL
    // arithmetic exists to prevent, so it must not creep back in as a "harmless"
    // stampede fix.
    assert.doesNotMatch(publicCacheControl(45), /stale-while-revalidate/);
    assert.doesNotMatch(publicCacheControl(45), /stale-if-error/);
  });
});

describe('NO_STORE', () => {
  it('is uncacheable, for responses that are per-client or wrong to repeat', () => {
    // The CDN cache key is the URL, not the client. A shareable 429 would hand
    // one scraper's refusal to everybody else who asked next.
    assert.equal(NO_STORE, 'no-store');
  });
});
