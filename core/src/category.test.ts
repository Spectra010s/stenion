// Tests for the protocol-category registry.
//
// WHY THESE EXIST. `PROTOCOL_CATEGORIES` and `METHODOLOGY_VERSIONS` are two
// lists that have to stay in step, and the compiler only half-enforces it: the
// `satisfies Record<ProtocolCategory, number>` catches a category with no
// version, but nothing catches a version that is nonsense (0, 1.5, negative), and
// nothing states in a runnable form the property the whole design rests on —
// that every category's counter starts at 1 and runs independently.
//
// The other half of why: this file is the proof that the registry is
// VALUE-importable under `node --test`. That is not incidental. It is the entire
// reason `category.ts` is a separate module from `types.ts` — `types.ts` holds
// `export enum RiskFactorType`, and Node's strip-only loader refuses to load a
// file containing an `enum` at all (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`), which
// is why `scoring.test.ts` has to regex that enum out of source rather than
// import it. If someone moves these constants back into `types.ts`, this file
// stops running — loudly, at import time.
//
// Run with: pnpm --filter @stenion/core test

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';

// A VALUE import, deliberately — see the header. Type-only would prove nothing.
import { METHODOLOGY_VERSIONS, PROTOCOL_CATEGORIES } from './category.ts';

/** Walk up from the test's cwd to find a repo file, so this works from any package dir. */
function repoFile(name: string): string {
  let dir = process.cwd();
  for (;;) {
    const candidate = resolve(dir, name);
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`could not find ${name} walking up from ${process.cwd()}`);
    dir = parent;
  }
}

describe('the category registry', () => {
  it('is value-importable under the test runner', () => {
    // If `category.ts` ever moves back into `types.ts`, this file throws on
    // import and every test in it fails at once. That is the intended alarm.
    assert.ok(Array.isArray(PROTOCOL_CATEGORIES));
    assert.equal(typeof METHODOLOGY_VERSIONS, 'object');
  });

  it('contains exactly the categories that have a published rulebook', () => {
    // ONE today. This assertion is not busywork: it is the thing that makes
    // adding a category a deliberate act with a failing test attached, rather
    // than a one-word edit that silently widens what the platform claims to
    // score. Adding a member here without a METHODOLOGY.md section for it is
    // the failure mode TAXONOMY.md (#79) exists to prevent.
    assert.deepEqual([...PROTOCOL_CATEGORIES], ['lending']);
  });

  it('has no duplicate members', () => {
    assert.equal(
      new Set(PROTOCOL_CATEGORIES).size,
      PROTOCOL_CATEGORIES.length,
      'a duplicated category would give one rulebook two entries in every Record keyed by it',
    );
  });

  it('gives every category a methodology version', () => {
    // `satisfies` already catches a missing key at compile time. This catches
    // the runtime shape too, which is what the indexer actually indexes into —
    // and a lookup that returns undefined would stamp `undefined` into
    // risk_scores.methodology_version, violating the NOT NULL half of
    // risk_scores_methodology_version_shape at the end of a whole cycle's work.
    for (const category of PROTOCOL_CATEGORIES) {
      const version = METHODOLOGY_VERSIONS[category];
      assert.equal(typeof version, 'number', `${category} has no methodology version`);
      assert.ok(Number.isInteger(version), `${category}'s version ${version} is not an integer`);
      assert.ok(version >= 1, `${category}'s version ${version} is below 1; counters start at 1`);
    }
  });

  it('carries no version for a category that does not exist', () => {
    // The mirror of the test above. A stale entry left behind by a removed
    // category is a rulebook version with no rulebook — harmless until someone
    // reads the map to answer "what do we score", which is exactly what the
    // registry is for.
    const categories = new Set<string>(PROTOCOL_CATEGORIES);
    for (const key of Object.keys(METHODOLOGY_VERSIONS)) {
      assert.ok(categories.has(key), `METHODOLOGY_VERSIONS has '${key}', which is not a category`);
    }
  });

  it('keeps lending at 1 — splitting the scalar was not a methodology change', () => {
    // The load-bearing assertion of this whole issue. Replacing the scalar
    // METHODOLOGY_VERSION with a per-category map moved no formula, threshold or
    // weight, so lending's stored history stays comparable straight across the
    // change and its counter must NOT have advanced. A 2 here would silently
    // claim every score before this refactor is incomparable with every score
    // after it, which would be false — and unrepairable, since risk_scores keeps
    // only outputs and no row can be recomputed to check.
    assert.equal(METHODOLOGY_VERSIONS.lending, 1);
  });

  it('agrees with the version METHODOLOGY.md publishes for lending', () => {
    // Code and METHODOLOGY.md are not allowed to drift (CLAUDE.md). The doc's
    // changelog table has a **1** row for the five-factor model; this asserts the
    // constant still matches it, reading the doc rather than restating it — the
    // same approach scoring.test.ts takes, and for the same reason: a test that
    // hardcodes the doc's number is a third copy to keep in sync.
    const doc = repoFile('METHODOLOGY.md');
    const versions = [...doc.matchAll(/^\|\s*\*\*(\d+)\*\*\s*\|/gm)].map((m) => Number(m[1]));
    assert.ok(
      versions.length > 0,
      'could not parse the methodology version changelog out of METHODOLOGY.md — has its format changed?',
    );
    assert.equal(
      Math.max(...versions),
      METHODOLOGY_VERSIONS.lending,
      "METHODOLOGY.md's newest published version differs from METHODOLOGY_VERSIONS.lending",
    );
  });
});
