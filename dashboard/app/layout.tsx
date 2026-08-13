import type { Metadata } from 'next';
import { Analytics } from '@vercel/analytics/next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { Space_Grotesk } from 'next/font/google';
import { Nav } from '../components/nav';
import { Footer } from '../components/footer';
import './globals.css';

// Self-hosted Geist (no network fetch) for UI + tabular numbers; Space Grotesk
// (display) only for large headings, to give the site a real type pairing
// instead of a single-font, system-ui look.
const display = Space_Grotesk({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-display',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'Stenion — live risk intelligence for Stellar DeFi',
    template: '%s · Stenion',
  },
  description:
    'Continuous, on-chain-derived safety scores for Stellar/Soroban DeFi protocols. Audits are a snapshot; Stenion tracks risk as it moves.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} ${display.variable}`}>
      <body className="min-h-screen bg-bg text-ink antialiased">
        <Nav />
        <main>{children}</main>
        <Footer />
        {/* Vercel Analytics — client component that injects the pageview script.
            Renders no markup, so it sits last and can't affect layout. Pageviews
            only: no props, no custom events, and nothing protocol- or score-related
            is ever passed to it. */}
        <Analytics />
      </body>
    </html>
  );
}
