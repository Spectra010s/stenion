import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DRIFT_PX_PER_SEC,
  MAX_FRAME_MS,
  copiesPerSet,
  frameDelta,
  nextOffset,
  wrapOffset,
} from './carousel.ts';

// The invariant these tests exist for: at every offset the marquee can reach,
// the visible window must be fully covered by rendered cards. Two sets are
// rendered and the offset wraps at one set's width, so that reduces to
// `setWidth >= viewportWidth` — which is exactly what `copiesPerSet` has to
// guarantee, at any card width and any number of protocols.
describe('copiesPerSet', () => {
  it('repeats the list until one set covers the viewport', () => {
    // 4 protocols x 320px = 1280px of cards on a 1216px content column: one
    // copy already covers it.
    assert.equal(copiesPerSet(1280, 1216), 1);
    // Same four cards on a 375px phone: still one copy.
    assert.equal(copiesPerSet(1280, 335), 1);
    // Two protocols on a desktop — 640px of cards under a 1216px column needs
    // two copies, which is the case a hardcoded "render it twice" gets wrong.
    assert.equal(copiesPerSet(640, 1216), 2);
    // One narrow protocol on a wide screen.
    assert.equal(copiesPerSet(320, 1600), 5);
  });

  it('guarantees the covering invariant for any width pair', () => {
    for (const base of [120, 320, 640, 1280, 3000]) {
      for (const viewport of [335, 430, 768, 1216, 1920, 2560]) {
        const setWidth = base * copiesPerSet(base, viewport);
        assert.ok(
          setWidth >= viewport,
          `set ${setWidth} must cover viewport ${viewport} (base ${base})`,
        );
      }
    }
  });

  it('never returns less than one copy, including on unmeasured elements', () => {
    // Both widths are 0 on the first paint / in tests with no layout.
    assert.equal(copiesPerSet(0, 0), 1);
    assert.equal(copiesPerSet(0, 1216), 1);
    assert.equal(copiesPerSet(1280, 0), 1);
    assert.equal(copiesPerSet(Number.NaN, 1216), 1);
  });
});

describe('wrapOffset', () => {
  it('keeps the offset inside one set', () => {
    assert.equal(wrapOffset(0, 1280), 0);
    assert.equal(wrapOffset(1279.5, 1280), 1279.5);
    // The wrap is a subtraction, not a reset to 0 — the fractional remainder is
    // what makes the seam invisible. Snapping to 0 would drop up to a frame of
    // travel and show as a stutter every lap.
    assert.equal(wrapOffset(1280, 1280), 0);
    assert.ok(Math.abs(wrapOffset(1280.4, 1280) - 0.4) < 1e-9);
  });

  it('wraps backwards too, for a user dragging right past the start', () => {
    assert.equal(wrapOffset(-1, 1280), 1279);
    assert.equal(wrapOffset(-1280, 1280), 0);
  });

  it('degrades to a clamp when the set has not been measured', () => {
    assert.equal(wrapOffset(42, 0), 42);
    assert.equal(wrapOffset(-42, 0), 0);
  });
});

describe('frameDelta', () => {
  it('is zero on the first frame, when there is nothing to measure from', () => {
    assert.equal(frameDelta(1000, null), 0);
  });

  it('passes a normal frame through', () => {
    assert.ok(Math.abs(frameDelta(1016.7, 1000) - 16.7) < 1e-9);
  });

  it('caps the frame after a backgrounded tab', () => {
    assert.equal(frameDelta(1000 + 60_000, 1000), MAX_FRAME_MS);
  });

  it('ignores a non-advancing clock', () => {
    assert.equal(frameDelta(1000, 1000), 0);
    assert.equal(frameDelta(999, 1000), 0);
  });
});

describe('nextOffset', () => {
  it('advances by speed x time', () => {
    assert.equal(nextOffset(0, 1000, 10_000, 34), 34);
    assert.ok(Math.abs(nextOffset(0, 500, 10_000, 34) - 17) < 1e-9);
  });

  it('crosses the seam without losing the remainder', () => {
    assert.ok(Math.abs(nextOffset(1279, 1000, 1280, 34) - 33) < 1e-9);
  });

  it('drifts slowly enough to read', () => {
    assert.ok(DRIFT_PX_PER_SEC >= 20 && DRIFT_PX_PER_SEC <= 45);
  });
});
