"use client";

import Link from "next/link";

/**
 * The editor's own boundary.
 *
 * `notFound()` does not arrive here — Next routes it to the nearest
 * `not-found.tsx`, and the root one is what a post that is missing or not the
 * caller's gets. What lands here is the rest: the database being unreachable
 * while the section reads, a session that could not be resolved.
 */
export default function EditPostError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16">
      <h2 className="text-lg font-semibold">Something went wrong</h2>
      <p
        className="max-w-sm text-center text-sm"
        style={{ color: "var(--muted-foreground)" }}
      >
        {error.message || "Failed to load this post. Please try again."}
      </p>
      <div className="flex items-center gap-2">
        <button
          onClick={reset}
          className="rounded-lg border px-4 py-2 text-sm font-medium transition-colors hover:bg-[var(--muted)]"
        >
          Try again
        </button>
        <Link
          href="/posts"
          className="rounded-lg border px-4 py-2 text-sm font-medium transition-colors hover:bg-[var(--muted)]"
        >
          Back to posts
        </Link>
      </div>
    </div>
  );
}
