export default function BlogPostLoading() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <div
          className="h-4 w-20 animate-pulse rounded"
          style={{ backgroundColor: "var(--muted)" }}
        />
        <div className="flex items-start justify-between gap-4">
          <div
            className="h-9 w-2/3 animate-pulse rounded-lg"
            style={{ backgroundColor: "var(--muted)" }}
          />
          <div
            className="h-6 w-44 animate-pulse rounded-full"
            style={{ backgroundColor: "var(--muted)" }}
          />
        </div>
        <div
          className="h-4 w-1/3 animate-pulse rounded"
          style={{ backgroundColor: "var(--muted)" }}
        />
      </div>
      <div
        className="h-12 animate-pulse rounded-lg"
        style={{ backgroundColor: "var(--muted)" }}
      />
      <div className="flex flex-col gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-4 animate-pulse rounded"
            style={{
              backgroundColor: "var(--muted)",
              width: `${80 + (i % 3) * 7}%`,
            }}
          />
        ))}
      </div>
    </div>
  );
}
