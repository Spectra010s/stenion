import { Skeleton } from '../components/skeleton';

export default function HomeLoading() {
  return (
    <div className="mx-auto max-w-6xl px-5 pb-20 pt-20 sm:pt-28">
      <Skeleton className="h-6 w-72 rounded-full" />
      <Skeleton className="mt-6 h-14 w-full max-w-3xl" />
      <Skeleton className="mt-3 h-14 w-2/3 max-w-2xl" />
      <Skeleton className="mt-6 h-24 w-full max-w-xl" />
      <div className="mt-9 flex gap-3">
        <Skeleton className="h-11 w-44 rounded-lg" />
        <Skeleton className="h-11 w-40 rounded-lg" />
      </div>

      <div className="mt-20 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-36 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
