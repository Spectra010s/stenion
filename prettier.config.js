// @ts-check
//
// One Prettier config for the whole workspace. Prettier resolves config from the
// formatted file upwards, so every package inherits this — deliberately no
// per-package `.prettierrc` to keep formatting a single, non-negotiable setting.
//
// We run Prettier's defaults except for the two below, both of which just
// ratify what the codebase already did consistently before Prettier existed:

/** @type {import('prettier').Config} */
module.exports = {
  // 155 single-quoted imports vs 2 double-quoted at the time this was added, and
  // globals.css is single-quoted too. Matching the codebase, not the default.
  singleQuote: true,

  // The default 80 would re-wrap ~310 lines that were deliberately kept on one
  // line (single-line type literals, `return { ... }` objects, import lists),
  // while only ~88 lines exceeded 100. The prose in the root docs is hand-wrapped
  // at 100 as well. 100 preserves the existing shape; 80 would churn it.
  printWidth: 100,
};
