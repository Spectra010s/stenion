/**
 * The marquee's arithmetic, kept out of the component so the seamlessness is a
 * property that can be asserted rather than a thing you squint at in a browser.
 *
 * THE SHAPE THIS DESCRIBES. The carousel renders the protocol list twice
 * back-to-back — set A, then an identical set B — inside a natively scrollable
 * container, and drives `scrollLeft` forward. When the offset reaches one set's
 * width it is wrapped back to zero: the pixels then under the viewport are
 * byte-identical to the ones that were there a frame earlier, because set B's
 * head is the same markup as set A's head. That is the whole trick, and it only
 * holds while ONE SET IS AT LEAST AS WIDE AS THE VIEWPORT — otherwise the wrap
 * point sits inside the visible region and the reader sees the jump. With four
 * protocols on a desktop that is not automatic, so `copiesPerSet` computes it
 * from measured widths rather than from a hardcoded card count.
 */

/**
 * How many times the protocol list must be repeated INSIDE one set so that a
 * set covers the viewport (see the wrap invariant above).
 *
 * Deliberately driven by measured pixels, not by `protocols.length`: the card
 * width is a breakpoint thing and the list grows over time, so any rule stated
 * in cards would be a rule that is right at one width and one registry size.
 */
export function copiesPerSet(baseListWidth: number, viewportWidth: number): number {
  if (!Number.isFinite(baseListWidth) || baseListWidth <= 0) return 1;
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return 1;
  return Math.max(1, Math.ceil(viewportWidth / baseListWidth));
}

/** Normalize a scroll offset into `[0, setWidth)` — the wrap itself. */
export function wrapOffset(pos: number, setWidth: number): number {
  if (!Number.isFinite(pos)) return 0;
  if (!Number.isFinite(setWidth) || setWidth <= 0) return Math.max(0, pos);
  const wrapped = pos % setWidth;
  // `+ 0` normalizes the -0 that a negative exact multiple produces, so callers
  // comparing the offset against the live `scrollLeft` don't see a difference
  // that isn't one.
  return (wrapped < 0 ? wrapped + setWidth : wrapped) + 0;
}

/**
 * Cap on a single frame's delta.
 *
 * A backgrounded tab stops firing rAF, so the first frame after returning can
 * carry minutes of elapsed time. Uncapped, that is a single 10,000px jump —
 * which, because the offset wraps, is not even a scroll: it is a teleport to an
 * arbitrary point in the loop. 50ms (~3 frames) keeps a genuinely slow frame
 * looking continuous and turns a tab-switch into a barely visible nudge.
 */
export const MAX_FRAME_MS = 50;

export function frameDelta(nowMs: number, lastMs: number | null): number {
  if (lastMs === null || !Number.isFinite(nowMs) || !Number.isFinite(lastMs)) return 0;
  const dt = nowMs - lastMs;
  if (dt <= 0) return 0;
  return Math.min(dt, MAX_FRAME_MS);
}

/** Speed of the drift, px/sec. Slow enough to read a card without chasing it. */
export const DRIFT_PX_PER_SEC = 34;

/** One frame of drift: current offset in, next offset out, already wrapped. */
export function nextOffset(pos: number, dtMs: number, setWidth: number, speed = DRIFT_PX_PER_SEC) {
  return wrapOffset(pos + (speed * dtMs) / 1000, setWidth);
}
