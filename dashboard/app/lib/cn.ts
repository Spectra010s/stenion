import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge conditional class lists and dedupe conflicting Tailwind utilities.
 * The standard shadcn-style helper — we use its component pattern (styled
 * primitives + `cn`) without pulling in the CLI/Radix, since this site needs no
 * overlay primitives.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
