"use client";

export default function ActivityError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div
      className="rounded-xl border p-6"
      style={{ backgroundColor: "var(--background)" }}
    >
      <p className="text-sm font-medium" style={{ color: "var(--destructive)" }}>
        Failed to load recent activity
      </p>
      <p className="mt-1 text-xs" style={{ color: "var(--muted-foreground)" }}>
        {error.message}
      </p>
      <button
        onClick={reset}
        className="mt-3 text-xs font-medium hover:underline"
        style={{ color: "var(--primary)" }}
      >
        Retry
      </button>
    </div>
  );
}
