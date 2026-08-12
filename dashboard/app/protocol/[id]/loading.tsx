import { Skeleton } from '../../../components/skeleton';

export default function ProtocolLoading() {
  return (
    <div className="mx-auto max-w-4xl px-5 py-12">
      <Skeleton className="h-5 w-24" />

      <div className="mt-6 flex flex-col items-start gap-8 rounded-2xl border border-line p-8 sm:flex-row sm:items-center">
        <Skeleton className="h-44 w-44 rounded-full" />
        <div className="flex-1">
          <Skeleton className="h-10 w-56" />
          <Skeleton className="mt-3 h-4 w-40" />
          <Skeleton className="mt-5 h-7 w-32 rounded-full" />
        </div>
      </div>

      <div className="mt-14 grid gap-3 sm:grid-cols-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-32 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
