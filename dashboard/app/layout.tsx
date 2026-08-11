import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Stenion — live risk intelligence for Stellar DeFi',
  description:
    'Continuous, on-chain-derived safety scores for Stellar/Soroban DeFi protocols.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site">
          <div className="wrap">
            <Link href="/" className="brand">
              Stenion
            </Link>
            <div className="tagline">
              Live risk intelligence for Stellar/Soroban DeFi — scored continuously
              from on-chain data.
            </div>
          </div>
        </header>
        <main className="wrap">{children}</main>
      </body>
    </html>
  );
}
