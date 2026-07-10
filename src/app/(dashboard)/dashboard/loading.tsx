import {
  Skeleton,
  SkeletonCard,
  SkeletonStatTile,
} from "@/components/ui/skeleton";

export default function DashboardLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-56" />
      </div>

      <SkeletonCard />

      <div className="grid gap-4 sm:grid-cols-3">
        <SkeletonStatTile />
        <SkeletonStatTile />
        <SkeletonStatTile />
      </div>

      <div className="rounded-xl border p-6" style={{ backgroundColor: "var(--background)" }}>
        <Skeleton className="mb-4 h-4 w-28" />
        <div className="flex flex-col gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 rounded-lg border p-3">
              <Skeleton className="h-6 w-6 rounded-full" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
