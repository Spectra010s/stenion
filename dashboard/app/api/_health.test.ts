// Tests for the health endpoint's policy — staleness, the three states, and the
// HTTP status each one is served with.
//
// WHY THESE EXIST: this endpoint's whole job is to be correct at the exact moment
// nobody is looking at it, and every one of its interesting states is one we have
// never seen. `risk_scores` has held zero `failed` rows in production (see
// db/src/store.test.ts), so `degraded` and `down` have never once been produced
// by real data — and by construction they never will be until the day they
// matter. A wrong threshold or an inverted comparison here shows up as an
// endpoint that answers `healthy` with a 200 through an outage, which is worse
// than not having the endpoint at all: it converts "nobody was watching" into
// "the monitor said it was fine".
//
// These test the policy, not the SQL. Which rows come back is the query's job
// (db/src/store.ts, one query, covered by the integration suite); what they mean
// is pure, and this is it.
//
// Run with: pnpm --filter @stenion/dashboard test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_DOWN_MULTIPLIER,
  DEFAULT_HEALTH_SETTINGS,
  DEFAULT_STALE_MINUTES,
  buildHealthBody,
  healthHttpStatus,
  minutesSince,
  overallStatus,
  readHealthSettings,
  type HealthSettings,
  type RunFreshness,
} from './_health.ts';

const NOW = Date.parse('2026-08-22T12:50:00.000Z');

/** An ISO timestamp `minutes` old relative to NOW. */
const agedBy = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

/**
 * A protocol whose last successful run was `staleMinutes` ago and whose last run
 * of any status succeeded — i.e. the ordinary case.
 */
const fresh = (id: string, staleMinutes: number): RunFreshness => ({
  id,
  lastSuccessfulRunAt: agedBy(staleMinutes),
  lastRunAt: agedBy(staleMinutes),
  lastRunStatus: 'ok',
});

/**
 * A protocol the indexer is still reaching but whose adapter is failing: the
 * last run is recent and failed, the last SUCCESS is `staleMinutes` old.
 */
const failing = (id: string, staleMinutes: number): RunFreshness => ({
  id,
  lastSuccessfulRunAt: agedBy(staleMinutes),
  lastRunAt: agedBy(1),
  lastRunStatus: 'failed',
});

/** A protocol that has never produced a successful run. */
const neverSucceeded = (id: string): RunFreshness => ({
  id,
  lastSuccessfulRunAt: null,
  lastRunAt: null,
  lastRunStatus: null,
});

const build = (rows: RunFreshness[], settings: HealthSettings = DEFAULT_HEALTH_SETTINGS) =>
  buildHealthBody(rows, settings, NOW);

// ---------------------------------------------------------------------------

describe('the three acceptance-criteria cases', () => {
  it('all protocols current → healthy, 200', () => {
    const body = build([fresh('blend', 2), fresh('blend-yieldblox', 3), fresh('kinetic', 4)]);
    assert.equal(body.status, 'healthy');
    assert.equal(healthHttpStatus(body.status), 200);
  });

  it('one protocol stale, the rest current → degraded, non-200', () => {
    // The isolated-adapter case: the cron is demonstrably arriving, because two
    // protocols scored minutes ago. Only one is behind.
    const body = build([fresh('blend', 2), fresh('blend-yieldblox', 3), failing('kinetic', 213)]);
    assert.equal(body.status, 'degraded');
    assert.notEqual(healthHttpStatus(body.status), 200);
    assert.equal(healthHttpStatus(body.status), 503);
  });

  it('nothing has succeeded in a long time → down, non-200', () => {
    // The infrastructure case: every protocol is past the down window, so there
    // is no evidence the cron is arriving at all.
    const body = build([fresh('blend', 400), fresh('blend-yieldblox', 400), fresh('kinetic', 400)]);
    assert.equal(body.status, 'down');
    assert.notEqual(healthHttpStatus(body.status), 200);
    assert.equal(healthHttpStatus(body.status), 503);
  });

  it('no protocol has ever run → down', () => {
    // A migrated but never-indexed database. There is nothing to measure a down
    // window from, and 200 would make this endpoint's very first answer a false
    // negative.
    const body = build([neverSucceeded('blend'), neverSucceeded('kinetic')]);
    assert.equal(body.status, 'down');
    assert.equal(healthHttpStatus(body.status), 503);
  });
});

describe('the boundary between degraded and down', () => {
  // Both are non-200, so nothing about *alerting* turns on this. What turns on
  // it is where an operator is sent: `degraded` says read the per-protocol rows,
  // `down` says go look at the cron. Getting it backwards wastes the first ten
  // minutes of an incident.

  it('holds at degraded while everything is stale but inside the down window', () => {
    const insideWindow = DEFAULT_STALE_MINUTES * DEFAULT_DOWN_MULTIPLIER - 1;
    const body = build([fresh('blend', insideWindow), fresh('kinetic', insideWindow)]);
    assert.equal(body.status, 'degraded');
  });

  it('is still degraded exactly ON the down window, not yet down', () => {
    // `>` not `>=`: the boundary minute belongs to the milder claim. Declaring
    // the cron dead is the more specific accusation, so it takes the later side.
    const onWindow = DEFAULT_STALE_MINUTES * DEFAULT_DOWN_MULTIPLIER;
    assert.equal(build([fresh('blend', onWindow)]).status, 'degraded');
  });

  it('becomes down one minute past it', () => {
    const pastWindow = DEFAULT_STALE_MINUTES * DEFAULT_DOWN_MULTIPLIER + 1;
    assert.equal(build([fresh('blend', pastWindow)]).status, 'down');
  });

  it('measures the down window from the FRESHEST success, not the oldest', () => {
    // The most generous reading available, so this can never report worse than
    // the truth. One protocol 400 minutes stale does not make the system `down`
    // while another succeeded 35 minutes ago — that is 7 missed cycles, bad, but
    // it is evidence the cron IS arriving.
    const body = build([fresh('blend', 35), fresh('kinetic', 400)]);
    assert.equal(body.status, 'degraded');
  });

  it('never lets a never-succeeded protocol drag the window earlier', () => {
    // A null staleMinutes is not an age and must not be treated as an infinite
    // one. Here a protocol that has never scored sits next to one that is stale
    // but inside the window; the state is degraded, on the evidence that exists.
    const insideWindow = DEFAULT_STALE_MINUTES * DEFAULT_DOWN_MULTIPLIER - 1;
    const body = build([neverSucceeded('new-adapter'), fresh('blend', insideWindow)]);
    assert.equal(body.status, 'degraded');
  });
});

describe('the staleness threshold itself', () => {
  it('counts a protocol exactly on the threshold as current', () => {
    // Inclusive, so `staleMinutes <= thresholdMinutes` is the documented rule and
    // the endpoint does not flicker for the minute it sits on the boundary.
    assert.equal(build([fresh('blend', DEFAULT_STALE_MINUTES)]).status, 'healthy');
  });

  it('counts one minute past it as not current', () => {
    assert.equal(build([fresh('blend', DEFAULT_STALE_MINUTES + 1)]).status, 'degraded');
  });

  it('sits above the indexer alert threshold, so the webhook fires first', () => {
    // The intended escalation order, asserted rather than left to a comment: the
    // indexer alerts after 4 consecutive failures (~20 min at the 5-minute
    // cadence), and only if the problem is still there does the monitor go red.
    // If someone lowers this below 20, this test says so.
    const alertThresholdMinutes = 4 * 5;
    assert.ok(
      DEFAULT_STALE_MINUTES > alertThresholdMinutes,
      `health threshold (${DEFAULT_STALE_MINUTES}m) must exceed the indexer alert threshold ` +
        `(${alertThresholdMinutes}m), or the monitor pages before the webhook mentions it`,
    );
  });

  it('is at least a few cycles wide, so one slow cycle is not an outage', () => {
    const cadenceMinutes = 5;
    assert.ok(DEFAULT_STALE_MINUTES >= cadenceMinutes * 3);
  });
});

describe('staleness is measured from the last SUCCESSFUL run', () => {
  it('does not let a fresh failed run disguise stale data', () => {
    // THE INVARIANT, and the reason the two timestamps are separate fields.
    //
    // An adapter failing reliably every five minutes has a `lastRunAt` that is
    // always one minute old. Measuring freshness from it would report that
    // protocol as perfectly current forever — inverted, and precisely the case
    // this endpoint is for.
    const body = build([failing('kinetic', 213)]);
    const kinetic = body.protocols[0];
    assert.equal(kinetic?.staleMinutes, 213);
    assert.equal(kinetic?.lastRunStatus, 'failed');
    assert.equal(body.status, 'down');
  });

  it('reports a recent failure as healthy while the last success is current', () => {
    // Deliberate: the indexer already retried 3 times before recording this, but
    // it is still one cycle, and the served data is 4 minutes old. Paging here
    // would be a false page. Sustained failure is not missed — it crosses the
    // threshold on its own within THRESHOLD minutes.
    const body = build([failing('kinetic', 4), fresh('blend', 2)]);
    assert.equal(body.status, 'healthy');
    assert.equal(healthHttpStatus(body.status), 200);
    // ...and the failure is still visible to a consumer that wants to act on it.
    assert.equal(body.protocols.find((p) => p.id === 'kinetic')?.lastRunStatus, 'failed');
  });
});

describe('the published body', () => {
  it('carries every documented field per protocol', () => {
    const body = build([failing('kinetic', 213)]);
    assert.deepEqual(body.protocols, [
      {
        id: 'kinetic',
        lastSuccessfulRunAt: agedBy(213),
        lastRunAt: agedBy(1),
        lastRunStatus: 'failed',
        staleMinutes: 213,
      },
    ]);
  });

  it('publishes lastRunStatus as ok/failed, matching the other /v1 routes', () => {
    // NOT `success`/`failure`. The same underlying column is published as
    // `ok`/`failed` on /v1/protocols and /v1/protocol/:id, and one field name
    // carrying two vocabularies across a single API is a bug a consumer only
    // finds in production.
    const body = build([fresh('blend', 1), failing('kinetic', 99)]);
    for (const protocol of body.protocols) {
      assert.ok(
        protocol.lastRunStatus === 'ok' ||
          protocol.lastRunStatus === 'failed' ||
          protocol.lastRunStatus === null,
        `unexpected lastRunStatus: ${String(protocol.lastRunStatus)}`,
      );
    }
  });

  it('echoes the threshold it judged against', () => {
    // So a consumer reading `degraded` can tell what number produced it without
    // knowing our environment configuration.
    const settings: HealthSettings = { thresholdMinutes: 12, downMultiplier: 3 };
    assert.equal(build([fresh('blend', 1)], settings).thresholdMinutes, 12);
  });

  it('preserves the order the query returned, without re-sorting', () => {
    const body = build([fresh('kinetic', 1), fresh('blend', 2), fresh('yieldblox', 3)]);
    assert.deepEqual(
      body.protocols.map((p) => p.id),
      ['kinetic', 'blend', 'yieldblox'],
    );
  });

  it('gives a never-succeeded protocol null, never zero', () => {
    // A zero would render as "just ran", the exact inverse of never having run.
    const body = build([neverSucceeded('blend')]);
    assert.equal(body.protocols[0]?.staleMinutes, null);
    assert.equal(body.protocols[0]?.lastSuccessfulRunAt, null);
  });

  it('is down for an empty registry rather than vacuously healthy', () => {
    const body = build([]);
    assert.equal(body.status, 'down');
    assert.deepEqual(body.protocols, []);
    assert.equal(healthHttpStatus(body.status), 503);
  });
});

describe('minutesSince', () => {
  it('floors, so the number means "at least this old"', () => {
    assert.equal(minutesSince(new Date(NOW - 119_000).toISOString(), NOW), 1);
  });

  it('clamps clock skew to zero rather than reporting a negative age', () => {
    // Neon's now() and the function's clock are different clocks; a run stamped
    // slightly in the future is fresh, not -1 minutes old.
    assert.equal(minutesSince(new Date(NOW + 30_000).toISOString(), NOW), 0);
  });

  it('returns null for a missing or unparseable timestamp', () => {
    assert.equal(minutesSince(null, NOW), null);
    assert.equal(minutesSince('not a date', NOW), null);
  });

  it('treats an unparseable timestamp as not current, never as fresh', () => {
    const body = build([
      { id: 'blend', lastSuccessfulRunAt: 'garbage', lastRunAt: 'garbage', lastRunStatus: 'ok' },
    ]);
    assert.equal(body.protocols[0]?.staleMinutes, null);
    assert.equal(body.status, 'down');
  });
});

describe('readHealthSettings', () => {
  it('defaults when nothing is set', () => {
    assert.deepEqual(readHealthSettings({}), DEFAULT_HEALTH_SETTINGS);
  });

  it('reads both knobs from the environment — the threshold is not hardcoded', () => {
    assert.deepEqual(
      readHealthSettings({
        STENION_HEALTH_STALE_MINUTES: '10',
        STENION_HEALTH_DOWN_MULTIPLIER: '4',
      }),
      { thresholdMinutes: 10, downMultiplier: 4 },
    );
  });

  it('falls back rather than throwing on a malformed value', () => {
    // A health endpoint that 500s because someone typed `thirty` reports an
    // outage that does not exist, most likely at deploy time — when a real one
    // is both most likely and least distinguishable.
    for (const bad of ['thirty', '', '   ', '-5', '0', 'NaN', 'Infinity']) {
      assert.equal(
        readHealthSettings({ STENION_HEALTH_STALE_MINUTES: bad }).thresholdMinutes,
        DEFAULT_STALE_MINUTES,
        `expected fallback for ${JSON.stringify(bad)}`,
      );
    }
  });

  it('accepts a fractional threshold', () => {
    // Not expected in production, but positive-and-finite is the documented rule
    // and it should not silently become the default.
    assert.equal(readHealthSettings({ STENION_HEALTH_STALE_MINUTES: '2.5' }).thresholdMinutes, 2.5);
  });
});

describe('overallStatus is a pure function of the rows it is given', () => {
  it('does not depend on the order protocols arrive in', () => {
    const rows = [fresh('a', 1), fresh('b', 400), neverSucceeded('c')];
    const forwards = buildHealthBody(rows, DEFAULT_HEALTH_SETTINGS, NOW).status;
    const backwards = buildHealthBody([...rows].reverse(), DEFAULT_HEALTH_SETTINGS, NOW).status;
    assert.equal(forwards, backwards);
  });

  it('measures every protocol against one instant', () => {
    // `nowMs` is a parameter, not a Date.now() per protocol, so a slow response
    // cannot report ages that disagree with each other.
    const body = build([fresh('a', 5), fresh('b', 5), fresh('c', 5)]);
    assert.deepEqual(
      body.protocols.map((p) => p.staleMinutes),
      [5, 5, 5],
    );
  });

  it('exposes overallStatus directly for callers that already have the rows', () => {
    const protocols = build([fresh('a', 1)]).protocols;
    assert.equal(overallStatus(protocols, DEFAULT_HEALTH_SETTINGS), 'healthy');
  });
});
