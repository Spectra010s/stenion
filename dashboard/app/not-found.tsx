import Link from 'next/link';

export default function NotFound() {
  return (
    <>
      <h1>Not found</h1>
      <p className="subtle">That protocol isn&apos;t on the leaderboard.</p>
      <p className="back">
        <Link href="/">← Leaderboard</Link>
      </p>
    </>
  );
}
