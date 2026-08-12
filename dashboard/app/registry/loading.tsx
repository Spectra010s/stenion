import { Skeleton } from '../../components/skeleton';

export default function RegistryLoading() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-14">
      <Skeleton className="h-6 w-64 rounded-full" />
      <Skeleton className="mt-5 h-11 w-80" />
      <Skeleton className="mt-3 h-16 w-full max-w-2xl" />

      <div className="mt-10 space-y-px">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="grid grid-cols-1 gap-4 py-5 md:grid-cols-[3rem_1fr_8rem_10rem_9rem] md:items-center"
          >
            <Skeleton className="hidden h-4 w-6 md:block" />
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-6 w-24 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
