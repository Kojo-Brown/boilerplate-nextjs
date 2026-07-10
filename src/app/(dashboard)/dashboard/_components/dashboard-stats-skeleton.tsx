import { SkeletonStatTile } from "@/components/ui/skeleton";

export function DashboardStatsSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <SkeletonStatTile />
      <SkeletonStatTile />
      <SkeletonStatTile />
    </div>
  );
}
