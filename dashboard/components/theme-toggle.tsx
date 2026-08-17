'use client';

import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { cn } from '../app/lib/cn';

/**
 * Theme control: one icon button that opens a three-option menu.
 *
 * The BUTTON's icon shows the theme currently in effect (sun/moon). The MENU
 * shows which of the three options is actually selected, with a tick. Those are
 * deliberately different pieces of information: with "System" selected the
 * button can show a moon while the tick sits on System, which is exactly the
 * distinction that a resolved-state-only control loses.
 *
 * The DOM contract is shared with the pre-paint script in app/layout.tsx:
 * an explicit choice sets `data-theme` on <html>; system REMOVES it and lets
 * the `prefers-color-scheme` block in globals.css apply. Keep the two in sync.
 */
type ThemeChoice = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'stenion-theme';

const OPTIONS = [
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
] as const satisfies ReadonlyArray<{ value: ThemeChoice; label: string; Icon: typeof Monitor }>;

function applyChoice(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

export function ThemeToggle({ className }: { className?: string }) {
  // Starts at 'system' on the server and on the first client render, then
  // corrects from storage on mount. Only this control's own state can settle a
  // beat late — the PAGE theme is already right, resolved before first paint.
  const [choice, setChoice] = useState<ThemeChoice>('system');
  const [systemIsDark, setSystemIsDark] = useState(false);
  const [open, setOpen] = useState(false);

  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'light' || stored === 'dark') {
        setChoice(stored);
        // Re-assert, don't just read. On a route that calls notFound() Next
        // discards the document shell and streams a replacement, and the
        // pre-paint script arrives in the RSC payload where React inserts it
        // via innerHTML — which never executes. This puts the attribute back.
        applyChoice(stored);
      }
    } catch {
      /* storage can throw in private modes; system default is a fine fallback */
    }

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    setSystemIsDark(mq.matches);
    // Only drives the button's icon and the System label. The actual swap in
    // system mode is pure CSS, so nothing here re-applies anything.
    const onChange = (e: MediaQueryListEvent) => setSystemIsDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Close on outside click (pointerdown, so it fires before focus moves) and on
  // Escape, returning focus to the trigger the way the mobile nav does.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Move focus onto the selected option when the menu opens, so a keyboard user
  // lands on the current value rather than the top of the list.
  useEffect(() => {
    if (!open) return;
    const i = OPTIONS.findIndex((o) => o.value === choice);
    itemRefs.current[Math.max(0, i)]?.focus();
  }, [open, choice]);

  const select = useCallback((next: ThemeChoice) => {
    setChoice(next);
    applyChoice(next);
    setOpen(false);
    triggerRef.current?.focus();
    try {
      if (next === 'system') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* the theme still applies for this session even if it can't persist */
    }
  }, []);

  const onItemKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      const next = (index + delta + OPTIONS.length) % OPTIONS.length;
      itemRefs.current[next]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      itemRefs.current[e.key === 'Home' ? 0 : OPTIONS.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  const resolvedDark = choice === 'dark' || (choice === 'system' && systemIsDark);
  const ResolvedIcon = resolvedDark ? Moon : Sun;
  const activeLabel = OPTIONS.find((o) => o.value === choice)?.label ?? 'System';

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        // Names the SELECTION, not just the resolved look, so a screen reader
        // hears "System" rather than "Dark" when System is what's chosen.
        aria-label={`Theme: ${activeLabel}. Change theme`}
        title={`Theme: ${activeLabel}`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="grid h-9 w-9 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <ResolvedIcon className="h-4 w-4" strokeWidth={2} />
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Colour theme"
          className="absolute right-0 z-50 mt-1.5 min-w-40 overflow-hidden rounded-lg border border-line bg-surface p-1 shadow-lg"
        >
          {OPTIONS.map(({ value, label, Icon }, i) => {
            const selected = choice === value;
            return (
              <button
                key={value}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => select(value)}
                onKeyDown={(e) => onItemKeyDown(e, i)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
                  selected ? 'text-ink' : 'text-muted hover:bg-surface-2 hover:text-ink',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" strokeWidth={2} />
                <span className="flex-1">{label}</span>
                {value === 'system' && (
                  <span className="text-xs text-faint">{systemIsDark ? 'Dark' : 'Light'}</span>
                )}
                <Check
                  className={cn('h-3.5 w-3.5 shrink-0 text-accent', !selected && 'invisible')}
                  strokeWidth={2.5}
                />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
