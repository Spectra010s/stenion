import { cn } from '../app/lib/cn';

/** A shimmering placeholder block for loading states (CSS shimmer, see globals.css). */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'shimmer relative overflow-hidden rounded-md border border-line-soft bg-surface',
        className,
      )}
    />
  );
}
