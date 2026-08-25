// Tests for the shared operational-state classification.
//
// WHY THESE EXIST. This module is the one place two adapters could come to
// disagree about what "frozen" means, and unlike a factor there is no score to
// notice the drift — a wrong level publishes a wrong word beside a correct
// number, which is harder to spot than a wrong number. So the ladder is pinned
// here, on the cases live data cannot reach: Blend has never been anything but
// status 0/1 and K2 has never been paused, so every restricted state below is
// one no fixture will ever supply.
//
// Run with: pnpm --filter @stenion/core test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  OperationalLevel,
  PoolOperation,
  mostRestrictive,
  toOperationalState,
} from './operational-state.ts';
import type { OperationalReading } from './operational-state.ts';

const AS_OF = new Date('2026-08-25T10:00:00.000Z');

const reading = (over: Partial<OperationalReading> = {}): OperationalReading => ({
  blocked: [],
  neverOpened: false,
  source: 'test',
  origin: 'indeterminate',
  detail: 'test',
  asOf: AS_OF,
  ...over,
});

describe('toOperationalState — the shared ladder', () => {
  it('calls nothing-blocked active', () => {
    assert.equal(toOperationalState(reading()).level, OperationalLevel.Active);
  });

  it('calls borrow-only borrowingDisabled — Blend On-Ice, K2 borrowing_enabled=false', () => {
    const state = toOperationalState(reading({ blocked: [PoolOperation.Borrow] }));
    assert.equal(state.level, OperationalLevel.BorrowingDisabled);
  });

  it('calls supply+borrow entryDisabled, and does NOT call it exitDisabled', () => {
    // This is the distinction the whole type exists for. Blend's Frozen blocks
    // supplying and borrowing while leaving withdrawals open, so a depositor can
    // still leave; calling that the same thing as K2's pause would be the single
    // most misleading output this module could produce.
    const state = toOperationalState(
      reading({ blocked: [PoolOperation.Supply, PoolOperation.Borrow] }),
    );
    assert.equal(state.level, OperationalLevel.EntryDisabled);
    assert.notEqual(state.level, OperationalLevel.ExitDisabled);
  });

  it('calls anything blocking withdrawals exitDisabled, whatever else it blocks', () => {
    // Withdraw is checked first precisely so it cannot be masked by the presence
    // of other blocked operations.
    const everything = toOperationalState(
      reading({
        blocked: [
          PoolOperation.Supply,
          PoolOperation.Withdraw,
          PoolOperation.Borrow,
          PoolOperation.Repay,
          PoolOperation.Liquidate,
        ],
      }),
    );
    assert.equal(everything.level, OperationalLevel.ExitDisabled);

    // Withdraw alone is not a state either protocol can produce, but the rule
    // must not depend on company: the ladder reads the operation, not the set.
    const alone = toOperationalState(reading({ blocked: [PoolOperation.Withdraw] }));
    assert.equal(alone.level, OperationalLevel.ExitDisabled);
  });

  it('lets neverOpened supersede the ladder rather than flattening into entryDisabled', () => {
    // Blend's Setup blocks exactly what its Frozen blocks, so without this the
    // two would be indistinguishable — and "never opened" is a different claim
    // from "restricted", not a more severe version of it.
    const state = toOperationalState(
      reading({ blocked: [PoolOperation.Supply, PoolOperation.Borrow], neverOpened: true }),
    );
    assert.equal(state.level, OperationalLevel.NotOperational);
  });

  it('publishes blocked in canonical order regardless of the order it was given', () => {
    // Two adapters reporting the same restriction must produce byte-identical
    // output, or a diff between them reads as a difference in state.
    const state = toOperationalState(
      reading({ blocked: [PoolOperation.Liquidate, PoolOperation.Borrow, PoolOperation.Supply] }),
    );
    assert.deepEqual(state.blocked, [
      PoolOperation.Supply,
      PoolOperation.Borrow,
      PoolOperation.Liquidate,
    ]);
  });

  it('deduplicates a repeated operation', () => {
    const state = toOperationalState(
      reading({ blocked: [PoolOperation.Borrow, PoolOperation.Borrow] }),
    );
    assert.deepEqual(state.blocked, [PoolOperation.Borrow]);
  });

  it('carries the reading through verbatim and stamps asOf as ISO', () => {
    const state = toOperationalState(
      reading({ source: 'PoolConfig.status = 4', origin: 'admin', detail: 'because' }),
    );
    assert.equal(state.source, 'PoolConfig.status = 4');
    assert.equal(state.origin, 'admin');
    assert.equal(state.detail, 'because');
    assert.equal(state.asOf, '2026-08-25T10:00:00.000Z');
  });
});

describe('mostRestrictive — reducing several readings to one', () => {
  const at = (level: OperationalLevel, source: string) => {
    const blocked: Record<OperationalLevel, PoolOperation[]> = {
      [OperationalLevel.Active]: [],
      [OperationalLevel.BorrowingDisabled]: [PoolOperation.Borrow],
      [OperationalLevel.EntryDisabled]: [PoolOperation.Supply, PoolOperation.Borrow],
      [OperationalLevel.ExitDisabled]: [PoolOperation.Withdraw],
      [OperationalLevel.NotOperational]: [PoolOperation.Supply],
    };
    return toOperationalState(
      reading({
        blocked: blocked[level],
        neverOpened: level === OperationalLevel.NotOperational,
        source,
      }),
    );
  };

  it('takes the worst, not the first or the most common', () => {
    // The K2 shape: an open router, three open reserves, one halted. Publishing
    // "active" here would say a market is fine while an asset in it is frozen.
    const worst = mostRestrictive([
      at(OperationalLevel.Active, 'router'),
      at(OperationalLevel.Active, 'usdc'),
      at(OperationalLevel.ExitDisabled, 'pyusd'),
      at(OperationalLevel.Active, 'xlm'),
    ]);
    assert.equal(worst.level, OperationalLevel.ExitDisabled);
    assert.equal(worst.source, 'pyusd');
  });

  it('keeps the first reading on a tie, so a global cause outranks a local one', () => {
    // A paused router also makes every reserve unusable. Both readings classify
    // the same, and "the router is paused" is the more informative of the two.
    const worst = mostRestrictive([
      at(OperationalLevel.ExitDisabled, 'router'),
      at(OperationalLevel.ExitDisabled, 'usdc'),
    ]);
    assert.equal(worst.source, 'router');
  });

  it('returns the single reading when there is only one', () => {
    assert.equal(mostRestrictive([at(OperationalLevel.Active, 'pool')]).source, 'pool');
  });

  it('throws on no readings rather than defaulting to active', () => {
    // "Nothing was read" is not "nothing is restricted". An adapter that
    // produced no reading has a bug, and publishing a clean bill of health from
    // it is the one failure mode this module must not have.
    assert.throws(() => mostRestrictive([]), /no operational readings/);
  });
});
