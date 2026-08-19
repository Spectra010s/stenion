// Tests for the bounded, deadline-governed retry.
//
// WHY THESE EXIST: the entire justification for retrying is that it must not
// push a cycle past Vercel Hobby's 60s `maxDuration`, and the entire
// justification for it being safe is that it must not hide a real failure. Both
// are properties of a schedule that has never run in production against a real
// outage — `risk_scores` has never held a failed row — so they can only be shown
// against a deliberately failing function and a controlled clock.
//
// Most tests drive a FAKE clock: `now` reads a mutable number and the attempt
// function advances it, which models "this attempt took N ms" without waiting.
// The few that exercise the attempt timeout use the real clock with tiny values,
// because that path genuinely depends on setTimeout.
//
// Run with: pnpm --filter @stenion/indexer test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AttemptTimeoutError,
  DeadlineExceededError,
  withRetry,
  type RetryDeps,
  type RetryPolicy,
} from './retry.ts';

/** A policy with everything explicit; individual tests override what they mean to test. */
function policy(over: Partial<RetryPolicy> = {}): RetryPolicy {
  return { attempts: 3, baseDelayMs: 1000, attemptTimeoutMs: 15_000, minAttemptMs: 1000, ...over };
}

/**
 * A fake clock. `sleep` advances it, and the attempt function is expected to
 * advance it too, so elapsed time is entirely under the test's control.
 */
function fakeClock(startAt = 0) {
  let t = startAt;
  const slept: number[] = [];
  const deps: RetryDeps = {
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
  };
  return { deps, slept, advance: (ms: number) => void (t += ms), at: () => t };
}

describe('withRetry — the happy path costs nothing', () => {
  it('calls the function once and reports one attempt', async () => {
    const { deps } = fakeClock();
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        return 'scored';
      },
      policy(),
      Number.POSITIVE_INFINITY,
      deps,
    );

    assert.equal(out.value, 'scored');
    assert.equal(out.attempts, 1);
    assert.equal(calls, 1);
  });

  it('does not sleep before the first attempt', async () => {
    const { deps, slept } = fakeClock();
    await withRetry(async () => 1, policy(), Number.POSITIVE_INFINITY, deps);
    assert.deepEqual(slept, []);
  });
});

describe('withRetry — backoff schedule', () => {
  it('doubles the delay between attempts', async () => {
    const { deps, slept } = fakeClock();
    let calls = 0;
    await withRetry(
      async () => {
        calls++;
        if (calls < 4) throw new Error('rpc blip');
        return 'ok';
      },
      policy({ attempts: 4 }),
      Number.POSITIVE_INFINITY,
      deps,
    );

    assert.equal(calls, 4);
    assert.deepEqual(slept, [1000, 2000, 4000], 'base, then ×2 each time');
  });

  it('retries a transient failure and reports the attempt it succeeded on', async () => {
    const { deps } = fakeClock();
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw new Error('Soroban RPC unreachable');
        return 61;
      },
      policy(),
      Number.POSITIVE_INFINITY,
      deps,
    );

    assert.equal(out.value, 61);
    assert.equal(out.attempts, 2);
  });

  it('makes exactly one attempt when attempts = 1, and never sleeps', async () => {
    // The clean off-switch: STENION_RETRY_ATTEMPTS=1 restores the old behaviour.
    const { deps, slept } = fakeClock();
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new Error('down');
        },
        policy({ attempts: 1 }),
        Number.POSITIVE_INFINITY,
        deps,
      ),
      /down/,
    );

    assert.equal(calls, 1);
    assert.deepEqual(slept, []);
  });
});

describe('withRetry — retries never hide a real failure', () => {
  it('rejects with the LAST error after exhausting every attempt', async () => {
    // This is the invariant that lets retry exist at all: a protocol that is
    // genuinely down must still surface as down, carrying its own diagnostic.
    const { deps } = fakeClock();
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new Error(`attempt ${calls} failed`);
        },
        policy({ attempts: 3 }),
        Number.POSITIVE_INFINITY,
        deps,
      ),
      /attempt 3 failed/,
    );
    assert.equal(calls, 3);
  });

  it('propagates a thrown non-Error unchanged, so the caller can stringify it', async () => {
    const { deps } = fakeClock();
    await assert.rejects(
      withRetry(
        async () => {
          throw 'boom';
        },
        policy({ attempts: 2 }),
        Number.POSITIVE_INFINITY,
        deps,
      ),
      (err: unknown) => err === 'boom',
    );
  });
});

describe('withRetry — the deadline is the guarantee, the attempt count is the ceiling', () => {
  it('stops retrying when the remaining budget cannot cover backoff + an attempt', async () => {
    // Blend's share of a 42s budget across two protocols is 21s. Each attempt
    // here burns 15s (the attempt cap), so: attempt 1 → 6s left → 1s backoff
    // leaves 5s, enough → attempt 2 (burns the remaining 5s) → 0s left, so the
    // third attempt the policy allows is never started.
    const clock = fakeClock();
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          clock.advance(calls === 1 ? 15_000 : 5_000);
          throw new Error('rpc timeout');
        },
        policy({ attempts: 3 }),
        21_000,
        clock.deps,
      ),
      /rpc timeout/,
    );

    assert.equal(calls, 2, 'the 3rd attempt the policy allows had no budget to run in');
    assert.deepEqual(clock.slept, [1000]);
    assert.ok(clock.at() <= 21_000, `never ran past the deadline (ended at ${clock.at()}ms)`);
  });

  it('never sleeps past the deadline', async () => {
    // A 3s deadline with a 1s backoff and a 1s minimum attempt: after a 2.5s
    // attempt there is 0.5s left, which cannot cover both, so it stops rather
    // than burning the backoff on an attempt that could only time out.
    const clock = fakeClock();
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          clock.advance(2500);
          throw new Error('slow failure');
        },
        policy({ attempts: 3, baseDelayMs: 1000, minAttemptMs: 1000 }),
        3000,
        clock.deps,
      ),
      /slow failure/,
    );

    assert.equal(calls, 1);
    assert.deepEqual(clock.slept, [], 'the backoff itself would have overrun the deadline');
  });

  it('throws DeadlineExceededError when there was never any time to try', async () => {
    // The zero-budget case has no adapter error to report, so it reports the
    // truth: we learned nothing about this protocol. It still becomes a `failed`
    // row rather than silently nothing.
    const { deps } = fakeClock(5000);
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          return 1;
        },
        policy(),
        4000,
        deps,
      ),
      DeadlineExceededError,
    );
    assert.equal(calls, 0, 'no attempt is started once the budget is spent');
  });

  it('gives an unbounded deadline the full attempt count', async () => {
    const { deps } = fakeClock();
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new Error('nope');
        },
        policy({ attempts: 3 }),
        Number.POSITIVE_INFINITY,
        deps,
      ),
      /nope/,
    );
    assert.equal(calls, 3);
  });
});

describe('withRetry — the attempt timeout (real clock, tiny values)', () => {
  it('abandons an attempt that outlives its cap and says so', async () => {
    await assert.rejects(
      withRetry(
        () => new Promise(() => {}), // never settles, like a hung socket
        policy({ attempts: 1, attemptTimeoutMs: 20 }),
        Number.POSITIVE_INFINITY,
      ),
      (err: unknown) => {
        assert.ok(err instanceof AttemptTimeoutError);
        assert.match(err.message, /exceeded its 20ms time budget/);
        return true;
      },
    );
  });

  it('caps an attempt at the remaining budget when that is tighter than the timeout', async () => {
    // Deliberate: better a clean failed record than a function killed mid-flight.
    const startedAt = Date.now();
    await assert.rejects(
      withRetry(
        () => new Promise(() => {}),
        policy({ attempts: 1, attemptTimeoutMs: 10_000 }),
        startedAt + 30,
      ),
      AttemptTimeoutError,
    );
    assert.ok(Date.now() - startedAt < 1000, 'the deadline, not the 10s timeout, ended it');
  });

  it('retries after a timeout, and still succeeds if a later attempt is quick', async () => {
    let calls = 0;
    const out = await withRetry(
      () => {
        calls++;
        return calls === 1 ? new Promise<number>(() => {}) : Promise.resolve(77);
      },
      policy({ attempts: 2, baseDelayMs: 1, attemptTimeoutMs: 20 }),
      Number.POSITIVE_INFINITY,
    );

    assert.equal(out.value, 77);
    assert.equal(out.attempts, 2);
  });

  it('does not let an abandoned attempt surface as an unhandled rejection', async () => {
    // The loser of the race is abandoned, not cancelled. Without the no-op catch
    // in runWithTimeout, this late rejection would take the process down under
    // Node's default unhandled-rejection behaviour.
    const seen: unknown[] = [];
    const onUnhandled = (err: unknown) => seen.push(err);
    process.on('unhandledRejection', onUnhandled);
    try {
      await assert.rejects(
        withRetry(
          () => new Promise((_, reject) => setTimeout(() => reject(new Error('late boom')), 30)),
          policy({ attempts: 1, attemptTimeoutMs: 5 }),
          Number.POSITIVE_INFINITY,
        ),
        AttemptTimeoutError,
      );
      // Let the abandoned promise reject well after the race was decided.
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.deepEqual(seen, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
