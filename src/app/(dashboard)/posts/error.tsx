"use client";

export default function PostsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16">
      <h2 className="text-lg font-semibold">Something went wrong</h2>
      <p className="max-w-sm text-center text-sm" style={{ color: "var(--muted-foreground)" }}>
        {error.message || "Failed to load posts. Please try again."}
      </p>
      <button
        onClick={reset}
        className="rounded-lg border px-4 py-2 text-sm font-medium transition-colors hover:bg-[var(--muted)]"
      >
        Try again
      </button>
    </div>
  );
}
