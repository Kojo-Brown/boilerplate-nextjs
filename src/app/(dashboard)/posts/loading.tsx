export default function PostsLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="h-8 w-24 animate-pulse rounded-lg" style={{ backgroundColor: "var(--muted)" }} />
        <div className="h-4 w-48 animate-pulse rounded-lg" style={{ backgroundColor: "var(--muted)" }} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-28 animate-pulse rounded-xl border"
            style={{ backgroundColor: "var(--muted)" }}
          />
        ))}
      </div>
    </div>
  );
}
