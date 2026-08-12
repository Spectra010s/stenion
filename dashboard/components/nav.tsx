'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Github, Radar } from 'lucide-react';
import { cn } from '../app/lib/cn';
import { GITHUB_URL, NAV_LINKS } from '../app/lib/site';

export function Nav() {
  const pathname = usePathname();

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  return (
    <header className="sticky top-0 z-50 border-b border-line/70 bg-bg/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-5">
        <Link href="/" className="group flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-accent/25 to-accent-2/25 ring-1 ring-inset ring-white/10">
            <Radar className="h-4 w-4 text-accent" strokeWidth={2} />
          </span>
          <span className="font-display text-lg font-semibold tracking-tight text-ink">
            Stenion
          </span>
        </Link>

        <nav className="ml-auto flex items-center gap-1 text-sm">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={cn(
                'relative rounded-md px-3 py-2 transition-colors',
                isActive(link.href)
                  ? 'text-ink'
                  : 'text-muted hover:text-ink',
              )}
            >
              {link.label}
              {isActive(link.href) && (
                <span className="absolute inset-x-3 -bottom-px h-px bg-gradient-to-r from-accent to-accent-2" />
              )}
            </Link>
          ))}
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="Stenion on GitHub"
            className="ml-1 grid h-9 w-9 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <Github className="h-4 w-4" />
          </a>
        </nav>
      </div>
    </header>
  );
}
