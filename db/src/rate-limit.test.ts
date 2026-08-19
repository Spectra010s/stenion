// Tests for the rate limiter's arithmetic.
//
// WHY THESE EXIST: the limiter is the one part of the public API that decides to
// REFUSE a request, and it does so on a number that no test fixture and no live
// traffic will ever show us at the boundary. Production will run this at
// tokens = 59.9997 and tokens = -0.0001; the interesting cases are exactly the
// ones a real request never conveniently lands on.
//
// The refill itself is Postgres arithmetic (see TAKE_SQL) and is not testable
// without a database — which is the point of the split: the SQL decides the
// balance, and this decides what a balance MEANS, including the number an
// integrator is told to back off by. Getting that wrong is either a client that
// retries in a hot loop (Retry-After: 0) or one that sleeps a minute for a
// one-second problem.
//
// Run with: pnpm --filter @stenion/db test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decisionFromTokens, type RateLimitPolicy } from './rate-limit.ts';

/** The shipped default: 60 requests/minute sustained, 60 of burst. */
const POLICY: RateLimitPolicy = { burst: 60, refillPerSecond: 1 };

describe('decisionFromTokens', () => {
  it('allows while the balance covered the spend', () => {
    for (const tokens of [59, 12.5, 1, 0.25]) {
      assert.equal(decisionFromTokens(tokens, POLICY).allowed, true, `tokens=${tokens}`);
    }
  });

  it('treats an exactly-drained bucket as served, not refused', () => {
    // tokens === 0 means the request took the last whole token and got it. An
    // off-by-one here refuses the 60th request of a 60-burst allowance, i.e.
    // the documented limit would be a lie by one on every single client.
    const decision = decisionFromTokens(0, POLICY);
    assert.equal(decision.allowed, true);
    assert.equal(decision.retryAfterSeconds, 0);
  });

  it('refuses once the balance went negative', () => {
    assert.equal(decisionFromTokens(-0.001, POLICY).allowed, false);
    assert.equal(decisionFromTokens(-1, POLICY).allowed, false);
  });

  it('never advertises Retry-After: 0 on a refusal', () => {
    // A refused client told to retry after zero seconds retries immediately, is
    // refused again, and has been handed a hot loop by the header that exists to
    // prevent one. Every refusal must name a wait a client can actually honour.
    for (const tokens of [-0.0001, -0.5, -1]) {
      const decision = decisionFromTokens(tokens, POLICY);
      assert.equal(decision.allowed, false);
      assert.ok(decision.retryAfterSeconds >= 1, `tokens=${tokens}`);
    }
  });

  it('scales the wait to the refill rate, not to a constant', () => {
    // The bucket must climb from `tokens` back to 1 before a whole token is
    // spendable, so the wait is (1 - tokens) / rate, rounded up to whole seconds.
    // At one token per second and a full token of debt that is 2s.
    assert.equal(decisionFromTokens(-1, POLICY).retryAfterSeconds, 2);
    // Ten times slower refill, ten times the wait.
    assert.equal(decisionFromTokens(-1, { burst: 60, refillPerSecond: 0.1 }).retryAfterSeconds, 20);
    // Ten times faster refill still can't go below the one-second floor.
    assert.equal(decisionFromTokens(-1, { burst: 60, refillPerSecond: 10 }).retryAfterSeconds, 1);
  });

  it('rounds the wait up, so honouring it always succeeds', () => {
    // 1.5s rounded DOWN to 1 would send a well-behaved client back half a second
    // early, get it refused a second time, and make the header look unreliable.
    assert.equal(decisionFromTokens(-0.5, POLICY).retryAfterSeconds, 2);
  });

  it('emits a finite wait even if the policy says the bucket never refills', () => {
    // Guards a misconfigured STENION_RATE_LIMIT_PER_MIN=0 turning into
    // `Retry-After: Infinity`, which is an unparseable header, not a long wait.
    const decision = decisionFromTokens(-1, { burst: 60, refillPerSecond: 0 });
    assert.equal(decision.allowed, false);
    assert.ok(Number.isFinite(decision.retryAfterSeconds));
    assert.equal(decision.retryAfterSeconds, 60);
  });
});
