import { cn } from "@/lib/cn";

/**
 * Marks one piece of content as unpublished.
 *
 * The banner says "this session is a preview"; this says "*this* is the part
 * that is not live". Both are needed — a preview of a blog index shows
 * published and unpublished posts side by side, and an author checking that
 * their draft reads well has no other way to tell which is which.
 *
 * Pure markup with no access check of its own. It renders wherever an
 * unpublished post has already been handed to a component, and the decision
 * about who may hold one lives in `@/lib/cache/blog`, not here.
 */
export function DraftBadge({ className }: { className?: string } = {}) {
  return (
    <span
      data-testid="draft-badge"
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        className,
      )}
      style={{
        borderColor: "oklch(70% 0.15 75)",
        color: "oklch(45% 0.13 65)",
      }}
    >
      Draft
    </span>
  );
}
