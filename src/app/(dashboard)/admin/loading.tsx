export default function AdminLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <div
          className="h-8 w-32 animate-pulse rounded-md"
          style={{ backgroundColor: "var(--muted)" }}
        />
        <div
          className="mt-2 h-4 w-56 animate-pulse rounded-md"
          style={{ backgroundColor: "var(--muted)" }}
        />
      </div>
      <div
        className="rounded-xl border p-6"
        style={{ backgroundColor: "var(--background)" }}
      >
        <div
          className="mb-4 h-4 w-24 animate-pulse rounded-md"
          style={{ backgroundColor: "var(--muted)" }}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i}>
              <div
                className="h-3 w-12 animate-pulse rounded-md"
                style={{ backgroundColor: "var(--muted)" }}
              />
              <div
                className="mt-1.5 h-4 w-28 animate-pulse rounded-md"
                style={{ backgroundColor: "var(--muted)" }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
