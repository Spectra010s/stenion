/**
 * Operational state — live, measured, published, and deliberately NOT scored.
 *
 * This is the third category of published data, alongside scored factors and
 * the static Findings notes (see CLAUDE.md). It exists because pause/frozen
 * state is a real, changing, on-chain reading that changes how a score should
 * be read, but which nothing on chain lets us grade. Issue #15 resolved that
 * tension by publishing it rather than scoring it; the full reasoning is in
 * METHODOLOGY.md, "Operational state is published, never scored".
 *
 * WHY THIS FILE IS NOT IN scoring.ts. `scoring.ts` is the shared *rulebook* —
 * every export in it feeds a factor value. Nothing here does, and nothing here
 * ever may: no function in this module is reachable from `scoreFactors`, and a
 * change to any of it cannot move a published number. Putting it beside the
 * rulebook would invite exactly the confusion the decision was made to avoid.
 *
 * WHY THESE ARE `as const` OBJECTS AND NOT `enum`s, unlike RiskFactorType. This
 * module is a leaf that tests import DIRECTLY (`./operational-state.ts`), and
 * Node's type-stripping loader rejects `enum` outright — it is a syntax that
 * emits code, not a type annotation it can erase. `RiskFactorType` gets away
 * with being an enum only because nothing imports `./types.ts` directly under
 * the test runner; reach for this shape in anything a test will load.
 *
 * WHAT IS SHARED AND WHAT IS NOT, on METHODOLOGY.md ground rule 1. The rule that
 * turns a set of blocked operations into a level lives here, once, so two
 * adapters cannot classify the same restriction two different ways. Reading
 * which operations a protocol has blocked is per-protocol input reading and
 * stays in the adapter, like every other raw read.
 */

/**
 * The operations a lending market can restrict, named by what a user is trying
 * to do rather than by any protocol's own method names.
 *
 * Deliberately a small closed set covering what a depositor or borrower can be
 * stopped from doing. It is NOT a complete list of every entry point either
 * protocol exposes — flash loans, auction bookkeeping and admin calls are all
 * omitted, because a state that blocks only those is not a state a reader of a
 * risk score needs to weigh.
 */
export const PoolOperation = {
  /** deposit into the market */
  Supply: 'supply',
  /** take a deposit back out — the one that decides whether funds are trapped */
  Withdraw: 'withdraw',
  Borrow: 'borrow',
  Repay: 'repay',
  /** third-party liquidation of an unhealthy position */
  Liquidate: 'liquidate',
} as const;
export type PoolOperation = (typeof PoolOperation)[keyof typeof PoolOperation];

/**
 * How restricted a market is, named by what is blocked rather than by any
 * protocol's own label.
 *
 * This is the whole reason a shared representation is possible at all. Blend
 * calls its states Active / On-Ice / Frozen / Setup across a seven-value `u32`;
 * K2 has a boolean plus four per-reserve bits. Those vocabularies do not map
 * onto each other — but "can a depositor still get out?" is the same question
 * for both, and it is the question that matters most. Mapping on the protocols'
 * own labels instead would put Blend's Frozen (withdrawals fine) and K2's paused
 * (withdrawals blocked) in the same bucket, which is the single most misleading
 * thing this type could do.
 */
export const OperationalLevel = {
  /** nothing restricted */
  Active: 'active',
  /** cannot borrow; supplying and withdrawing both work */
  BorrowingDisabled: 'borrowingDisabled',
  /** cannot borrow or supply — no new exposure — but existing positions can still exit */
  EntryDisabled: 'entryDisabled',
  /** cannot withdraw: funds cannot leave the market */
  ExitDisabled: 'exitDisabled',
  /** the market was never opened for use (Blend's Setup); nobody has funds in it */
  NotOperational: 'notOperational',
} as const;
export type OperationalLevel = (typeof OperationalLevel)[keyof typeof OperationalLevel];

/**
 * Who could have put the market in this state, as far as the chain says.
 *
 * Published because it is the closest on-chain data comes to the question the
 * score cannot answer — whether a restriction is an admin responding to a threat
 * or a mechanism reacting to one. It is NOT that answer, and must never be
 * presented as one: `protocol` says the protocol's own rules forced the state,
 * not that the state is bad; `admin` says a human chose it, not why.
 *
 * `indeterminate` is a real reading, not a gap. Blend's status 3 is settable
 * both by an admin and by the backstop update path, so the value genuinely does
 * not say which happened, and K2's boolean carries no origin at all.
 */
export type OperationalOrigin = 'admin' | 'protocol' | 'indeterminate';

/**
 * One market's operational state, as published on the API beside its score.
 *
 * Every field is a reading or a direct restatement of one. Nothing here is
 * graded, weighted, or combined into anything — see the module comment.
 */
export interface OperationalState {
  /** the shared classification; the only derived field, and derived by `toOperationalState` */
  level: OperationalLevel;
  /**
   * The protocol's OWN raw reading, verbatim, so a reader can check it against
   * the chain: `"PoolConfig.status = 4"`, `"router.is_paused() = true"`. Never a
   * Stenion label — that is what `level` is for.
   */
  source: string;
  /**
   * Exactly which operations the state blocks, as read from the protocol's own
   * gating logic. Carried explicitly rather than derived from `level` because
   * the two are not equivalent: Blend's Setup blocks supply and borrow while
   * still permitting withdrawals, which no point on the level ladder describes.
   */
  blocked: PoolOperation[];
  /** see OperationalOrigin — who could have set this, never why */
  origin: OperationalOrigin;
  /** what was read and what it means for a user, in one sentence */
  detail: string;
  /** when the reading was taken, ISO 8601 — a live state is only true as of an instant */
  asOf: string;
}

/**
 * Severity order, used only to reduce several readings into one market-level
 * state (`mostRestrictive`).
 *
 * It ranks how restricted a market is, NOT how risky it is — nothing in this
 * module ranks risk. `NotOperational` sits at the top because a market that
 * never opened is unusable in full, which is the most restricted thing a market
 * can be; that is not a claim that it is worse for a depositor than
 * `ExitDisabled`, because a market that never opened has no depositors to be
 * worse for. It also cannot arise from reducing reserve-level readings — only a
 * whole-market signal produces it — so it never actually competes on this ladder
 * in practice.
 */
const LEVEL_RANK: Record<OperationalLevel, number> = {
  [OperationalLevel.Active]: 0,
  [OperationalLevel.BorrowingDisabled]: 1,
  [OperationalLevel.EntryDisabled]: 2,
  [OperationalLevel.ExitDisabled]: 3,
  [OperationalLevel.NotOperational]: 4,
};

/** What an adapter reads; everything else on `OperationalState` is derived from it. */
export interface OperationalReading {
  /**
   * Every operation the protocol's own gating logic currently refuses. Order and
   * duplicates don't matter — the output is deduplicated and canonically ordered.
   */
  blocked: readonly PoolOperation[];
  /**
   * True only where the protocol publishes an explicit "not opened yet" state
   * (Blend's `status == 6`). Never inferred from emptiness, a zero balance, or
   * anything else: a market with nothing in it is an empty market, not an
   * unopened one, and the market-size floor already covers that case.
   */
  neverOpened: boolean;
  /** see OperationalState.source — the protocol's own reading, verbatim */
  source: string;
  origin: OperationalOrigin;
  detail: string;
  /** the fetch time the reading was taken at */
  asOf: Date;
}

/**
 * Canonical publication order for `blocked`, so two adapters reporting the same
 * restriction produce byte-identical output. Deliberately the order a user meets
 * them in — get in, get out, then the borrow-side operations — rather than
 * alphabetical, which would put `borrow` before `supply` for no reason.
 */
const ORDERED_OPERATIONS: readonly PoolOperation[] = [
  PoolOperation.Supply,
  PoolOperation.Withdraw,
  PoolOperation.Borrow,
  PoolOperation.Repay,
  PoolOperation.Liquidate,
];

/**
 * The shared classification rule, applied identically to every protocol.
 *
 * The ladder is checked from the most restrictive down, so a state that blocks
 * several things is named by the worst of them:
 *
 *   withdraw blocked  -> ExitDisabled      (funds cannot leave)
 *   supply blocked    -> EntryDisabled     (no new exposure, exit still open)
 *   borrow blocked    -> BorrowingDisabled
 *   nothing blocked   -> Active
 *
 * `neverOpened` supersedes all of it, because "this market was never opened" is
 * a different statement from "this market restricts X" and would otherwise be
 * flattened into `EntryDisabled` on Blend.
 *
 * Repay and Liquidate deliberately do not appear on the ladder even though they
 * are reportable in `blocked`. Neither has a rung of its own: on both protocols
 * every state that blocks them also blocks withdrawals, so a rung would be
 * unreachable — and inventing an unreachable rung would suggest a distinction
 * the chain does not draw. They stay in `blocked` because they are true and a
 * reader weighing a halted market should see that liquidations have stopped too.
 */
export function toOperationalState(reading: OperationalReading): OperationalState {
  const blocked = ORDERED_OPERATIONS.filter((op) => reading.blocked.includes(op));
  const level = reading.neverOpened
    ? OperationalLevel.NotOperational
    : blocked.includes(PoolOperation.Withdraw)
      ? OperationalLevel.ExitDisabled
      : blocked.includes(PoolOperation.Supply)
        ? OperationalLevel.EntryDisabled
        : blocked.includes(PoolOperation.Borrow)
          ? OperationalLevel.BorrowingDisabled
          : OperationalLevel.Active;

  return {
    level,
    source: reading.source,
    blocked,
    origin: reading.origin,
    detail: reading.detail,
    asOf: reading.asOf.toISOString(),
  };
}

/**
 * Reduce several readings to the one the market publishes: the most restricted.
 *
 * K2 gates per reserve as well as globally, so a market can be open in USDC and
 * halted in PYUSD. Publishing the *least* restricted reading would say a market
 * is fine while one of its assets is frozen; averaging is meaningless on a
 * categorical value. Taking the worst is the same convention every factor uses
 * for reserves, and for the same reason — the binding constraint is what a
 * reader needs.
 *
 * Ties keep the FIRST reading, so a caller that puts the market-wide reading
 * ahead of the per-reserve ones gets the market-wide `source` and `detail` when
 * both say the same thing. That is the more informative of two identical
 * classifications: "the router is paused" tells a reader more than "PYUSD is
 * paused" when both are true.
 *
 * Throws on an empty list rather than inventing an Active default — "no readings
 * at all" is not "nothing is restricted", and an adapter that produced none has
 * a bug that must not be published as a clean bill of health.
 */
export function mostRestrictive(states: readonly OperationalState[]): OperationalState {
  if (states.length === 0) {
    throw new Error('mostRestrictive: no operational readings — cannot infer a state');
  }
  let worst = states[0];
  for (const state of states.slice(1)) {
    if (LEVEL_RANK[state.level] > LEVEL_RANK[worst.level]) worst = state;
  }
  return worst;
}
