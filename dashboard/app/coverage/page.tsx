// `/coverage` with no id.
//
// There is no separate index page for coverage entries: the registry IS the
// index, and building a second list of the same entries would create two places
// a reader could be looking at when they say "the list" — and two places to
// keep in step. So this redirects to the registry, pre-filtered to exactly the
// entries someone typing this URL was after.
//
// It exists because people will type it. A 404 for a path that is obviously
// meaningful — every /coverage/<id> page links back into this space — teaches a
// reader the URL structure is unreliable, which is the opposite of what "the URL
// is the disclaimer" is trying to buy.
//
// A permanent redirect would be wrong: this is a convenience alias, not a moved
// page, and `redirect()`'s default 307 leaves the choice open if /coverage ever
// becomes a real page.

import { redirect } from 'next/navigation';

import { registryHref } from '../lib/registry-query';

export default function CoverageIndexPage() {
  redirect(registryHref({ status: 'not-scored' }));
}
