export default function BlogLoading() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <div
              className="h-9 w-48 animate-pulse rounded-lg"
              style={{ backgroundColor: "var(--muted)" }}
            />
            <div
              className="h-4 w-24 animate-pulse rounded"
              style={{ backgroundColor: "var(--muted)" }}
            />
          </div>
          <div
            className="h-6 w-40 animate-pulse rounded-full"
            style={{ backgroundColor: "var(--muted)" }}
          />
        </div>
        <div
          className="h-12 animate-pulse rounded-lg"
          style={{ backgroundColor: "var(--muted)" }}
        />
        <div
          className="h-9 w-48 animate-pulse rounded-lg"
          style={{ backgroundColor: "var(--muted)" }}
        />
      </div>
      <ul className="flex flex-col gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <li key={i}>
            <div
              className="flex flex-col gap-2 rounded-xl border p-5"
              style={{ borderColor: "var(--border)" }}
            >
              <div
                className="h-6 w-3/4 animate-pulse rounded"
                style={{ backgroundColor: "var(--muted)" }}
              />
              <div
                className="h-4 w-1/3 animate-pulse rounded"
                style={{ backgroundColor: "var(--muted)" }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
