import type { Metadata } from 'next';
import Link from 'next/link';
import { Compass } from 'lucide-react';

// Without this the 404 falls back to the root layout's `default` title, which
// reads as if the page loaded fine. Renders through the layout's '%s · Stenion'
// template. This covers every notFound() — an unknown /protocol/:id as well as
// an unrouted path — so it stays generic rather than protocol-specific.
export const metadata: Metadata = {
  title: 'Not found',
};

export default function NotFound() {
  return (
    <div className="mx-auto grid max-w-2xl place-items-center px-5 py-28 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-accent/10 ring-1 ring-inset ring-accent/20">
        <Compass className="h-7 w-7 text-accent" />
      </div>
      <h1 className="mt-6 font-display text-5xl font-semibold tracking-tight text-ink">404</h1>
      <p className="mt-3 text-muted">That page — or protocol — isn&apos;t part of the registry.</p>
      <div className="mt-8 flex gap-3">
        <Link
          href="/"
          className="rounded-lg bg-gradient-to-r from-accent to-accent-2 px-5 py-2.5 text-sm font-semibold text-bg transition-transform hover:-translate-y-0.5"
        >
          Back home
        </Link>
        <Link
          href="/registry"
          className="rounded-lg border border-line bg-surface/60 px-5 py-2.5 text-sm font-medium text-ink hover:border-accent/40"
        >
          View the registry
        </Link>
      </div>
    </div>
  );
}
