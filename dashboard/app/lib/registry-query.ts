// The registry's search, filter and sort — the whole of it, as pure functions.
//
// WHY IT IS A MODULE AND NOT INLINE IN THE PAGE. The rule this code exists to
// enforce is not a rendering detail: an unscored entry must never appear inside
// the ranked ordering, because a row's POSITION reads as a position no matter
// what its score column says. That rule is enforceable in a test only if the
// ordering is a value someone can assert on, rather than JSX. Everything the
// page renders comes out of buildRegistryView, so "does an unscored entry ever
// land inside the ranked list" is a question with an answer.
//
// STATE LIVES IN THE URL, never in a component. A filtered or searched view has
// to be linkable and survive a reload, so these functions parse from and build
// back to query params, and the page is a Server Component that re-renders from
// them. The client control (components/registry-controls.tsx) only pushes new
// params; it never filters a list it is holding. That ordering matters for more
// than links: every reason, status and summary stays in the server-rendered
// HTML, which is how find-in-page and search indexing reach an entry at all.
//
// THIS MODULE IS A LEAF in the sense CLAUDE.md means: its only imports are
// TYPE-ONLY, so type stripping erases them and its test resolves no relative
// import graph. Keep it that way — a value import from ./coverage would make
// this file untestable under `node --test` without an extension dance.

import type { LeaderboardEntry } from './contract';
import type { CoverageEntry, CoverageStatus } from './coverage';

/**
 * The three orderings, and the reason there are only three.
 *
 * `score-desc` is the registry's actual claim — protocols ranked by on-chain
 * safety, payment-blind. `score-asc` is the same claim read from the other end.
 * `name` is not a ranking at all, which is precisely why it is the one ordering
 * allowed to merge scored and unscored entries into a single list.
 */
export const REGISTRY_SORTS = ['score-desc', 'score-asc', 'name'] as const;
export type RegistrySort = (typeof REGISTRY_SORTS)[number];

/**
 * Score, high to low.
 *
 * The default is the ranking because the ranking is what the registry IS — the
 * one thing it promises is an order derived purely from on-chain data that no
 * protocol can pay to move. Making that an opt-in view, behind any other
 * default, would quietly demote the product's only claim to a display option.
 */
export const DEFAULT_SORT: RegistrySort = 'score-desc';

/**
 * `all`, the two kinds, or one specific coverage status.
 *
 * One parameter rather than several, because these are mutually exclusive
 * facets of a single question ("what am I looking at"), and two independent
 * controls that can contradict each other produce empty result sets nobody
 * asked for. A coverage status implies not-scored, so it needs no companion.
 *
 * Note that `scored` means "in the ranked registry", which includes an entry
 * whose latest run never produced a number — see partitionScored. That entry is
 * OUR pipeline not having got there, and it belongs with the protocols we track
 * rather than with the ones we decided not to score. The UI labels the two
 * options accordingly: "Scored" and "Assessed, not scored".
 */
export type RegistryStatusFilter = 'all' | 'scored' | 'not-scored' | CoverageStatus;

export const DEFAULT_STATUS: RegistryStatusFilter = 'all';

/** Query strings longer than this are a paste accident or an attack, not a search. */
const MAX_QUERY = 64;

/** What Next hands a Server Component for one search param. */
export type RawParam = string | string[] | undefined;

export interface RegistryParams {
  q: string;
  status: RegistryStatusFilter;
  sort: RegistrySort;
}

/** First value only — a repeated `?q=a&q=b` is malformed input, not a multi-search. */
function firstOf(raw: RawParam): string {
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
}

/**
 * Read the three params, falling back to the defaults for anything absent or
 * unrecognised.
 *
 * Unrecognised values fall back SILENTLY rather than 404ing: these params are
 * typed by hand and pasted between people, and a stale `?sort=score` from an
 * older link should show the registry, not an error page. The canonical URL is
 * restored by registryHref, which omits defaults.
 *
 * `coverageStatuses` is passed in rather than imported so this module keeps its
 * type-only import graph. It is the set actually present in the published
 * entries, which also means a status with no members can't be selected — the
 * same rule as groupCoverage dropping empty groups.
 */
export function parseRegistryParams(
  raw: { q?: RawParam; status?: RawParam; sort?: RawParam },
  coverageStatuses: readonly string[],
): RegistryParams {
  const sortRaw = firstOf(raw.sort);
  const statusRaw = firstOf(raw.status);
  const valid: readonly string[] = ['all', 'scored', 'not-scored', ...coverageStatuses];

  return {
    q: firstOf(raw.q).trim().slice(0, MAX_QUERY),
    status: valid.includes(statusRaw) ? (statusRaw as RegistryStatusFilter) : DEFAULT_STATUS,
    sort: (REGISTRY_SORTS as readonly string[]).includes(sortRaw)
      ? (sortRaw as RegistrySort)
      : DEFAULT_SORT,
  };
}

/**
 * A linkable URL for a set of params, with defaults omitted.
 *
 * Omitting defaults is what keeps `/registry` the canonical address of the
 * registry: the unfiltered ranked view has one URL rather than three spellings
 * of itself, so a shared link, a bookmark and the nav item all agree.
 */
export function registryHref(params: Partial<RegistryParams>): string {
  const search = new URLSearchParams();
  const q = params.q?.trim() ?? '';
  if (q) search.set('q', q);
  if (params.status && params.status !== DEFAULT_STATUS) search.set('status', params.status);
  if (params.sort && params.sort !== DEFAULT_SORT) search.set('sort', params.sort);
  const qs = search.toString();
  return qs ? `/registry?${qs}` : '/registry';
}

/**
 * Fold a string to something two spellings of the same name can be compared on:
 * lowercase, diacritics stripped, every run of non-alphanumerics collapsed to a
 * single space.
 *
 * The punctuation collapse is what makes an id searchable by its display name —
 * "k2 earn" and "K2-Earn" both fold to `k2 earn`, so someone typing what they
 * see finds the entry whose slug is hyphenated.
 */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Does this entry match the query? Substring, over name and id.
 *
 * DELIBERATELY NOT matched: `deployedOn.host`. Searching "blend" and being
 * handed YieldBlox is useful, but a row that appears with no visible reason for
 * matching implies YieldBlox IS Blend — the exact thing the deployment label
 * exists to deny. It earns its place when the row can say why it matched, not
 * before.
 */
export function matchesQuery(entry: { id: string; name: string }, q: string): boolean {
  const needle = fold(q);
  if (!needle) return true;
  return fold(entry.name).includes(needle) || fold(entry.id).includes(needle);
}

/** Case-insensitive display-name order, stable across locales we render in. */
function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
}

/**
 * Split the leaderboard into entries that have a number and entries that don't.
 *
 * THE THIRD STATE. A `protocols` row with `safetyScore: null` is not a coverage
 * decision and not a low score: it is our pipeline not having produced a number
 * yet. It cannot sit inside the ranked ordering (there is nothing to rank it
 * on) and it must not be folded in with the coverage entries (that would undo
 * the whole separation coverage.ts exists for), so it gets its own block
 * between them.
 */
export function partitionScored(entries: readonly LeaderboardEntry[]): {
  ranked: LeaderboardEntry[];
  pending: LeaderboardEntry[];
} {
  return {
    ranked: entries.filter((e) => e.safetyScore !== null),
    pending: entries.filter((e) => e.safetyScore === null),
  };
}

/**
 * Order the entries that actually carry a score. Ties break by name so the list
 * is stable between runs — two protocols on the same number should not swap
 * places because the database returned them in a different order.
 */
export function sortRanked(
  entries: readonly LeaderboardEntry[],
  sort: RegistrySort,
): LeaderboardEntry[] {
  const rows = [...entries];
  if (sort === 'name') return rows.sort(byName);
  const dir = sort === 'score-asc' ? 1 : -1;
  return rows.sort((a, b) => {
    const delta = ((a.safetyScore ?? 0) - (b.safetyScore ?? 0)) * dir;
    return delta !== 0 ? delta : byName(a, b);
  });
}

/** A row in the merged, alphabetical view — tagged, because the two render differently. */
export type RegistryRow =
  { kind: 'scored'; entry: LeaderboardEntry } | { kind: 'coverage'; entry: CoverageEntry };

export interface RegistryView {
  /**
   * `ranked` renders three separated blocks; `alphabetical` renders one merged
   * list. The distinction is load-bearing rather than cosmetic — see `merged`.
   */
  mode: 'ranked' | 'alphabetical';
  /** scored entries carrying a number, in the requested order */
  ranked: LeaderboardEntry[];
  /** tracked protocols with no score yet — never inside `ranked` */
  pending: LeaderboardEntry[];
  /** coverage entries that survived the filter, always by name */
  coverage: CoverageEntry[];
  /**
   * Every surviving row in one alphabetical list — populated ONLY in
   * `alphabetical` mode, and empty otherwise.
   *
   * Merging is safe here and nowhere else: alphabetical order asserts nothing
   * about quality, so an unscored entry sitting between two scored ones is not
   * being ranked below either. Under a score sort the same list would be a
   * ranking claim about entries that have no score, which is the one thing this
   * page may not do.
   */
  merged: RegistryRow[];
  /**
   * Whether a position numeral may be rendered at all.
   *
   * True only under `score-desc`. Under `score-asc` the first row is the LOWEST
   * score, so printing "01" beside it asserts a rank that is the reverse of the
   * truth; under `name` the position is alphabetical and means nothing. In both
   * cases the column is removed rather than blanked — a dash in a rank column is
   * the same ambiguity as a dash in a score column.
   */
  showRank: boolean;
  counts: { ranked: number; pending: number; coverage: number; total: number };
}

/**
 * Everything the page renders, derived from the live board, the published
 * coverage entries, and the three URL params.
 *
 * `protocols` is already deduped against coverage by the caller
 * (coverageToPublish), so an entry that has since been scored cannot arrive
 * here twice.
 */
export function buildRegistryView(
  protocols: readonly LeaderboardEntry[],
  coverage: readonly CoverageEntry[],
  params: RegistryParams,
): RegistryView {
  const { q, status, sort } = params;

  const wantsScored = status === 'all' || status === 'scored';
  const wantsCoverage = status !== 'scored';

  const matchedProtocols = wantsScored ? protocols.filter((p) => matchesQuery(p, q)) : [];
  const matchedCoverage = wantsCoverage
    ? coverage.filter(
        (c) =>
          matchesQuery(c, q) &&
          (status === 'all' || status === 'not-scored' || c.status === status),
      )
    : [];

  const { ranked, pending } = partitionScored(matchedProtocols);
  const sortedRanked = sortRanked(ranked, sort);
  // Pending rows are name-ordered in every mode. There is no score to sort them
  // by, and reversing them under score-asc would imply the order meant
  // something.
  const sortedPending = [...pending].sort(byName);
  const sortedCoverage = [...matchedCoverage].sort(byName);

  const mode = sort === 'name' ? 'alphabetical' : 'ranked';
  const merged: RegistryRow[] =
    mode === 'alphabetical'
      ? [
          ...sortedRanked.map((entry) => ({ kind: 'scored' as const, entry })),
          ...sortedPending.map((entry) => ({ kind: 'scored' as const, entry })),
          ...sortedCoverage.map((entry) => ({ kind: 'coverage' as const, entry })),
        ].sort((a, b) => byName(a.entry, b.entry))
      : [];

  return {
    mode,
    ranked: sortedRanked,
    pending: sortedPending,
    coverage: sortedCoverage,
    merged,
    showRank: sort === 'score-desc',
    counts: {
      ranked: sortedRanked.length,
      pending: sortedPending.length,
      coverage: sortedCoverage.length,
      total: sortedRanked.length + sortedPending.length + sortedCoverage.length,
    },
  };
}
