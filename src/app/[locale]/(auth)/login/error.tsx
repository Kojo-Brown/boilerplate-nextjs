"use client";

export default function LoginError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div
      className="w-full max-w-sm rounded-2xl p-8 shadow-sm"
      style={{ backgroundColor: "var(--background)" }}
    >
      <h2 className="mb-2 text-lg font-semibold">Something went wrong</h2>
      <p
        className="mb-4 text-sm"
        style={{ color: "var(--muted-foreground)" }}
      >
        {error.message ?? "An unexpected error occurred."}
      </p>
      <button
        onClick={reset}
        className="rounded-lg px-4 py-2 text-sm font-medium"
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
