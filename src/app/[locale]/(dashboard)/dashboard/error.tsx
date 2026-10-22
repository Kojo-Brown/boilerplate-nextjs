"use client";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Something went wrong</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--muted-foreground)" }}>
          {error.message ?? "An unexpected error occurred on the dashboard."}
        </p>
      </div>
      <button
        onClick={reset}
        className="w-fit rounded-lg px-4 py-2 text-sm font-medium"
        style={{
          backgroundColor: "var(--primary)",
          color: "var(--primary-foreground)",
        }}
      >
        Try again
      </button>
    </div>
  );
}
