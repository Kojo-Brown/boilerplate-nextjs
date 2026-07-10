import { Skeleton } from "@/components/ui/skeleton";

export function RecentPostsSkeleton() {
  return (
    <div
      className="rounded-xl border p-6"
      style={{ backgroundColor: "var(--background)" }}
    >
      <div className="mb-4 flex items-center justify-between">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-3 w-12" />
      </div>
      <div className="flex flex-col gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center justify-between rounded-lg border px-3 py-2.5"
          >
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-10 rounded-full" />
              <Skeleton className="h-3.5 w-40" />
            </div>
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
