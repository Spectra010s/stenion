// Tests for consecutive-failure alerting.
//
// WHY THESE EXIST, and why they matter more than usual: `risk_scores` has never
// held a failed row in production, and was truncated on 2026-08-19, so it now
// starts from empty. Nothing about this path is evidenced by having run. Every
// case below is a seeded history, because there is no other way to get one.
//
// THE CASE THIS FILE IS REALLY FOR is the empty and near-empty history. The
// predicate is "count failed runs from the newest backwards until the first
// non-failed one", NOT "no ok run in the last N" — the two agree on a populated
// table and disagree catastrophically on a fresh one, where the second fires
// immediately and pages someone about a table that was simply truncated. The
// first two tests below are that guarantee, expressed as assertions rather than
// as a comment nobody re-reads.
//
// Run with: pnpm --filter @stenion/indexer test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildWebhookPayload,
  countLeadingFailures,
  decideAlert,
  formatAlert,
  MAX_MESSAGE_CHARS,
  streakWindow,
  webhookNotifier,
  type StreakAlert,
} from './alerts.ts';
import type { RecentRun } from '@stenion/db';

const THRESHOLD = 4;
const OPTS = { threshold: THRESHOLD, protocolId: 'kinetic', protocolName: 'Kinetic' };

/** Runs are newest-first, exactly as listRecentRuns returns them. */
function failed(minutesAgo: number, error = 'Soroban RPC unreachable'): RecentRun {
  return { status: 'failed', error, runAt: minutesAgoIso(minutesAgo) };
}
function ok(minutesAgo: number): RecentRun {
  return { status: 'ok', error: null, runAt: minutesAgoIso(minutesAgo) };
}

const BASE = Date.parse('2026-08-19T12:00:00.000Z');
function minutesAgoIso(minutes: number): string {
  return new Date(BASE - minutes * 60_000).toISOString();
}

/** N consecutive failures, newest first, on the 5-minute cadence. */
function streak(n: number, error?: string): RecentRun[] {
  return Array.from({ length: n }, (_, i) => failed(i * 5, error));
}

// ---------------------------------------------------------------------------
// The empty / fresh-table guarantee
// ---------------------------------------------------------------------------

describe('a history with no failures in it cannot read as a failure streak', () => {
  it('counts zero leading failures in an EMPTY history', () => {
    // risk_scores was truncated. Before the first cycle writes anything, this is
    // literally what listRecentRuns returns, and it must be 0 — not "no ok run
    // found", which is also true of an empty table and is the wrong question.
    assert.equal(countLeadingFailures([]), 0);
  });

  it('raises no alert on a completely empty history', () => {
    assert.equal(decideAlert([], OPTS), null);
  });

  it('raises no alert on the very first cycle, even when that cycle failed', () => {
    // One real failed row. A fresh table plus one bad cycle is a blip, not an
    // outage, and this is the 2am false positive the design exists to avoid.
    assert.equal(decideAlert([failed(0)], OPTS), null);
  });

  it('stays quiet for every streak length below the threshold', () => {
    for (let n = 1; n < THRESHOLD; n++) {
      assert.equal(decideAlert(streak(n), OPTS), null, `${n} consecutive failures must not alert`);
    }
  });

  it('raises no alert for a protocol whose history is all successes', () => {
    assert.equal(decideAlert([ok(0), ok(5), ok(10)], OPTS), null);
  });

  it('gives a newly-added protocol the same protection with no special case', () => {
    // A new adapter starts at zero rows and walks up through the same counts.
    assert.equal(decideAlert([], OPTS), null);
    assert.equal(decideAlert([failed(0)], OPTS), null);
    assert.equal(decideAlert(streak(2), OPTS), null);
  });
});

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

describe('countLeadingFailures — counts backwards from the newest run', () => {
  it('stops at the first ok run', () => {
    assert.equal(countLeadingFailures([failed(0), failed(5), ok(10), failed(15), failed(20)]), 2);
  });

  it('counts the whole array when every run failed', () => {
    assert.equal(countLeadingFailures(streak(6)), 6);
  });

  it('returns 0 when the newest run is ok, however many failures sit behind it', () => {
    assert.equal(countLeadingFailures([ok(0), ...streak(9)]), 0);
  });
});

describe('streakWindow — wide enough to tell "exactly N" from "more than N"', () => {
  it('always exceeds the threshold, so the crossing is distinguishable', () => {
    for (const t of [1, 2, 4, 25, 100]) {
      assert.ok(streakWindow(t) >= t + 2, `window for threshold ${t} must exceed it`);
    }
  });
});

// ---------------------------------------------------------------------------
// Firing
// ---------------------------------------------------------------------------

describe('decideAlert — failing, edge-triggered at exactly the threshold', () => {
  it('fires when the streak reaches exactly N', () => {
    const alert = decideAlert(streak(THRESHOLD), OPTS);
    assert.ok(alert);
    assert.equal(alert.kind, 'failing');
    assert.equal(alert.protocolId, 'kinetic');
    assert.equal(alert.protocolName, 'Kinetic');
    assert.equal(alert.consecutiveFailures, THRESHOLD);
    assert.equal(alert.exact, true);
  });

  it('stays SILENT for every cycle after the crossing', () => {
    // The point of edge-triggering: a six-hour outage is one message, not 72.
    for (let n = THRESHOLD + 1; n <= THRESHOLD + 12; n++) {
      assert.equal(
        decideAlert(streak(n), OPTS),
        null,
        `${n} consecutive failures must not re-fire`,
      );
    }
  });

  it('fires again only after the streak is broken and rebuilt', () => {
    const rebuilt = [...streak(THRESHOLD), ok(THRESHOLD * 5), ...streak(THRESHOLD, 'older')];
    const alert = decideAlert(rebuilt, OPTS);
    assert.ok(alert);
    assert.equal(alert.kind, 'failing');
    assert.equal(alert.consecutiveFailures, THRESHOLD);
  });

  it('carries the newest error, the streak span, and the distinct messages', () => {
    const runs: RecentRun[] = [
      failed(0, 'Kinetic: simulation of get_reserves_list failed: HostError'),
      failed(5, 'fetch failed'),
      failed(10, 'fetch failed'),
      failed(15, 'fetch failed'),
    ];
    const alert = decideAlert(runs, OPTS);
    assert.ok(alert);
    assert.equal(alert.latestError, 'Kinetic: simulation of get_reserves_list failed: HostError');
    assert.equal(alert.firstFailureAt, minutesAgoIso(15));
    assert.equal(alert.lastFailureAt, minutesAgoIso(0));
    // Four identical errors and four different ones mean different things —
    // usually "the protocol changed" versus "the RPC provider is flaky".
    assert.deepEqual(alert.distinctErrors, [
      'Kinetic: simulation of get_reserves_list failed: HostError',
      'fetch failed',
    ]);
  });

  it('honours a different threshold', () => {
    const opts = { ...OPTS, threshold: 2 };
    assert.equal(decideAlert(streak(1), opts), null);
    assert.ok(decideAlert(streak(2), opts));
    assert.equal(decideAlert(streak(3), opts), null);
  });
});

describe('decideAlert — recovered', () => {
  it('fires when an ok run ends a streak that had reached the threshold', () => {
    const alert = decideAlert(
      [ok(0), ...streak(THRESHOLD).map((r, i) => failed((i + 1) * 5))],
      OPTS,
    );
    assert.ok(alert);
    assert.equal(alert.kind, 'recovered');
    assert.equal(alert.consecutiveFailures, THRESHOLD);
    assert.equal(alert.exact, true);
  });

  it('does NOT fire when the streak it ended was never alerted on', () => {
    // No `failing` message was sent for a 3-cycle blip, so a `recovered` one
    // would be a reply to nothing.
    const runs = [ok(0), failed(5), failed(10), failed(15), ok(20)];
    assert.equal(decideAlert(runs, OPTS), null);
  });

  it('does not fire on a run of consecutive successes', () => {
    assert.equal(decideAlert([ok(0), ok(5), ok(10), ok(15)], OPTS), null);
  });

  it('reports the count as a floor when the streak filled the whole window', () => {
    // We read a bounded window, so a very long outage is "20+", not "20".
    const window = streakWindow(THRESHOLD);
    const runs: RecentRun[] = [
      ok(0),
      ...Array.from({ length: window - 1 }, (_, i) => failed((i + 1) * 5)),
    ];
    const alert = decideAlert(runs, OPTS);
    assert.ok(alert);
    assert.equal(alert.kind, 'recovered');
    assert.equal(alert.exact, false);
    assert.match(formatAlert(alert), /\d+\+ consecutive failed cycles/);
  });
});

// ---------------------------------------------------------------------------
// What a human actually reads
// ---------------------------------------------------------------------------

describe('formatAlert — actionable at 2am', () => {
  it('names the protocol, the streak length, the span, and the error', () => {
    const alert = decideAlert(streak(THRESHOLD, 'Soroban RPC unreachable'), OPTS);
    assert.ok(alert);
    const text = formatAlert(alert);

    // "Blend failed" is useless; each of these is why.
    assert.match(text, /kinetic \(Kinetic\)/, 'which protocol');
    assert.match(text, /4 consecutive indexer cycles/, 'how many cycles');
    assert.match(text, /15 min/, 'how long it has been going');
    assert.match(text, /Soroban RPC unreachable/, 'the underlying error');
  });

  it('says when the streak carried more than one distinct error', () => {
    const runs = [
      failed(0, 'fetch failed'),
      failed(5, 'HTTP 502'),
      failed(10, 'fetch failed'),
      failed(15, 'fetch failed'),
    ];
    const alert = decideAlert(runs, OPTS);
    assert.ok(alert);
    const text = formatAlert(alert);
    assert.match(text, /2 distinct/);
    assert.match(text, /HTTP 502/);
  });

  it('says errors were identical when they were', () => {
    const alert = decideAlert(streak(THRESHOLD), OPTS);
    assert.ok(alert);
    assert.match(formatAlert(alert), /all identical/);
  });

  it('renders a recovery message that names what recovered', () => {
    const runs = [ok(0), ...Array.from({ length: THRESHOLD }, (_, i) => failed((i + 1) * 5))];
    const alert = decideAlert(runs, OPTS);
    assert.ok(alert);
    const text = formatAlert(alert);
    assert.match(text, /recovered/);
    assert.match(text, /kinetic \(Kinetic\)/);
    assert.match(text, /4 consecutive failed cycles/);
  });
});

describe('buildWebhookPayload — one body that both Slack and Discord render', () => {
  const alerts = [decideAlert(streak(THRESHOLD), OPTS)!];

  it('carries the SAME text under both `text` and `content`', () => {
    // Slack reads `text`, Discord reads `content`, each ignoring the other. This
    // assertion exists so nobody deletes one as duplication: dropping either key
    // renders an empty message on that service while the POST still returns 2xx.
    const payload = buildWebhookPayload(alerts) as { text: string; content: string };
    assert.equal(payload.text, payload.content);
    assert.ok(payload.text.length > 0);
    assert.match(payload.text, /kinetic/);
  });

  it('carries the structured alerts alongside the rendered text', () => {
    const payload = buildWebhookPayload(alerts) as { alerts: StreakAlert[] };
    assert.equal(payload.alerts.length, 1);
    assert.equal(payload.alerts[0].protocolId, 'kinetic');
    assert.equal(payload.alerts[0].consecutiveFailures, THRESHOLD);
  });

  it('joins multiple protocols into one body', () => {
    const both = [
      decideAlert(streak(THRESHOLD), OPTS)!,
      decideAlert(streak(THRESHOLD), { ...OPTS, protocolId: 'blend', protocolName: 'Blend' })!,
    ];
    const payload = buildWebhookPayload(both) as { text: string };
    assert.match(payload.text, /kinetic/);
    assert.match(payload.text, /blend/);
  });
});

describe('webhookNotifier', () => {
  it('POSTs JSON once for the whole cycle', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const notify = webhookNotifier('https://hooks.example/abc', (async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 204 });
    }) as typeof fetch);

    await notify([
      decideAlert(streak(THRESHOLD), OPTS)!,
      decideAlert(streak(THRESHOLD), { ...OPTS, protocolId: 'blend', protocolName: 'Blend' })!,
    ]);

    assert.equal(calls.length, 1, 'an outage hitting both protocols is one incident, one message');
    assert.equal(calls[0].url, 'https://hooks.example/abc');
    assert.match((calls[0].body as { text: string }).text, /kinetic/);
  });

  it('sends nothing at all when there are no alerts', async () => {
    let called = 0;
    const notify = webhookNotifier('https://hooks.example/abc', (async () => {
      called++;
      return new Response(null, { status: 204 });
    }) as typeof fetch);

    await notify([]);
    assert.equal(called, 0);
  });

  it('throws on a non-2xx so the caller can log it', async () => {
    const notify = webhookNotifier(
      'https://hooks.example/abc',
      (async () => new Response('nope', { status: 500 })) as typeof fetch,
    );

    await assert.rejects(notify([decideAlert(streak(THRESHOLD), OPTS)!]), /returned 500/);
  });
});

describe('buildWebhookPayload — the message must fit what Discord accepts', () => {
  // A Soroban failure message is long. Four distinct ones per protocol, for two
  // protocols batched into one POST, is not a contrived case — it is what an
  // RPC-wide outage produces, and it was 2,488 characters before this cap.
  const hostError = (p: string, n: number) =>
    `${p}: simulation of get_reserve_list on CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD ` +
    `failed: HostError: Error(WasmVm, InvalidAction) DebugInfo not available, run with DEBUG=true; attempt ${n}`;

  function bigAlert(id: string, name: string): StreakAlert {
    return {
      kind: 'failing',
      protocolId: id,
      protocolName: name,
      consecutiveFailures: 4,
      exact: true,
      firstFailureAt: '2026-08-19T12:00:00.000Z',
      lastFailureAt: '2026-08-19T12:15:00.000Z',
      latestError: hostError(name, 4),
      distinctErrors: [4, 3, 2, 1].map((n) => hostError(name, n)),
    };
  }

  const batched = [bigAlert('blend', 'Blend'), bigAlert('kinetic', 'Kinetic')];

  it('caps the rendered body at the Discord limit', () => {
    // Over the limit is not truncated by Discord — it is REJECTED with a 400, so
    // the alert for the worst possible outage would be the one that never lands.
    const payload = buildWebhookPayload(batched) as { content: string; text: string };
    assert.ok(
      payload.content.length <= MAX_MESSAGE_CHARS,
      `content was ${payload.content.length} chars, limit is ${MAX_MESSAGE_CHARS}`,
    );
    assert.equal(payload.text, payload.content, 'both keys stay identical');
  });

  it('says it truncated, rather than trailing off mid-error', () => {
    const payload = buildWebhookPayload(batched) as { content: string };
    assert.match(payload.content, /truncated/);
  });

  it('never truncates the structured alerts', () => {
    // The rendered text is for a human and is capped; the machine-readable form
    // keeps every error in full, so nothing is actually lost.
    const payload = buildWebhookPayload(batched) as { alerts: StreakAlert[] };
    assert.equal(payload.alerts.length, 2);
    assert.equal(payload.alerts[1].distinctErrors.length, 4);
    assert.equal(payload.alerts[1].latestError, hostError('Kinetic', 4));
  });

  it('leaves an ordinary alert completely untouched', () => {
    const payload = buildWebhookPayload([decideAlert(streak(THRESHOLD), OPTS)!]) as {
      content: string;
    };
    assert.ok(payload.content.length < MAX_MESSAGE_CHARS);
    assert.doesNotMatch(payload.content, /truncated/);
  });
});
