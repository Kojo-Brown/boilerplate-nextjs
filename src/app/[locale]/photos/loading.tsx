import { Skeleton } from "@/components/ui/skeleton";

export default function PhotosLoading() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-9 w-40 rounded-lg" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-24 rounded-lg" />
      </div>
      <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <li key={i} className="flex flex-col gap-2">
            <Skeleton className="aspect-[3/2] w-full rounded-xl" />
            <Skeleton className="h-5 w-2/3" />
          </li>
        ))}
      </ul>
    </div>
  );
}
