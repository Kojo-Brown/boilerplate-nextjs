"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function BlogPostError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-col items-center gap-4 py-20 text-center">
      <h2 className="text-xl font-semibold">Failed to load post</h2>
      <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
        {error.message ?? "An unexpected error occurred."}
      </p>
      <div className="flex gap-3">
        <button
          onClick={reset}
          className="rounded-lg border px-4 py-2 text-sm font-medium transition-opacity hover:opacity-80"
          style={{ borderColor: "var(--border)" }}
        >
          Try again
        </button>
        <Link
          href="/blog"
          className="rounded-lg border px-4 py-2 text-sm font-medium transition-opacity hover:opacity-80"
          style={{ borderColor: "var(--border)" }}
        >
          Back to blog
        </Link>
      </div>
    </div>
  );
}
