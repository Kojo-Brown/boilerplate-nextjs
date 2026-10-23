import { Skeleton } from "@/components/ui/skeleton";

/**
 * The streaming frame for both pricing routes.
 *
 * Shaped like the page it stands in for — heading, lead paragraph, three cards
 * of the same proportions — so the layout does not move when the real markup
 * arrives. Shared between the two segments because they render the same frame;
 * see `app/pricing/v/[variant]/loading.tsx`.
 */
export function PricingSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-9 w-40 rounded-lg" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <ul className="grid gap-6 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <li key={index} className="flex flex-col gap-4 rounded-xl border p-6">
            <Skeleton className="h-6 w-24" />
            <Skeleton className="h-9 w-32" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-10 w-full rounded-lg" />
          </li>
        ))}
      </ul>
      <Skeleton className="h-16 rounded-lg" />
    </div>
  );
}
