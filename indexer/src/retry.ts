// Bounded retry with backoff, governed by a wall-clock deadline.
//
// WHY A DEADLINE RATHER THAN A SCHEDULE. The cron route runs under Vercel's
// Hobby-tier `maxDuration = 60`, which cannot be raised, and a cycle killed
// mid-flight is worse than one that fails cleanly — it can leave one protocol
// scored and the other neither scored nor recorded as failed. A fixed schedule
// ("3 attempts, 1s then 2s") only stays inside 60s if you know how long an
// attempt takes, and nothing here does: every RPC call in both adapters is a
// bare `await` with no AbortSignal, and Node's fetch has no default timeout. So
// the arithmetic would be over an undefined term.
//
// Instead the caller passes an absolute `deadlineAt`, and this module simply
// never runs past it: each attempt is capped at whatever time is actually left,
// and a retry is only started if the remaining budget can still cover the
// backoff plus an attempt worth making. The attempt count and delays are the
// *ceiling*; the deadline is the guarantee.
//
// Everything is a pure function of its arguments — the clock and sleep are
// injectable, so the tests prove the schedule without waiting on it.

/** Tunables for one retried operation. All come from validated env; see config.ts. */
export interface RetryPolicy {
  /** Total attempts INCLUDING the first. 1 disables retry entirely. */
  attempts: number;
  /** Delay before the 2nd attempt; doubles for each subsequent one. */
  baseDelayMs: number;
  /**
   * Soft cap on a single attempt.
   *
   * SOFT, deliberately: this races the attempt against a timer, which abandons
   * the in-flight work rather than cancelling it — the underlying socket keeps
   * running. True cancellation needs an AbortSignal threaded through
   * `Adapter.fetchRawData`, which is an interface change across core and every
   * adapter (filed in ROADMAP.md, not done here). Abandoning is harmless under
   * serverless, where the socket dies with the invocation; it would be a real
   * leak in a long-lived process, which is the other half of that roadmap note.
   *
   * The cap still bounds the *observed* attempt duration, which is all the
   * deadline arithmetic needs.
   */
  attemptTimeoutMs: number;
  /**
   * Below this much remaining time, a retry isn't worth starting: it would be
   * capped so short it could only time out, having first burned the backoff.
   * Stopping early leaves the budget to the next protocol instead.
   */
  minAttemptMs?: number;
}

/** Injectable clock/sleep so tests can prove the schedule without waiting on it. */
export interface RetryDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MIN_ATTEMPT_MS = 1000;

/**
 * Thrown when an attempt outlives its cap. A distinct type (and a specific
 * message) because this is the one failure the adapters can't describe
 * themselves — it lands verbatim in `risk_scores.error`, where "timed out after
 * 15000ms" is diagnostic and a generic message is not.
 */
export class AttemptTimeoutError extends Error {
  // Written out rather than a `constructor(readonly timeoutMs)` parameter
  // property: this module is imported by a test, and Node's strip-only type
  // stripping rejects parameter properties as unstrippable syntax.
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`attempt exceeded its ${timeoutMs}ms time budget`);
    this.name = 'AttemptTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** Thrown when the deadline is already spent before an attempt could be made. */
export class DeadlineExceededError extends Error {
  constructor() {
    super('no time left in the cycle budget for this protocol');
    this.name = 'DeadlineExceededError';
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` with a timeout, resolving to its value or rejecting with
 * AttemptTimeoutError. The loser of the race is abandoned, not cancelled — see
 * RetryPolicy.attemptTimeoutMs. The no-op catch is load-bearing: without it an
 * abandoned attempt that rejects later surfaces as an unhandled rejection and,
 * under Node's default, would take the process down.
 */
async function runWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = fn();
  attempt.catch(() => {});

  // An unbounded cap means "don't time out" — run the attempt directly rather
  // than handing setTimeout a non-finite delay, which it silently clamps to 1ms.
  if (!Number.isFinite(timeoutMs)) return attempt;

  try {
    return await Promise.race([
      attempt,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AttemptTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** What a retried operation did, for logging and for the cycle summary. */
export interface RetryOutcome<T> {
  value: T;
  /** How many attempts were actually made (1 = succeeded first time). */
  attempts: number;
}

/**
 * Attempt `fn` up to `policy.attempts` times, backing off between attempts and
 * never running past `deadlineAt` (absolute epoch ms).
 *
 * Resolves with the first success. If every attempt made fails, **rejects with
 * the last error** — retries reduce false failures, they must never hide real
 * ones, so exhausting the budget produces exactly the failure the caller would
 * have seen without any retry at all, and the caller records it as `failed`.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  deadlineAt: number,
  deps: RetryDeps = {},
): Promise<RetryOutcome<T>> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const minAttemptMs = policy.minAttemptMs ?? DEFAULT_MIN_ATTEMPT_MS;

  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    const remaining = deadlineAt - now();
    if (remaining <= 0) {
      // Out of time before we could even try. On the first attempt there is no
      // adapter error to report, so this becomes the recorded failure — which is
      // correct and honest: we did not learn anything about the protocol.
      throw lastError ?? new DeadlineExceededError();
    }

    try {
      const value = await runWithTimeout(fn, Math.min(policy.attemptTimeoutMs, remaining));
      return { value, attempts: attempt };
    } catch (err) {
      lastError = err;
    }

    if (attempt === policy.attempts) break;

    // Only back off and retry if the budget can still cover the wait AND an
    // attempt long enough to be worth making.
    const delay = policy.baseDelayMs * 2 ** (attempt - 1);
    if (deadlineAt - now() <= delay + minAttemptMs) break;
    await sleep(delay);
  }

  throw lastError;
}
