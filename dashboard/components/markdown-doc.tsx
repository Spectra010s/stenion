import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { GITHUB_URL } from '../app/lib/site';

const REPO_BLOB = `${GITHUB_URL}/blob/main`;

/** Flatten React children to a plain string (for deriving heading anchor ids). */
function toText(node: React.ReactNode): string {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(toText).join('');
  if (typeof node === 'object' && 'props' in node) {
    return toText((node as { props: { children?: React.ReactNode } }).props.children);
  }
  return '';
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

// react-markdown gives no heading ids and leaves links repo-relative. We add
// slug ids (so the doc's own in-page anchors work) and rewrite relative links to
// the GitHub source (so file references like `adapters/blend.ts` resolve).
const components: Components = {
  h1: ({ children }) => <h1 id={slug(toText(children))}>{children}</h1>,
  h2: ({ children }) => <h2 id={slug(toText(children))}>{children}</h2>,
  h3: ({ children }) => <h3 id={slug(toText(children))}>{children}</h3>,
  // h4 too: METHODOLOGY.md's per-factor sub-sections are h4s and are linked to
  // from elsewhere in the doc. Without an id those anchors work on GitHub and
  // silently dead-end on the site.
  h4: ({ children }) => <h4 id={slug(toText(children))}>{children}</h4>,
  // METHODOLOGY.md has several wide multi-column tables. A prose table is
  // width:100%, but its min-content width is set by its longest cell, so on a
  // narrow screen the table sets a floor on the page width and scrolls the whole
  // document sideways. Give each table its own horizontal scroll container.
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
  a: ({ href, children }) => {
    const h = href ?? '';
    if (h.startsWith('#')) return <a href={h}>{children}</a>;
    const url = /^https?:\/\//.test(h) ? h : `${REPO_BLOB}/${h.replace(/^\.?\//, '')}`;
    return (
      <a href={url} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  },
};

/** Render a markdown string with the Stenion dark prose theme. */
export function MarkdownDoc({ source }: { source: string }) {
  return (
    <div className="prose prose-stenion max-w-none prose-headings:font-display prose-headings:tracking-tight prose-h1:text-3xl prose-h2:mt-12 prose-h2:border-t prose-h2:border-line prose-h2:pt-8 prose-a:no-underline hover:prose-a:underline">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </Markdown>
    </div>
  );
}
