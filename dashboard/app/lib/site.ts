// Single source of truth for outbound/site-level constants so they're changed
// in one place.
export const GITHUB_URL = 'https://github.com/stenion-lab/stenion';
export const METHODOLOGY_SOURCE_URL = `${GITHUB_URL}/blob/main/METHODOLOGY.md`;

export const NAV_LINKS = [
  { href: '/', label: 'Home' },
  { href: '/registry', label: 'Registry' },
  { href: '/methodology', label: 'Methodology' },
  { href: '/about', label: 'About' },
] as const;
