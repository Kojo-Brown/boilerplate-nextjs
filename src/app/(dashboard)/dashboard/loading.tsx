export default function DashboardLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="h-7 w-32 animate-pulse rounded-lg bg-muted" />
        <div className="h-4 w-56 animate-pulse rounded-lg bg-muted" />
      </div>
      <div className="rounded-xl border p-6" style={{ backgroundColor: "var(--background)" }}>
        <div className="mb-4 h-4 w-16 animate-pulse rounded bg-muted" />
        <div className="grid gap-3 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex flex-col gap-1">
              <div className="h-3 w-12 animate-pulse rounded bg-muted" />
              <div className="h-4 w-32 animate-pulse rounded bg-muted" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
