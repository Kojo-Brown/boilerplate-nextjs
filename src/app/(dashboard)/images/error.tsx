"use client";

export default function ImagesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <p className="text-sm font-medium text-red-600">
        Failed to load images page: {error.message}
      </p>
      <button
        onClick={reset}
        className="rounded-md border px-4 py-2 text-sm transition-colors hover:bg-[var(--muted)]"
      >
        Try again
      </button>
    </div>
  );
}
