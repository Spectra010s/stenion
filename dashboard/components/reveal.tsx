'use client';

import { motion, type HTMLMotionProps } from 'framer-motion';
import { cn } from '../app/lib/cn';

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * When the reveal fires.
 *
 * `in-view` (the default) waits for the element to scroll into view and then
 * never runs again. That is right for page furniture, which arrives once.
 *
 * `mount` animates as soon as the element mounts, with no observer involved.
 * It exists for CONTENT THAT CHANGES FROM AN INTERACTION, and the distinction
 * is a correctness one rather than a stylistic one — see the note on
 * RevealGroup. If a list's children can change without a full page load, it
 * must use `mount`.
 */
export type RevealTrigger = 'in-view' | 'mount';

/**
 * Scroll/mount reveal — a subtle fade + rise, once. Used to give pages a
 * deliberate load rhythm instead of everything snapping in at once.
 */
export function Reveal({
  children,
  delay = 0,
  y = 14,
  trigger = 'in-view',
  className,
  ...rest
}: {
  children: React.ReactNode;
  delay?: number;
  y?: number;
  trigger?: RevealTrigger;
  className?: string;
} & HTMLMotionProps<'div'>) {
  const shown = { opacity: 1, y: 0 };
  return (
    <motion.div
      className={cn(className)}
      initial={{ opacity: 0, y }}
      {...(trigger === 'mount'
        ? { animate: shown }
        : { whileInView: shown, viewport: { once: true, margin: '-60px' } })}
      transition={{ duration: 0.55, delay, ease: EASE }}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

/**
 * Stagger container — children using `RevealItem` animate in sequence.
 *
 * WHY `trigger` EXISTS, AND WHEN GETTING IT WRONG BREAKS THE PAGE. Under
 * `in-view` this container is driven by `whileInView` with `viewport.once`,
 * which fires a single time and then STOPS OBSERVING. Any `RevealItem` that
 * mounts after that moment inherits the container's `initial="hidden"` and has
 * nothing left to move it to `show` — so it sits in the DOM at `opacity: 0`,
 * fully rendered and completely invisible.
 *
 * That is harmless for a list built once per page load, and it is a bug the
 * moment the list is filtered, sorted or searched: the server returns the right
 * rows, the URL is right, and the reader sees a blank space that only a full
 * refresh fixes. The registry hit exactly that when its rows became
 * interaction-driven.
 *
 * So: **a list whose children can change without a navigation must pass
 * `trigger="mount"`.** Then the container's variant is `animate`, not a `while`
 * prop, and a child mounting at any later time animates to it on arrival —
 * which also gives new rows a proper entrance instead of a pop.
 */
export function RevealGroup({
  children,
  className,
  stagger = 0.08,
  trigger = 'in-view',
}: {
  children: React.ReactNode;
  className?: string;
  stagger?: number;
  trigger?: RevealTrigger;
}) {
  return (
    <motion.div
      className={cn(className)}
      initial="hidden"
      {...(trigger === 'mount'
        ? { animate: 'show' }
        : { whileInView: 'show', viewport: { once: true, margin: '-60px' } })}
      variants={{ show: { transition: { staggerChildren: stagger } } }}
    >
      {children}
    </motion.div>
  );
}

export function RevealItem({
  children,
  className,
  y = 16,
}: {
  children: React.ReactNode;
  className?: string;
  y?: number;
}) {
  return (
    <motion.div
      className={cn(className)}
      variants={{
        hidden: { opacity: 0, y },
        show: { opacity: 1, y: 0, transition: { duration: 0.55, ease: EASE } },
      }}
    >
      {children}
    </motion.div>
  );
}
