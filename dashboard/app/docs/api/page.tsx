import type { Metadata } from 'next';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ExternalLink, FileWarning } from 'lucide-react';
import { MarkdownDoc } from '../../../components/markdown-doc';
import { API_DOCS_SOURCE_URL } from '../../lib/site';
import { Reveal } from '../../../components/reveal';

export const metadata: Metadata = {
  title: 'API',
  description:
    'The free, public, read-only Stenion API: two endpoints, live examples, the ok/failed history union, the staleness model, and rate limits.',
};

// Same shape as /methodology: the doc lives at the repo root as the single
// source of truth (it's what a developer lands on first from the README, and
// GitHub renders it), and this route renders that same file rather than keeping
// a second copy in the app. next.config pins outputFileTracingRoot to the repo
// root and includes API.md for this route, so it's in the serverless bundle.
async function loadApiDocs(): Promise<string | null> {
  try {
    const p = path.join(process.cwd(), '..', 'API.md');
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}

export default async function ApiDocsPage() {
  const source = await loadApiDocs();

  return (
    <div className="mx-auto max-w-3xl px-5 py-14">
      <Reveal>
        <span className="text-xs font-medium uppercase tracking-[0.18em] text-muted">
          For integrators
        </span>
        <h1 className="mt-5 font-display text-4xl font-semibold tracking-tight text-ink">
          Public API
        </h1>
        <p className="mt-3 text-muted">
          Two read-only endpoints, no key, open CORS. Every example below is a verbatim capture from
          the live production API — not written from the types — so the shapes are checkable rather
          than merely plausible. The data is free and stays free.
        </p>
        <a
          href={API_DOCS_SOURCE_URL}
          target="_blank"
          rel="noreferrer"
          className="mt-5 inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-4 py-2 text-sm text-ink transition-colors hover:border-accent"
        >
          View source on GitHub <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </Reveal>

      <Reveal delay={0.08} className="mt-12">
        {source ? (
          <MarkdownDoc source={source} />
        ) : (
          <div className="rounded-xl border border-danger/25 bg-danger/5 p-8 text-center">
            <FileWarning className="mx-auto h-8 w-8 text-danger" />
            <h2 className="mt-4 font-display text-lg font-semibold text-ink">
              Couldn&apos;t load the API docs
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted">
              The rendered copy is temporarily unavailable. You can always read the canonical source
              on GitHub.
            </p>
            <a
              href={API_DOCS_SOURCE_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-5 inline-flex items-center gap-1.5 text-sm text-accent-ink hover:underline"
            >
              Open API.md <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        )}
      </Reveal>
    </div>
  );
}
