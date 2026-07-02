export default function LoginLoading() {
  return (
    <div
      className="w-full max-w-sm rounded-2xl p-8 shadow-sm"
      style={{ backgroundColor: "var(--background)" }}
    >
      <div className="mb-6 flex flex-col gap-2">
        <div className="h-7 w-36 animate-pulse rounded-lg bg-muted" />
        <div className="h-4 w-56 animate-pulse rounded-lg bg-muted" />
      </div>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <div className="h-4 w-12 animate-pulse rounded bg-muted" />
          <div className="h-9 w-full animate-pulse rounded-lg bg-muted" />
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="h-4 w-16 animate-pulse rounded bg-muted" />
          <div className="h-9 w-full animate-pulse rounded-lg bg-muted" />
        </div>
        <div className="mt-1 h-10 w-full animate-pulse rounded-lg bg-muted" />
      </div>
    </div>
  );
}
