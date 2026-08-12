'use client';

import { motion, type HTMLMotionProps } from 'framer-motion';
import { cn } from '../app/lib/cn';

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * Scroll/mount reveal — a subtle fade + rise, once. Used to give pages a
 * deliberate load rhythm instead of everything snapping in at once.
 */
export function Reveal({
  children,
  delay = 0,
  y = 14,
  className,
  ...rest
}: {
  children: React.ReactNode;
  delay?: number;
  y?: number;
  className?: string;
} & HTMLMotionProps<'div'>) {
  return (
    <motion.div
      className={cn(className)}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.55, delay, ease: EASE }}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

/** Stagger container — children using `RevealItem` animate in sequence. */
export function RevealGroup({
  children,
  className,
  stagger = 0.08,
}: {
  children: React.ReactNode;
  className?: string;
  stagger?: number;
}) {
  return (
    <motion.div
      className={cn(className)}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: '-60px' }}
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
