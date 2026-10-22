import { Skeleton } from "@/components/ui/skeleton";

export default function SecuritySettingsLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Skeleton className="h-80 max-w-xl rounded-xl border" />
    </div>
  );
}
