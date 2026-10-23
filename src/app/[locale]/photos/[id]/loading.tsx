import { Skeleton } from "@/components/ui/skeleton";

export default function PhotoLoading() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-9 w-2/3 rounded-lg" />
      <Skeleton className="aspect-[3/2] w-full rounded-xl" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-8 w-28 rounded-md" />
    </div>
  );
}
