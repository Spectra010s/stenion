import { cn } from '../app/lib/cn';

/**
 * A shimmering placeholder block for loading states (CSS shimmer, see globals.css).
 *
 * Uses `surface-2`, not `surface`. A placeholder has to read as a distinct
 * block against the PAGE, and `surface-2` is the token that steps away from the
 * background in whichever direction the theme calls for — lighter on dark,
 * darker on light. On `surface` the light-mode block sat at 1.04 against the
 * page and effectively disappeared, which makes a loading page look like an
 * empty one.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'shimmer relative overflow-hidden rounded-md border border-line bg-surface-2',
        className,
      )}
    />
  );
}
