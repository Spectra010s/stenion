// Homepage loading skeleton. It lives in the (home) route group — which does not
// affect the URL, this is still `/` — rather than at app/loading.tsx, because a
// root loading.tsx wraps EVERY route in a Suspense boundary. That boundary made
// /protocol/<unknown-id> return a soft-404 (correct not-found UI, but HTTP 200,
// because the shell flushes before the page can call notFound()). Scoping it to
// the group keeps this skeleton for the homepage without imposing a boundary on
// the protocol detail route. It was also homepage-shaped anyway, so /about and
// /methodology were showing a hero-and-cards skeleton that never matched them.

import { Skeleton } from '../../components/skeleton';

export default function HomeLoading() {
  return (
    <div className="mx-auto max-w-6xl px-5 pb-20 pt-20 sm:pt-28">
      <Skeleton className="h-6 w-72 rounded-full" />
      <Skeleton className="mt-6 h-14 w-full max-w-3xl" />
      <Skeleton className="mt-3 h-14 w-2/3 max-w-2xl" />
      <Skeleton className="mt-6 h-24 w-full max-w-xl" />
      <div className="mt-9 flex gap-3">
        <Skeleton className="h-11 w-44 rounded-lg" />
        <Skeleton className="h-11 w-40 rounded-lg" />
      </div>

      <div className="mt-20 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-36 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
