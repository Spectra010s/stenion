// Tests for the indexer's run loop, and specifically its error model.
//
// WHY THESE EXIST: the contract is that adapters throw and the indexer catches,
// records a failed run, and carries on — one protocol failing must never abort
// the cycle or lose another protocol's score. As of 2026-08-16 the production
// `risk_scores` table holds 1,683 rows and **zero** failed ones, so this entire
// path has never executed against real data. "It works in production" is not
// evidence here; a deliberately throwing adapter is.
//
// Everything is in-memory: a fake Store records what it was asked to write, and
// fake adapters decide whether to throw. No pg, no RPC, no env.
//
// Run with: pnpm --filter @stenion/indexer test

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { runCycle, toTarget, type CycleOptions, type IndexTarget } from './cycle.ts';
import type { StreakAlert } from './alerts.ts';
import type { Adapter, ProtocolMetadata, RiskFactorMap, RiskScoreResult } from '@stenion/core';
import type { RecentRun, RunRecord, Store } from '@stenion/db';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * A Store that keeps writes in an array, and can be told to fail them.
 *
 * `history` seeds pre-existing runs per protocol (newest first) so a failure
 * streak can be set up deliberately — the only way to test that path, since
 * `risk_scores` has never held a failed row and was truncated on 2026-08-19.
 * Newly-written records are prepended, so `listRecentRuns` sees the run this
 * cycle just recorded exactly as the real Store would.
 */
function fakeStore(
  opts: { failWrites?: boolean; failReads?: boolean; history?: Record<string, RecentRun[]> } = {},
) {
  const written: RunRecord[] = [];
  const history: Record<string, RecentRun[]> = structuredClone(opts.history ?? {});

  const store: Store = {
    async upsertProtocol() {},
    async insertRunRecord(record) {
      if (opts.failWrites) throw new Error('connection terminated unexpectedly');
      written.push(record);
      (history[record.protocolId] ??= []).unshift({
        status: record.status,
        error: record.status === 'failed' ? record.error : null,
        runAt: record.runAt,
      });
    },
    async listProtocolsWithLatestScore() {
      return [];
    },
    async getProtocolDetail() {
      return null;
    },
    // Health reads nothing this fake models — the cycle never calls it. Present
    // only to satisfy the Store interface.
    async listRunHealth() {
      return [];
    },
    async listRecentRuns(protocolId, limit) {
      if (opts.failReads) throw new Error('connection terminated unexpectedly');
      return (history[protocolId] ?? []).slice(0, limit);
    },
  };
  return { store, written, history };
}

/** A run of consecutive failures, newest first, on the 5-minute cadence. */
function failedRuns(n: number, error = 'Soroban RPC unreachable'): RecentRun[] {
  return Array.from({ length: n }, (_, i) => ({
    status: 'failed' as const,
    error,
    runAt: new Date(Date.parse('2026-08-19T12:00:00.000Z') - (i + 1) * 5 * 60_000).toISOString(),
  }));
}

/** Capture alerts instead of POSTing them. */
function fakeNotifier() {
  const batches: StreakAlert[][] = [];
  const notifier = async (alerts: StreakAlert[]) => void batches.push(alerts);
  return { notifier, batches, all: () => batches.flat() };
}

/** Alerting on, retry off — so streak tests aren't also testing the backoff. */
function alerting(over: Partial<CycleOptions> = {}): CycleOptions {
  return { alertThreshold: 4, ...over };
}

const FACTORS = {
  collateralSafety: { value: 70, weight: 0.2, detail: 'x' },
  oracleSafety: { value: 100, weight: 0.25, detail: 'x' },
  adminKeySafety: { value: 40, weight: 0.2, detail: 'x' },
  liquiditySafety: { value: 22, weight: 0.15, detail: 'x' },
  utilizationSafety: { value: 14, weight: 0.2, detail: 'x' },
} as unknown as RiskFactorMap;

const COMPUTED_AT = new Date('2026-08-16T10:00:00.000Z');

/** A target that succeeds with a fixed score. */
function okTarget(id: string, safetyScore = 53): IndexTarget {
  return {
    metadata: { id, name: id, chain: 'stellar', adapterRef: 'FakeAdapter' },
    run: async () => ({ safetyScore, factors: FACTORS, computedAt: COMPUTED_AT }),
  };
}

/** A target whose adapter throws, the way a real one does on RPC failure. */
function throwingTarget(id: string, thrown: unknown = new Error('Soroban RPC unreachable')) {
  return {
    metadata: { id, name: id, chain: 'stellar' as const, adapterRef: 'FakeAdapter' },
    run: async () => {
      throw thrown;
    },
  };
}

// Silence the loop's console output; it logs every run by design.
let logs: string[] = [];
beforeEach(() => {
  logs = [];
  console.log = (...a: unknown[]) => void logs.push(a.join(' '));
  console.error = (...a: unknown[]) => void logs.push(a.join(' '));
});

// ---------------------------------------------------------------------------

describe('runCycle — a throwing adapter records a failed run', () => {
  it('writes a failed record instead of propagating the error', async () => {
    const { store, written } = fakeStore();
    const summary = await runCycle([throwingTarget('blend')], store);

    assert.equal(written.length, 1);
    const record = written[0];
    assert.equal(record.status, 'failed');
    assert.equal(record.protocolId, 'blend');
    assert.equal(summary.failed, 1);
  });

  it("carries the adapter's own error message, not a generic one", async () => {
    // The message is the only diagnostic that survives into the database, so it
    // must be the adapter's, verbatim.
    const { store, written } = fakeStore();
    await runCycle([throwingTarget('blend', new Error('no ResConfig for asset CXYZ'))], store);

    const record = written[0];
    assert.equal(record.status, 'failed');
    assert.equal(record.error, 'no ResConfig for asset CXYZ');
  });

  it('survives a thrown non-Error without producing "[object Object]"', async () => {
    // Nothing guarantees a throw is an Error — a rejected fetch or a bare
    // `throw 'boom'` both reach here, and the record must still be readable.
    for (const [thrown, expected] of [
      ['boom', 'boom'],
      [404, '404'],
      [{ code: 'ETIMEDOUT' }, '[object Object]'],
    ] as const) {
      const { store, written } = fakeStore();
      await runCycle([throwingTarget('blend', thrown)], store);
      const record = written[0];
      assert.equal(record.status, 'failed');
      assert.equal(record.error, expected);
      assert.ok(typeof record.error === 'string' && record.error.length > 0);
    }
  });

  it('records a failed run with no score, so nothing fabricates a number', async () => {
    const { store, written } = fakeStore();
    await runCycle([throwingTarget('blend')], store);

    const record = written[0] as Record<string, unknown>;
    assert.equal(record.status, 'failed');
    // The persisted union's failed arm carries no score, factors, or
    // methodologyVersion — the DB CHECK enforces the same split.
    assert.equal(record.safetyScore, undefined);
    assert.equal(record.factors, undefined);
    assert.equal(record.methodologyVersion, undefined);
    assert.equal(record.computedAt, undefined);
    assert.ok(typeof record.runAt === 'string', 'a failed run still has a runAt');
  });
});

describe('runCycle — one failure never affects another protocol', () => {
  it('keeps scoring the remaining targets after one throws', async () => {
    const { store, written } = fakeStore();
    const summary = await runCycle(
      [okTarget('alpha', 61), throwingTarget('beta'), okTarget('gamma', 47)],
      store,
    );

    assert.equal(summary.ran, 3);
    assert.equal(summary.ok, 2);
    assert.equal(summary.failed, 1);
    assert.deepEqual(
      written.map((r) => [r.protocolId, r.status]),
      [
        ['alpha', 'ok'],
        ['beta', 'failed'],
        ['gamma', 'ok'],
      ],
    );
  });

  it('still scores later targets when the FIRST one throws', async () => {
    // Ordering matters: an early failure aborting the loop would silently stop
    // every target behind it — and with three registered, losing the first one
    // costs two thirds of the registry.
    const { store, written } = fakeStore();
    const summary = await runCycle([throwingTarget('blend'), okTarget('kinetic', 24)], store);

    assert.equal(summary.ok, 1);
    const kinetic = written.find((r) => r.protocolId === 'kinetic');
    assert.ok(kinetic && kinetic.status === 'ok');
    assert.equal(kinetic.safetyScore, 24);
  });

  it('handles every target failing without throwing', async () => {
    const { store, written } = fakeStore();
    const summary = await runCycle([throwingTarget('a'), throwingTarget('b')], store);

    assert.deepEqual(
      { ran: summary.ran, ok: summary.ok, failed: summary.failed },
      {
        ran: 2,
        ok: 0,
        failed: 2,
      },
    );
    assert.equal(written.length, 2);
  });

  it('returns an empty summary for no targets', async () => {
    const { store } = fakeStore();
    const summary = await runCycle([], store);
    assert.deepEqual(summary, { ran: 0, ok: 0, failed: 0, results: [] });
  });
});

describe('runCycle — a database failure does not abort the cycle', () => {
  it('keeps running when every write fails', async () => {
    // The write is caught separately from the adapter run, so an unreachable
    // database degrades to "nothing recorded" rather than "the cycle died".
    const { store } = fakeStore({ failWrites: true });
    const summary = await runCycle([okTarget('alpha'), okTarget('beta')], store);

    assert.equal(summary.ran, 2);
    assert.equal(summary.ok, 2, 'the runs still succeeded — only persistence failed');
    assert.ok(
      logs.some((l) => l.includes('DB write failed')),
      'a failed write must be logged, not swallowed silently',
    );
  });

  it('reports a run as ok even if its record could not be stored', async () => {
    // Deliberate: the summary describes what the cycle *did*, and the cron route
    // reports it. Conflating a storage failure with a scoring failure would
    // misattribute an infrastructure problem to the protocol.
    const { store } = fakeStore({ failWrites: true });
    const summary = await runCycle([okTarget('alpha', 61)], store);
    assert.deepEqual(summary.results, [
      { id: 'alpha', status: 'ok', safetyScore: 61, attempts: 1 },
    ]);
  });
});

describe('runCycle — the ok record', () => {
  it('stamps the methodology version from core, not from the adapter', async () => {
    // One rulebook applies to every protocol, so the version is a property of
    // the run. An adapter has no say in it — that is what keeps stored history
    // interpretable.
    const { METHODOLOGY_VERSION } = await import('@stenion/core');
    const { store, written } = fakeStore();
    await runCycle([okTarget('blend')], store);

    const record = written[0];
    assert.equal(record.status, 'ok');
    assert.equal(record.methodologyVersion, METHODOLOGY_VERSION);
  });

  it('persists the score, factors and both timestamps as ISO strings', async () => {
    const { store, written } = fakeStore();
    await runCycle([okTarget('blend', 53)], store);

    const record = written[0];
    assert.equal(record.status, 'ok');
    assert.equal(record.safetyScore, 53);
    assert.equal(record.factors, FACTORS);
    assert.equal(record.computedAt, COMPUTED_AT.toISOString());
    assert.match(record.runAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });
});

describe('toTarget — the adapter pipeline wrapper', () => {
  /** A minimal adapter with its own raw shape, to prove TRawData stays internal. */
  function fakeAdapter(id: string, calls: string[]): Adapter<{ n: number }> {
    return {
      metadata: { id, name: id, chain: 'stellar', adapterRef: 'FakeAdapter' } as ProtocolMetadata,
      async fetchRawData() {
        calls.push('fetchRawData');
        return { n: 1 };
      },
      async computeRiskFactors(raw) {
        calls.push(`computeRiskFactors(${raw.n})`);
        return FACTORS;
      },
      score(factors): RiskScoreResult {
        calls.push('score');
        return { score: 53, factors, computedAt: COMPUTED_AT };
      },
    };
  }

  it('runs fetch → compute → score in order, threading the raw data through', async () => {
    const calls: string[] = [];
    const target = toTarget(fakeAdapter('blend', calls));
    const out = await target.run();

    assert.deepEqual(calls, ['fetchRawData', 'computeRiskFactors(1)', 'score']);
    assert.equal(out.safetyScore, 53);
    assert.equal(out.computedAt, COMPUTED_AT);
  });

  it('carries adapterRef through from metadata, independent of the class name', async () => {
    // This is what lands in the protocols table's `adapter` column.
    //
    // The class here is deliberately named something OTHER than its adapterRef.
    // The previous version of this test read the value off `constructor.name`
    // and asserted it equalled the class name — which passes under `node --test`
    // and in dev, and passed the whole time production was writing `w` to every
    // row, because minification renames classes in the bundled serverless build
    // and nothing unminified ever exercised that path. Asserting on a value the
    // build is free to rewrite is what made the test worthless. Naming the class
    // `MinifiedToSomethingElse` means this can only pass if the literal on
    // `metadata` is the thing being persisted.
    class MinifiedToSomethingElse implements Adapter<{ n: number }> {
      metadata = {
        id: 'blend',
        name: 'Blend',
        chain: 'stellar',
        adapterRef: 'BlendAdapter',
      } as ProtocolMetadata;
      async fetchRawData() {
        return { n: 1 };
      }
      async computeRiskFactors() {
        return FACTORS;
      }
      score(factors: RiskFactorMap): RiskScoreResult {
        return { score: 1, factors, computedAt: COMPUTED_AT };
      }
    }

    const target = toTarget(new MinifiedToSomethingElse());
    assert.equal(target.metadata.adapterRef, 'BlendAdapter');
    assert.notEqual(target.metadata.adapterRef, MinifiedToSomethingElse.name);
  });

  it('lets a failure anywhere in the pipeline surface to runCycle', async () => {
    // Each stage throws for real reasons — RPC down, a price that won't decode.
    // None of them may be swallowed inside the wrapper.
    for (const stage of ['fetchRawData', 'computeRiskFactors', 'score'] as const) {
      const adapter = fakeAdapter('blend', []);
      const boom = new Error(`${stage} exploded`);
      Object.assign(adapter, {
        [stage]: () => {
          throw boom;
        },
      });

      const { store, written } = fakeStore();
      const summary = await runCycle([toTarget(adapter)], store);
      assert.equal(summary.failed, 1, `a throw in ${stage} should be recorded as failed`);
      assert.equal(written[0].status === 'failed' && written[0].error, `${stage} exploded`);
    }
  });
});

// ---------------------------------------------------------------------------
// Retry, inside the run loop
// ---------------------------------------------------------------------------

/** A target that throws for its first `failures` calls, then succeeds. */
function flakyTarget(id: string, failures: number, safetyScore = 53) {
  let calls = 0;
  const target: IndexTarget = {
    metadata: { id, name: id, chain: 'stellar', adapterRef: 'FakeAdapter' },
    run: async () => {
      calls++;
      if (calls <= failures) throw new Error('Soroban RPC unreachable');
      return { safetyScore, factors: FACTORS, computedAt: COMPUTED_AT };
    },
  };
  return { target, calls: () => calls };
}

const RETRY: CycleOptions = {
  retry: { attempts: 3, baseDelayMs: 1, attemptTimeoutMs: 5000, minAttemptMs: 1 },
};

describe('runCycle — retry reduces false failures', () => {
  it('records ok when a transient failure clears on a later attempt', async () => {
    // The whole point: an RPC blip on the first attempt must not become a
    // permanent hole in this protocol's history.
    const { store, written } = fakeStore();
    const flaky = flakyTarget('blend', 2, 61);
    const summary = await runCycle([flaky.target], store, RETRY);

    assert.equal(flaky.calls(), 3);
    assert.equal(summary.ok, 1);
    assert.equal(summary.failed, 0);
    assert.equal(written[0].status === 'ok' && written[0].safetyScore, 61);
    assert.equal(summary.results[0].attempts, 3, 'the summary says it took three goes');
  });

  it('does not retry a run that succeeded first time', async () => {
    const { store } = fakeStore();
    const flaky = flakyTarget('blend', 0);
    const summary = await runCycle([flaky.target], store, RETRY);

    assert.equal(flaky.calls(), 1);
    assert.equal(summary.results[0].attempts, 1);
  });
});

describe('runCycle — retry never hides a real failure', () => {
  it('still records `failed` after exhausting every attempt', async () => {
    // The invariant that lets retry exist at all. A protocol that is genuinely
    // down must still show as down — retries change how often we cry wolf, not
    // what a failure is.
    const { store, written } = fakeStore();
    const summary = await runCycle([throwingTarget('blend')], store, RETRY);

    assert.equal(written.length, 1);
    assert.equal(written[0].status, 'failed');
    assert.equal(summary.failed, 1);
    assert.equal(summary.ok, 0);
  });

  it("keeps the adapter's own final error, not a retry-flavoured wrapper", async () => {
    const { store, written } = fakeStore();
    await runCycle(
      [throwingTarget('blend', new Error('no ResConfig for asset CXYZ'))],
      store,
      RETRY,
    );

    assert.equal(written[0].status === 'failed' && written[0].error, 'no ResConfig for asset CXYZ');
  });

  it('makes exactly the configured number of attempts before giving up', async () => {
    const { store } = fakeStore();
    const flaky = flakyTarget('blend', Infinity);
    await runCycle([flaky.target], store, RETRY);
    assert.equal(flaky.calls(), 3);
  });

  it('records a failed run with no score, exactly as before retry existed', async () => {
    const { store, written } = fakeStore();
    await runCycle([throwingTarget('blend')], store, RETRY);

    const record = written[0] as Record<string, unknown>;
    assert.equal(record.status, 'failed');
    assert.equal(record.safetyScore, undefined);
    assert.equal(record.factors, undefined);
  });
});

describe('runCycle — the cycle budget is a hard ceiling', () => {
  it('lets one protocol exhaust its whole share without costing the other a turn', async () => {
    // The requirement this pins: one protocol failing must not spend the other's
    // budget. Blend burns all 21s of its half of a 42s budget across its
    // retries; Kinetic must still get a full turn and score.
    let t = 0;
    const deps = { now: () => t, sleep: async (ms: number) => void (t += ms) };
    const { store, written } = fakeStore();

    const blend: IndexTarget = {
      metadata: { id: 'blend', name: 'blend', chain: 'stellar', adapterRef: 'FakeAdapter' },
      run: async () => {
        // Each attempt runs to its cap, as the soft timeout guarantees.
        t += Math.min(15_000, 21_000 - (t % 21_000 || 0));
        throw new Error('hung rpc');
      },
    };

    const summary = await runCycle([blend, okTarget('kinetic', 24)], store, {
      retry: { attempts: 3, baseDelayMs: 1000, attemptTimeoutMs: 15_000, minAttemptMs: 1000 },
      budgetMs: 42_000,
      deps,
    });

    assert.equal(summary.failed, 1);
    assert.equal(summary.ok, 1, 'kinetic still ran after blend spent its entire share');
    assert.deepEqual(
      written.map((r) => [r.protocolId, r.status]),
      [
        ['blend', 'failed'],
        ['kinetic', 'ok'],
      ],
    );
    assert.ok(t <= 42_000, `the cycle stayed inside its budget (ended at ${t}ms)`);
  });

  it('fails a later protocol fast and cleanly if the budget is genuinely gone', async () => {
    // If something overran far past its share, the 60s function is already lost.
    // Starting work that will be killed mid-flight is the worst outcome — it can
    // leave a protocol neither scored NOR recorded. Failing immediately at least
    // writes an honest `failed` row that says we never got to look.
    let t = 0;
    const deps = { now: () => t, sleep: async (ms: number) => void (t += ms) };
    const { store, written } = fakeStore();
    let kineticStarted = 0;

    const runaway: IndexTarget = {
      metadata: { id: 'blend', name: 'blend', chain: 'stellar', adapterRef: 'FakeAdapter' },
      run: async () => {
        t += 100_000;
        throw new Error('hung rpc');
      },
    };
    const kinetic: IndexTarget = {
      metadata: { id: 'kinetic', name: 'kinetic', chain: 'stellar', adapterRef: 'FakeAdapter' },
      run: async () => {
        kineticStarted++;
        return { safetyScore: 24, factors: FACTORS, computedAt: COMPUTED_AT };
      },
    };

    const summary = await runCycle([runaway, kinetic], store, {
      retry: { attempts: 3, baseDelayMs: 1000, attemptTimeoutMs: 15_000, minAttemptMs: 1000 },
      budgetMs: 42_000,
      deps,
    });

    assert.equal(kineticStarted, 0, 'no work is begun that cannot finish');
    assert.equal(summary.failed, 2);
    assert.deepEqual(
      written.map((r) => [r.protocolId, r.status]),
      [
        ['blend', 'failed'],
        ['kinetic', 'failed'],
      ],
    );
    assert.match(
      written[1].status === 'failed' ? written[1].error : '',
      /no time left in the cycle budget/,
      'the record says why, rather than blaming the protocol for something it did not do',
    );
  });

  it('stops retrying a protocol once its share of the budget is spent', async () => {
    let t = 0;
    const deps = { now: () => t, sleep: async (ms: number) => void (t += ms) };
    const { store } = fakeStore();
    let calls = 0;
    const slow: IndexTarget = {
      metadata: { id: 'blend', name: 'blend', chain: 'stellar', adapterRef: 'FakeAdapter' },
      run: async () => {
        calls++;
        t += 15_000; // the attempt cap
        throw new Error('rpc timeout');
      },
    };

    await runCycle([slow, okTarget('kinetic')], store, {
      retry: { attempts: 3, baseDelayMs: 1000, attemptTimeoutMs: 15_000, minAttemptMs: 1000 },
      budgetMs: 42_000,
      deps,
    });

    // Blend's share is 21s. One 15s attempt leaves 6s; after the 1s backoff, 5s
    // remains, so a second attempt starts and consumes it. The third has nothing.
    assert.equal(calls, 2, 'the third attempt the policy allows had no budget');
    assert.ok(t <= 42_000, `the run loop stayed inside its budget (ended at ${t}ms)`);
  });
});

// ---------------------------------------------------------------------------
// Alerting
// ---------------------------------------------------------------------------

describe('runCycle — a fresh, empty history never alerts', () => {
  it('sends nothing on the first cycle against an empty risk_scores', async () => {
    // risk_scores was truncated on 2026-08-19, so this is the literal state of
    // production on the next cycle — not a hypothetical. A protocol with no
    // history at all must not read as a failure streak.
    const { store } = fakeStore();
    const { notifier, all } = fakeNotifier();

    const summary = await runCycle([throwingTarget('blend')], store, alerting({ notifier }));

    assert.equal(summary.failed, 1, 'the failure is still recorded');
    assert.deepEqual(all(), [], 'but nobody is paged for one blip on an empty table');
    assert.equal(summary.alerts, undefined);
  });

  it('stays silent for every cycle below the threshold', async () => {
    const { store } = fakeStore();
    const { notifier, all } = fakeNotifier();

    for (let cycle = 1; cycle < 4; cycle++) {
      await runCycle([throwingTarget('blend')], store, alerting({ notifier }));
      assert.deepEqual(all(), [], `no alert after ${cycle} consecutive failures`);
    }
  });

  it('sends nothing when a protocol has only ever succeeded', async () => {
    const { store } = fakeStore();
    const { notifier, all } = fakeNotifier();
    for (let i = 0; i < 6; i++) {
      await runCycle([okTarget('blend')], store, alerting({ notifier }));
    }
    assert.deepEqual(all(), []);
  });
});

describe('runCycle — alerting on a seeded failure streak', () => {
  it('fires on the cycle that completes the fourth consecutive failure', async () => {
    // Three failures already on record; this cycle's failure is the fourth.
    const { store } = fakeStore({ history: { blend: failedRuns(3) } });
    const { notifier, all } = fakeNotifier();

    await runCycle(
      [throwingTarget('blend', new Error('Blend: simulation of get_reserve_list failed'))],
      store,
      alerting({ notifier }),
    );

    const alerts = all();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].kind, 'failing');
    assert.equal(alerts[0].protocolId, 'blend');
    assert.equal(alerts[0].consecutiveFailures, 4);
    assert.match(alerts[0].latestError, /simulation of get_reserve_list failed/);
  });

  it('does not fire again on the fifth, sixth or seventh consecutive failure', async () => {
    const { store } = fakeStore({ history: { blend: failedRuns(4) } });
    const { notifier, all } = fakeNotifier();

    for (let i = 0; i < 3; i++) {
      await runCycle([throwingTarget('blend')], store, alerting({ notifier }));
    }
    assert.deepEqual(all(), [], 'a long outage is one message, not one per cycle');
  });

  it('sends a recovery alert when the protocol scores again', async () => {
    const { store } = fakeStore({ history: { blend: failedRuns(6) } });
    const { notifier, all } = fakeNotifier();

    await runCycle([okTarget('blend', 61)], store, alerting({ notifier }));

    const alerts = all();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].kind, 'recovered');
    assert.equal(alerts[0].consecutiveFailures, 6);
  });

  it('sends no recovery alert for a streak that never crossed the threshold', async () => {
    const { store } = fakeStore({ history: { blend: failedRuns(2) } });
    const { notifier, all } = fakeNotifier();

    await runCycle([okTarget('blend')], store, alerting({ notifier }));
    assert.deepEqual(all(), [], 'no failing alert was sent, so there is nothing to answer');
  });

  it('batches both protocols into one notification when both cross together', async () => {
    // An RPC-wide outage is one incident, and should read as one.
    const { store } = fakeStore({ history: { blend: failedRuns(3), kinetic: failedRuns(3) } });
    const { notifier, batches } = fakeNotifier();

    const summary = await runCycle(
      [throwingTarget('blend'), throwingTarget('kinetic')],
      store,
      alerting({ notifier }),
    );

    assert.equal(batches.length, 1, 'one POST for the cycle, not one per protocol');
    assert.deepEqual(
      batches[0].map((a) => a.protocolId),
      ['blend', 'kinetic'],
    );
    assert.equal(summary.alerts?.length, 2);
  });

  it('alerts on one protocol without involving the other', async () => {
    const { store } = fakeStore({ history: { blend: failedRuns(3) } });
    const { notifier, all } = fakeNotifier();

    await runCycle(
      [throwingTarget('blend'), okTarget('kinetic', 47)],
      store,
      alerting({ notifier }),
    );

    assert.deepEqual(
      all().map((a) => a.protocolId),
      ['blend'],
    );
  });

  it('does not alert when no notifier is configured, but still records the failure', async () => {
    // STENION_ALERT_WEBHOOK_URL unset is the default: retries and failed-run
    // recording carry on, alerting is simply off.
    const { store, written } = fakeStore({ history: { blend: failedRuns(3) } });
    const summary = await runCycle([throwingTarget('blend')], store, { alertThreshold: 4 });

    assert.equal(written[0].status, 'failed');
    assert.equal(summary.alerts, undefined);
  });
});

describe('runCycle — alerting can never break a cycle', () => {
  it('carries on when the notifier throws', async () => {
    const { store, written } = fakeStore({ history: { blend: failedRuns(3) } });
    const summary = await runCycle([throwingTarget('blend'), okTarget('kinetic', 24)], store, {
      alertThreshold: 4,
      notifier: async () => {
        throw new Error('webhook 500');
      },
    });

    assert.equal(summary.ran, 2);
    assert.equal(summary.ok, 1, 'kinetic still scored');
    assert.equal(written.length, 2, 'both runs still persisted');
    assert.ok(logs.some((l) => l.includes('delivery failed')));
  });

  it('carries on when the streak query itself fails', async () => {
    const { store } = fakeStore({ failReads: true, history: { blend: failedRuns(3) } });
    const { notifier, all } = fakeNotifier();

    const summary = await runCycle([throwingTarget('blend')], store, alerting({ notifier }));

    assert.equal(summary.failed, 1);
    assert.deepEqual(all(), []);
    assert.ok(logs.some((l) => l.includes('could not read run history')));
  });

  it('skips the streak check when the run record could not be written', async () => {
    // A streak we could not record is not one to page anyone about — and the
    // history we would read wouldn't contain this cycle anyway.
    const { store } = fakeStore({ failWrites: true, history: { blend: failedRuns(3) } });
    const { notifier, all } = fakeNotifier();

    await runCycle([throwingTarget('blend')], store, alerting({ notifier }));
    assert.deepEqual(all(), []);
  });
});
