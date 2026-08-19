// Single source of truth for outbound/site-level constants so they're changed
// in one place.
export const GITHUB_URL = 'https://github.com/stenion-lab/stenion';
export const METHODOLOGY_SOURCE_URL = `${GITHUB_URL}/blob/main/METHODOLOGY.md`;
export const API_DOCS_SOURCE_URL = `${GITHUB_URL}/blob/main/API.md`;

/**
 * Repo-root markdown files that are ALSO rendered as a route on this site,
 * mapped to that route.
 *
 * Used by MarkdownDoc to keep a cross-reference between two rendered docs on the
 * site instead of bouncing the reader out to raw markdown on GitHub. Only add a
 * file here once it actually has a route — an entry for a file we don't render
 * produces a 404 that the GitHub fallback would not have.
 */
export const RENDERED_DOC_ROUTES: Record<string, string> = {
  'METHODOLOGY.md': '/methodology',
  'API.md': '/docs/api',
};

/**
 * The header/footer nav.
 *
 * API is a TOP-LEVEL item rather than a "Docs" group holding it and Methodology.
 * Five items still fit the bar, and the two candidates for grouping are the two
 * things people come here to find: Methodology is the differentiator (the public
 * rulebook), and API is the whole pitch to integrators. Filing both under a
 * generic "Docs" label hides them behind an extra click and a word that says
 * nothing. The URL is still nested — `/docs/api`, so adapter-authoring docs can
 * land at `/docs/*` later without moving this one — but the nesting doesn't have
 * to surface in the nav.
 */
export const NAV_LINKS = [
  { href: '/', label: 'Home' },
  { href: '/registry', label: 'Registry' },
  { href: '/methodology', label: 'Methodology' },
  { href: '/docs/api', label: 'API' },
  { href: '/about', label: 'About' },
] as const;
