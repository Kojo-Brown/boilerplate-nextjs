import type * as React from "react";
import { cn } from "@/lib/cn";

type SkeletonProps = React.HTMLAttributes<HTMLDivElement>;

export function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-[var(--muted)]", className)}
      {...props}
    />
  );
}

export function SkeletonText({ className, ...props }: SkeletonProps) {
  return <Skeleton className={cn("h-4 w-full", className)} {...props} />;
}

export function SkeletonHeading({ className, ...props }: SkeletonProps) {
  return <Skeleton className={cn("h-7 w-2/5", className)} {...props} />;
}

export function SkeletonCard({ className, ...props }: SkeletonProps) {
  return (
    <div
      className={cn(
        "rounded-xl border p-6",
        "bg-[var(--background)]",
        className,
      )}
      {...props}
    >
      <Skeleton className="mb-4 h-4 w-24" />
      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-4 w-28" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function SkeletonStatTile({ className, ...props }: SkeletonProps) {
  return (
    <div
      className={cn("rounded-xl border p-5", "bg-[var(--background)]", className)}
      {...props}
    >
      <Skeleton className="mb-2 h-3 w-16" />
      <Skeleton className="h-8 w-20" />
    </div>
  );
}

export function SkeletonListItem({ className, ...props }: SkeletonProps) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border p-4",
        "bg-[var(--background)]",
        className,
      )}
      {...props}
    >
      <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
      <div className="flex flex-1 flex-col gap-1.5">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}
